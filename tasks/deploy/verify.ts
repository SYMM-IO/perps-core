import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import fs from "fs"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import path from "path"

import { getSelectors } from "../utils/diamondCut.js"
import { getDataDir, setDataScope, writeData } from "../utils/fs.js"
import {
	ACCOUNTLAYER_DEPLOYMENT_FILE,
	CREATE2FACTORY_DEPLOYMENT_FILE,
	EXPRESSPROVIDER_DEPLOYMENT_FILE,
	FacetNames,
	DEPLOYMENT_LOG_FILE,
	INSTANTLAYER_DEPLOYMENT_FILE,
	LIQUIDATOR_DEPLOYMENT_FILE,
	PARTYB_DEPLOYMENT_FILE,
	STABLECOIN_DEPLOYMENT_FILE,
	SYMBOLMANAGER_DEPLOYMENT_FILE,
	VERIFY_FAILED_FILE,
} from "./constants.js"
import { verificationProviderForChain } from "./explorer.js"
import { getConnection } from "./helpers.js"
import {
	assertConfiguredMuonPermissionsAuthorized,
	assertGeneralDeploymentMuonPermissions,
	inspectConfiguredMuonPermissions,
} from "./muonPermissions.js"
import { ProtocolConfig, loadProtocolConfig, templateConfigMismatches } from "./protocolConfig.js"
import { activeDeploymentRecipe } from "./recipeRuntime.js"

// ============================================================================
// Verify All Contracts from Deployment Logs
// ============================================================================

interface ContractToVerify {
	name: string
	address: string
	constructorArguments: any[]
}

function parseVerificationRecords(parsed: unknown, label: string, ethers: any): ContractToVerify[] {
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${label} must contain a non-empty JSON array`)
	return parsed.map((entry: any, index) => {
		if (!entry || typeof entry !== "object") throw new Error(`${label}[${index}] must be an object`)
		if (typeof entry.name !== "string" || entry.name.trim() === "") throw new Error(`${label}[${index}].name must be a non-empty string`)
		if (typeof entry.address !== "string" || !ethers.isAddress(entry.address) || entry.address === ethers.ZeroAddress) {
			throw new Error(`${label}[${index}].address is missing, invalid, or zero: ${JSON.stringify(entry.address)}`)
		}
		if (entry.constructorArguments !== undefined && !Array.isArray(entry.constructorArguments)) {
			throw new Error(`${label}[${index}].constructorArguments must be an array`)
		}
		return {
			name: entry.name,
			address: ethers.getAddress(entry.address),
			constructorArguments: entry.constructorArguments || [],
		}
	})
}

function readJsonFile(filePath: string, label: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch (err) {
		throw new Error(`Failed to parse ${label} at ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
	}
}

function readVerificationRecords(filePath: string, label: string, ethers: any): ContractToVerify[] {
	return parseVerificationRecords(readJsonFile(filePath, label), label, ethers)
}

type VerificationRunBinding = { deploymentId?: string; recipeDigest?: string }

export function assertVerificationRunBinding(
	report: any,
	actual: { network: string; chainId: number },
	expected: VerificationRunBinding,
	active = activeDeploymentRecipe,
): { deploymentId?: string; recipeDigest?: string } {
	const bindingRequested = Boolean(expected.deploymentId || expected.recipeDigest || active)
	if (!bindingRequested) return {}
	if (!report || typeof report !== "object" || Array.isArray(report)) {
		throw new Error("Recipe-bound verification requires the chain-scoped deployment-report.json")
	}
	if (report.network !== actual.network || report.chainId !== actual.chainId) {
		throw new Error(
			`Deployment report target mismatch: expected ${actual.network}/${actual.chainId}, got ${JSON.stringify(report.network)}/${JSON.stringify(report.chainId)}`,
		)
	}
	if (typeof report.deploymentId !== "string" || report.deploymentId.trim() === "") {
		throw new Error("Deployment report is missing deploymentId")
	}
	if (expected.deploymentId && report.deploymentId !== expected.deploymentId) {
		throw new Error(`Deployment verification binding mismatch: expected deploymentId ${expected.deploymentId}, report has ${report.deploymentId}`)
	}
	if (expected.recipeDigest && report.recipe?.digest !== expected.recipeDigest) {
		throw new Error("Deployment verification binding mismatch: report recipe digest differs from --recipe-digest")
	}
	if (active) {
		if (active.recipe.core.mode !== "deploy") {
			throw new Error("verify:all cannot consume a component recipe; component verification is owned by deploy:component")
		}
		if (
			report.recipe?.name !== active.recipe.name ||
			report.recipe?.digest !== active.digest ||
			typeof report.recipe?.path !== "string" ||
			report.recipe.path.trim() === ""
		) {
			throw new Error("Chain-scoped deployment report is not bound to the active JSON recipe")
		}
		for (const component of ["core", "partyB", "symbolManager", "expressProvider"] as const) {
			if (report.recipe?.components?.[component] !== active.recipe[component].mode) {
				throw new Error(`Deployment report component mode ${component} is not bound to the active JSON recipe`)
			}
		}
	}
	if (report.checks?.health !== "passed") {
		throw new Error(`Deployment health must pass before explorer verification; got ${JSON.stringify(report.checks?.health)}`)
	}
	return { deploymentId: report.deploymentId, recipeDigest: report.recipe?.digest }
}

function readFailedVerificationRecords(filePath: string, ethers: any, binding: { deploymentId?: string; recipeDigest?: string }): ContractToVerify[] {
	const parsed: any = readJsonFile(filePath, VERIFY_FAILED_FILE)
	if (Array.isArray(parsed)) {
		if (binding.deploymentId || binding.recipeDigest) {
			throw new Error(
				`${VERIFY_FAILED_FILE} is an unbound legacy retry list; rerun the recipe deployment to regenerate failures for the selected deployment`,
			)
		}
		return parseVerificationRecords(parsed, VERIFY_FAILED_FILE, ethers)
	}
	if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
		throw new Error(`${VERIFY_FAILED_FILE} must be a versioned deployment-bound retry artifact`)
	}
	if (binding.deploymentId && parsed.deploymentId !== binding.deploymentId) {
		throw new Error(`${VERIFY_FAILED_FILE} belongs to deployment ${JSON.stringify(parsed.deploymentId)}, expected ${binding.deploymentId}`)
	}
	if (binding.recipeDigest && parsed.recipeDigest !== binding.recipeDigest) {
		throw new Error(`${VERIFY_FAILED_FILE} belongs to another recipe digest`)
	}
	return parseVerificationRecords(parsed.records, `${VERIFY_FAILED_FILE}.records`, ethers)
}

export function assertVerificationRecordsCoverReport(contracts: ContractToVerify[], report: any): void {
	if (!report) return
	const recorded = new Set(contracts.map(contract => contract.address.toLowerCase()))
	const required: Array<[string, unknown]> = [
		["Core Diamond", report.addresses?.diamond],
		["AccountLayer Diamond", report.addresses?.accountLayerDiamond],
		["InstantLayer", report.addresses?.instantLayer],
	]
	if ((report.config?.partyBMode || (report.config?.deployPartyB ? "deploy" : "skip")) === "deploy") {
		required.push(["PartyB", report.addresses?.symmioPartyB])
	}
	if ((report.config?.symbolManagerMode || (report.config?.deploySymbolManager ? "deploy" : "skip")) === "deploy") {
		required.push(["SymbolManager", report.addresses?.symbolManager])
	}
	if (report.config?.collateralAddress === "") required.push(["deployed collateral", report.addresses?.collateral])
	for (const [label, address] of required) {
		if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
			throw new Error(`Deployment report is missing a valid ${label} address`)
		}
		if (!recorded.has(address.toLowerCase())) {
			throw new Error(`${label} ${address} is absent from the scoped verification records; refusing records from another deployment`)
		}
	}
}

export const verifyAllTask = task("verify:all", "Verifies all deployed contracts from deployment logs on block explorer")
	.addOption({
		name: "skip",
		description: "Number of contracts to skip (for resuming)",
		type: ArgumentType.INT,
		defaultValue: 0,
	})
	.addFlag({
		name: "retryFailed",
		description: `Only retry contracts that failed in a previous run (loaded from tasks/data/${VERIFY_FAILED_FILE})`,
	})
	.addOption({
		name: "deploymentId",
		description: "Expected deployment id from the selected JSON recipe report",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "recipeDigest",
		description: "Expected deployment recipe digest",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async (args: { skip: number; retryFailed: boolean; deploymentId?: string; recipeDigest?: string }, hre: any) => {
			const connection = await getConnection(hre)
			const { ethers } = connection
			const chainId = Number((await ethers.provider.getNetwork()).chainId)
			const isSimulatedNetwork = (connection as any).networkConfig?.type === "edr-simulated"
			setDataScope(chainId, { simulated: isSimulatedNetwork })
			const network = connection.networkName || "unknown"
			const verificationProvider = verificationProviderForChain(chainId)
			if (isSimulatedNetwork) {
				throw new Error(`verify:all cannot publish explorer verification for simulated/fork network ${network} (chainId ${chainId})`)
			}

			console.log("")
			console.log("=".repeat(80))
			console.log("CONTRACT VERIFICATION ON BLOCK EXPLORER")
			console.log("=".repeat(80))
			console.log(`Network: ${network}`)
			console.log(`Chain ID: ${chainId}`)
			console.log(`Provider: ${verificationProvider}`)
			console.log("")

			let contracts: ContractToVerify[] = []
			const failedFilePath = `${getDataDir()}/${VERIFY_FAILED_FILE}`
			const reportPath = `${getDataDir()}/deployment-report.json`
			const report: any = fs.existsSync(reportPath) ? readJsonFile(reportPath, "scoped deployment report") : undefined
			const runBinding = assertVerificationRunBinding(
				report,
				{ network, chainId },
				{ deploymentId: args.deploymentId, recipeDigest: args.recipeDigest },
			)

			if (args.retryFailed) {
				if (!fs.existsSync(failedFilePath)) {
					throw new Error(`No previous verification failures found at ${failedFilePath}`)
				}
				contracts = readFailedVerificationRecords(failedFilePath, ethers, runBinding)
				console.log(`Loaded ${contracts.length} previously-failed contracts from ${VERIFY_FAILED_FILE}`)
			} else {
				const deploysStablecoin = report ? report.config?.collateralAddress === "" : true
				const deploysPartyB = report ? (report.config?.partyBMode || (report.config?.deployPartyB ? "deploy" : "skip")) === "deploy" : true
				const deploysSymbolManager = report
					? (report.config?.symbolManagerMode || (report.config?.deploySymbolManager ? "deploy" : "skip")) === "deploy"
					: true
				// Unlike the others this has no legacy env fallback: it only ever ships via a recipe.
				const deploysExpressProvider = report ? report.config?.expressProviderMode === "deploy" : false
				const logFiles: Array<{ file: string; name: string; required: boolean; include: boolean }> = [
					{ file: DEPLOYMENT_LOG_FILE, name: "Core Diamond deployment records", required: true, include: true },
					{ file: ACCOUNTLAYER_DEPLOYMENT_FILE, name: "AccountLayer deployment records", required: true, include: true },
					{ file: INSTANTLAYER_DEPLOYMENT_FILE, name: "InstantLayer deployment records", required: true, include: true },
					{
						// A run that reused a factory names it in the report but writes no record;
						// whoever deployed it verified it, so this is never required.
						file: CREATE2FACTORY_DEPLOYMENT_FILE,
						name: "Create2Factory deployment records",
						required: false,
						include: Boolean(report?.addresses?.create2Factory),
					},
					{
						file: STABLECOIN_DEPLOYMENT_FILE,
						name: "Stablecoin deployment records",
						required: Boolean(report && deploysStablecoin),
						include: deploysStablecoin,
					},
					{
						file: PARTYB_DEPLOYMENT_FILE,
						name: "PartyB deployment records",
						required: Boolean(report && deploysPartyB),
						include: deploysPartyB,
					},
					{
						file: SYMBOLMANAGER_DEPLOYMENT_FILE,
						name: "SymbolManager deployment records",
						required: Boolean(report && deploysSymbolManager),
						include: deploysSymbolManager,
					},
					{
						file: EXPRESSPROVIDER_DEPLOYMENT_FILE,
						name: "ExpressProvider deployment records",
						required: Boolean(report && deploysExpressProvider),
						include: deploysExpressProvider,
					},
					{
						file: LIQUIDATOR_DEPLOYMENT_FILE,
						name: "SymmioLiquidator deployment records",
						required: false,
						include: !report,
					},
				]

				for (const { file, name, required, include } of logFiles) {
					if (!include) continue
					const filePath = `${getDataDir()}/${file}`
					if (!fs.existsSync(filePath)) {
						if (required) throw new Error(`Missing required ${name} at ${filePath}`)
						continue
					}
					const loaded = readVerificationRecords(filePath, name, ethers)
					contracts.push(...loaded)
					console.log(`Loaded ${loaded.length} contracts from ${name}`)
				}
				assertVerificationRecordsCoverReport(contracts, report)
			}

			// Missing deployment logs are only reported as "<file> not found, skipping", so a
			// run that loaded nothing at all used to print an all-green summary and exit 0.
			// Verifying zero contracts is never a success.
			if (contracts.length === 0) {
				throw new Error(
					`No contracts to verify on ${network} (chainId ${chainId}). ` +
						`Expected deployment logs under ${getDataDir()}. ` +
						`so the records may exist only on the machine that ran the deployment.`,
				)
			}

			console.log(`Found ${contracts.length} contracts to verify`)
			if (args.skip > 0) {
				console.log(`Skipping first ${args.skip} contracts`)
				contracts = contracts.slice(args.skip)
			}
			if (contracts.length === 0) throw new Error(`--skip=${args.skip} leaves no contracts to verify`)
			console.log("")

			let verified = 0
			let failed = 0
			let alreadyVerified = 0
			const failedContracts: Array<ContractToVerify & { error: string }> = []

			// Patterns that indicate a flaky Etherscan/network failure (worth retrying)
			// rather than a real verification problem.
			const isTransient = (msg: string) =>
				msg.includes("HHE80024") ||
				msg.includes("HHE80001") ||
				msg.includes("other side closed") ||
				msg.includes("Other Exception") ||
				msg.includes("ETIMEDOUT") ||
				msg.includes("ECONNRESET") ||
				msg.includes("socket hang up")

			const MAX_ATTEMPTS = 3
			const RETRY_DELAY_MS = 8000

			for (let i = 0; i < contracts.length; i++) {
				const contract = contracts[i]
				const idx = args.skip + i + 1
				console.log(`[${idx}/${args.skip + contracts.length}] Verifying ${contract.name} at ${contract.address}...`)

				let lastErr: any
				let outcome: "ok" | "already" | "fail" = "fail"
				for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
					try {
						await verifyContract(
							{
								address: contract.address,
								constructorArgs: contract.constructorArguments,
								contract: contract.name.includes(":") ? contract.name : undefined,
								provider: verificationProvider,
							},
							hre,
						)
						outcome = "ok"
						break
					} catch (err: any) {
						lastErr = err
						const msg = err.message ?? String(err)
						if (msg.includes("Already Verified") || msg.includes("already verified")) {
							outcome = "already"
							break
						}
						if (attempt < MAX_ATTEMPTS && isTransient(msg)) {
							console.log(`   [retry ${attempt}/${MAX_ATTEMPTS - 1}] transient error, waiting ${RETRY_DELAY_MS / 1000}s...`)
							await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
							continue
						}
						break
					}
				}

				if (outcome === "ok") {
					verified++
					console.log(`   [OK] Verified`)
				} else if (outcome === "already") {
					alreadyVerified++
					console.log(`   [SKIP] Already verified`)
				} else {
					failed++
					const errMsg = lastErr?.message?.slice(0, 200) || String(lastErr)
					console.log(`   [FAIL] ${errMsg.slice(0, 100)}`)
					failedContracts.push({ ...contract, error: errMsg })
				}
				console.log("")
			}

			console.log("=".repeat(80))
			console.log("VERIFICATION SUMMARY")
			console.log("=".repeat(80))
			console.log(`Total contracts: ${contracts.length}`)
			console.log(`  Verified:         ${verified}`)
			console.log(`  Already verified: ${alreadyVerified}`)
			console.log(`  Failed:           ${failed}`)
			console.log("=".repeat(80))

			if (failed > 0) {
				console.log("")
				console.log("FAILED CONTRACTS:")
				console.log("-".repeat(80))
				for (let i = 0; i < failedContracts.length; i++) {
					const f = failedContracts[i]
					console.log(`  ${i + 1}. ${f.name}`)
					console.log(`     address: ${f.address}`)
					console.log(`     error:   ${f.error.slice(0, 140)}`)
				}
				console.log("-".repeat(80))

				// Persist a deployment-bound failed list so another run on the same chain
				// cannot accidentally consume these records.
				try {
					writeData(VERIFY_FAILED_FILE, {
						schemaVersion: 1,
						deploymentId: runBinding.deploymentId,
						recipeDigest: runBinding.recipeDigest,
						records: failedContracts.map(({ error, ...contract }) => contract),
					})
					console.log("")
					console.log(`Wrote failed contracts to ${failedFilePath}`)
					console.log(`To retry only failed contracts, run:`)
					console.log(
						activeDeploymentRecipe
							? `  ./symmio verify --config ${activeDeploymentRecipe.identityPath} --retry-failed`
							: `  ./node_modules/.bin/hardhat verify:all --retry-failed --network ${network}`,
					)
				} catch (e) {
					console.log(`Could not write ${failedFilePath}: ${e}`)
				}
			} else if (args.retryFailed) {
				// Successful retry — clean up the failed file
				try {
					if (fs.existsSync(failedFilePath)) {
						fs.unlinkSync(failedFilePath)
						console.log(`\nAll retries succeeded. Removed ${failedFilePath}.`)
					}
				} catch {
					// non-fatal
				}
			}

			// Exit non-zero on failure. This task previously always exited 0, so CI (and
			// operators reading only the exit status) could not tell a fully-verified
			// deployment from one where every contract failed.
			if (failed > 0) {
				throw new Error(`Block-explorer verification failed for ${failed} of ${contracts.length} contract(s) — see the list above.`)
			}
		},
	}))
	.build()

// ============================================================================
// Deployment Health Check Task
// ============================================================================

interface VerificationResult {
	category: string
	check: string
	status: "pass" | "fail" | "warn"
	expected?: string
	actual?: string
	message?: string
	hint?: string
}

// FacetNames covers the facets cut in by deploy:diamond; DiamondCutFacet is deployed
// with the Diamond itself and is not in that list, hence the +1.
const EXPECTED_CORE_FACETS = FacetNames.length + 1
const EXPECTED_ACCOUNTLAYER_FACETS = 8
const CORE_ADMIN_ROLES = [
	"DEFAULT_ADMIN_ROLE",
	"SYMBOL_MANAGER_ROLE",
	"PAUSER_ROLE",
	"UNPAUSER_ROLE",
	"PARTY_B_MANAGER_ROLE",
	"SUSPENDER_ROLE",
	"DISPUTE_ROLE",
	"AFFILIATE_MANAGER_ROLE",
	"MUON_SETTER_ROLE",
	"LIQUIDATOR_ROLE",
	"PARTYB_LIQUIDATOR_ROLE",
	"DEALLOCATE_COOLDOWN_SETTER_ROLE",
	"INSTANT_LAYER_ROLE",
	"PROTOCOL_CONFIG_ROLE",
	"FEE_ADMIN_ROLE",
	"COOLDOWN_ADMIN_ROLE",
	"PROVIDER_ADMIN_ROLE",
	"INTEGRATION_ADMIN_ROLE",
	"BRIDGE_MANAGER_ROLE",
	"SIGNER_ADMIN_ROLE",
	"EMERGENCY_ADMIN_ROLE",
	"UNSUSPENDER_ROLE",
	"MIGRATION_ROLE",
	"SUSPENDED_FUNDS_WITHDRAWER_ROLE",
	"FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE",
]
const CORE_PRIVILEGED_ROLES = [
	...CORE_ADMIN_ROLES,
	"WITHDRAW_SPEED_UP_ROLE",
	"SOFT_LIQUIDATOR_ROLE",
	"CLEARING_HOUSE_ROLE",
	"VIRTUAL_DEPOSITOR_ROLE",
	"BALANCE_SETTLER_ROLE",
]
const ACCOUNTLAYER_ADMIN_ROLES = ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE", "APPROVER_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE"]
const ACCOUNTLAYER_PRIVILEGED_ROLES = [
	...ACCOUNTLAYER_ADMIN_ROLES,
	"SIGNER_SETTER_ROLE",
	"INSTANT_LAYER_ROLE",
	"DEPLOYER_ROLE",
	"DISTRIBUTOR_ROLE",
	"ACCOUNT_CREATOR_ROLE",
]
const INSTANTLAYER_ADMIN_ROLES = ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE", "OPERATOR_ROLE", "REVOKER_ROLE"]
const INSTANTLAYER_PRIVILEGED_ROLES = [...INSTANTLAYER_ADMIN_ROLES]
const PARTYB_ADMIN_ROLES = ["DEFAULT_ADMIN_ROLE", "TRUSTED_ROLE", "MANAGER_ROLE", "SETTER_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE"]
const ACCOUNTLAYER_FACET_NAMES = [
	"contracts/accountLayer/facets/Core/CoreFacet.sol:CoreFacet",
	"contracts/accountLayer/facets/Margin/MarginFacet.sol:MarginFacet",
	"contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet",
	"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
	"contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
	"contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet",
	"DiamondLoupeFacet",
]

async function checkExactFacetSelectors(ethers: any, diamondAddress: string, facetNames: string[], category: string, results: VerificationResult[]) {
	try {
		const expected = new Set<string>()
		for (const facetName of ["DiamondCutFacet", ...facetNames]) {
			const facet = await ethers.getContractAt(facetName, ethers.ZeroAddress)
			for (const selector of getSelectors(ethers, facet).selectors) expected.add(selector.toLowerCase())
		}

		const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
		const actual = new Set<string>()
		for (const facet of await loupe.facets()) {
			for (const selector of facet.functionSelectors) actual.add(selector.toLowerCase())
		}
		const missing = [...expected].filter(selector => !actual.has(selector))
		const unexpected = [...actual].filter(selector => !expected.has(selector))
		if (missing.length === 0 && unexpected.length === 0) {
			pushAndLog(results, { category, check: "Exact selector set", status: "pass", actual: `${actual.size} selectors` })
		} else {
			pushAndLog(results, {
				category,
				check: "Exact selector set",
				status: "fail",
				message:
					`${missing.length} missing, ${unexpected.length} unexpected` +
					(missing.length > 0 ? `; missing: ${missing.slice(0, 8).join(", ")}` : "") +
					(unexpected.length > 0 ? `; unexpected: ${unexpected.slice(0, 8).join(", ")}` : ""),
				hint: "Run the corresponding diamond deployment/upgrade task and inspect the selector cut",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: "Exact selector set", status: "fail", message: e.message?.slice(0, 180) })
	}
}

function roleHash(ethers: any, role: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(role))
}

// Keep redirected logs and CI artifacts readable; color only an interactive terminal.
const useColor = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && Boolean(process.stdout.isTTY)
const c = Object.fromEntries(
	Object.entries({
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		green: "\x1b[32m",
		yellow: "\x1b[33m",
		red: "\x1b[31m",
		cyan: "\x1b[36m",
		bgRed: "\x1b[41m",
		bgYellow: "\x1b[43m",
		bgGreen: "\x1b[42m",
	}).map(([name, value]) => [name, useColor ? value : ""]),
) as Record<"reset" | "bold" | "dim" | "green" | "yellow" | "red" | "cyan" | "bgRed" | "bgYellow" | "bgGreen", string>

function logResult(result: VerificationResult, indent = "   ") {
	let detail = ""
	if (result.actual) detail = result.actual
	if (result.message) detail = result.message
	if (result.status === "fail" && result.expected && result.actual) detail = `expected ${result.expected}, got ${result.actual}`

	if (result.status === "pass") {
		console.log(`${indent}${c.green}\u2713${c.reset} ${c.dim}${result.check}${detail ? `  ${detail}` : ""}${c.reset}`)
	} else if (result.status === "fail") {
		console.log(`${indent}${c.red}\u2717 ${result.check}${detail ? `  ${c.dim}${detail}${c.reset}` : ""}${c.reset}`)
		if (result.hint) console.log(`${indent}  ${c.cyan}\u2192 ${result.hint}${c.reset}`)
	} else {
		console.log(`${indent}${c.yellow}\u26A0 ${result.check}${detail ? `  ${c.dim}${detail}${c.reset}` : ""}${c.reset}`)
		if (result.hint) console.log(`${indent}  ${c.cyan}\u2192 ${result.hint}${c.reset}`)
	}
}

function pushAndLog(results: VerificationResult[], result: VerificationResult, indent = "   ") {
	results.push(result)
	logResult(result, indent)
}

async function checkExpectedValue(
	results: VerificationResult[],
	category: string,
	name: string,
	fn: () => Promise<any>,
	expected: string | number | bigint,
	hint?: string,
) {
	try {
		const value = await fn()
		const actual = BigInt(value).toString()
		const expectedValue = BigInt(expected).toString()
		if (actual === expectedValue) {
			pushAndLog(results, { category, check: name, status: "pass", expected: expectedValue, actual })
		} else {
			pushAndLog(results, { category, check: name, status: "fail", expected: expectedValue, actual, hint })
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: name, status: "fail", message: e.message?.slice(0, 160), hint })
	}
}

async function checkAddress(
	results: VerificationResult[],
	category: string,
	name: string,
	fn: () => Promise<string>,
	ethers: any,
	opts: { expected?: string; failStatus?: "fail" | "warn"; hint?: string } = {},
) {
	const failStatus = opts.failStatus || "fail"
	try {
		const addr = await fn()
		if (addr === ethers.ZeroAddress) {
			pushAndLog(results, { category, check: name, status: failStatus, message: "Not set (zero address)", hint: opts.hint })
		} else if (opts.expected && addr.toLowerCase() !== opts.expected.toLowerCase()) {
			pushAndLog(results, { category, check: name, status: "fail", expected: opts.expected, actual: addr, hint: opts.hint })
		} else {
			pushAndLog(results, { category, check: name, status: "pass", actual: addr })
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: name, status: "fail", message: e.message?.slice(0, 120), hint: opts.hint })
	}
}

/**
 * getSigner() returns msg.sender when its stored transient signer is zero. Calling
 * through the normal health-check signer therefore makes a cleared session look
 * like a persistent deployer address. Use an eth_call from address(0): zero means
 * the session is cleared; any other result is genuinely stored state.
 */
async function checkSignerSessionCleared(ethers: any, contract: any, category: string, label: string, results: VerificationResult[]) {
	try {
		const to = await contract.getAddress()
		const data = contract.interface.encodeFunctionData("getSigner")
		const raw = await ethers.provider.call({ to, data, from: ethers.ZeroAddress })
		const [storedSigner] = contract.interface.decodeFunctionResult("getSigner", raw)
		if (ethers.getAddress(storedSigner) === ethers.ZeroAddress) {
			pushAndLog(results, { category, check: label, status: "pass", actual: "cleared" })
		} else {
			pushAndLog(results, {
				category,
				check: label,
				status: "fail",
				actual: storedSigner,
				message: "A transient signer session remains active between transactions",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: label, status: "fail", message: e.message?.slice(0, 160) })
	}
}

async function checkBool(
	results: VerificationResult[],
	category: string,
	name: string,
	fn: () => Promise<boolean>,
	expected: boolean,
	failStatus: "fail" | "warn" = "fail",
	hint?: string,
) {
	try {
		const value = await fn()
		if (value === expected) {
			pushAndLog(results, { category, check: name, status: "pass", actual: String(value) })
		} else {
			pushAndLog(results, { category, check: name, status: failStatus, expected: String(expected), actual: String(value), hint })
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: name, status: "fail", message: e.message?.slice(0, 120), hint })
	}
}

async function checkRole(
	results: VerificationResult[],
	category: string,
	contract: any,
	holder: string,
	roleName: string,
	ethers: any,
	opts: { ozStyle?: boolean; failStatus?: "fail" | "warn"; contractLabel?: string } = {},
) {
	const failStatus = opts.failStatus || "fail"
	const target = opts.contractLabel || "contract"
	try {
		const hash = roleHash(ethers, roleName)
		const has = opts.ozStyle ? await contract.hasRole(hash, holder) : await contract.hasRole(holder, hash)
		const shortHolder = `${holder.slice(0, 6)}...${holder.slice(-4)}`
		if (has) {
			pushAndLog(results, { category, check: `${shortHolder} has ${roleName}`, status: "pass" })
		} else {
			const hint = opts.ozStyle
				? `Call ${target}.grantRole(keccak256("${roleName}"), ${holder})`
				: `Call ${target}.grantRole(${holder}, keccak256("${roleName}"))`
			pushAndLog(results, {
				category,
				check: `${shortHolder} has ${roleName}`,
				status: failStatus,
				message: "Role not granted",
				hint,
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: `${roleName} check`, status: "fail", message: e.message?.slice(0, 120) })
	}
}

async function checkRoleAbsent(
	results: VerificationResult[],
	category: string,
	contract: any,
	holder: string,
	roleName: string,
	ethers: any,
	opts: { ozStyle?: boolean; contractLabel?: string } = {},
) {
	const target = opts.contractLabel || "contract"
	try {
		const hash = opts.ozStyle && roleName === "DEFAULT_ADMIN_ROLE" ? await contract.DEFAULT_ADMIN_ROLE() : roleHash(ethers, roleName)
		const has = opts.ozStyle ? await contract.hasRole(hash, holder) : await contract.hasRole(holder, hash)
		const shortHolder = `${holder.slice(0, 6)}...${holder.slice(-4)}`
		if (!has) {
			pushAndLog(results, { category, check: `${shortHolder} lacks ${roleName}`, status: "pass" })
		} else {
			pushAndLog(results, {
				category,
				check: `${shortHolder} lacks ${roleName}`,
				status: "fail",
				message: "Deployer privilege was not revoked",
				hint: opts.ozStyle
					? `Have ${holder} call ${target}.renounceRole(${roleName}, ${holder})`
					: `Have an admin call ${target}.revokeRole(${holder}, keccak256("${roleName}"))`,
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: `${roleName} absence check`, status: "fail", message: e.message?.slice(0, 140) })
	}
}

async function checkOzDefaultAdminRole(
	results: VerificationResult[],
	category: string,
	contract: any,
	holder: string,
	failStatus: "fail" | "warn" = "fail",
	contractLabel?: string,
) {
	const target = contractLabel || "contract"
	try {
		const role = await contract.DEFAULT_ADMIN_ROLE()
		const has = await contract.hasRole(role, holder)
		const shortHolder = `${holder.slice(0, 6)}...${holder.slice(-4)}`
		if (has) {
			pushAndLog(results, { category, check: `${shortHolder} has DEFAULT_ADMIN_ROLE`, status: "pass" })
		} else {
			pushAndLog(results, {
				category,
				check: `${shortHolder} has DEFAULT_ADMIN_ROLE`,
				status: failStatus,
				message: "Role not granted",
				hint: `Call ${target}.grantRole(DEFAULT_ADMIN_ROLE, ${holder})`,
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: "DEFAULT_ADMIN_ROLE check", status: "fail", message: e.message?.slice(0, 120) })
	}
}

async function checkDiamondOwner(
	ethers: any,
	diamondAddress: string,
	viewFacetContractName: string,
	category: string,
	adminAddress: string | undefined,
	results: VerificationResult[],
	options: { allowPendingOwnership?: boolean; deployerAddress?: string } = {},
) {
	const transferHint = "Call Diamond.transferOwnership(newOwner), then newOwner calls Diamond.acceptOwnership()"
	try {
		const view = await ethers.getContractAt(viewFacetContractName, diamondAddress)
		const owner = await view.getOwner()
		let pending = ethers.ZeroAddress
		try {
			pending = await view.pendingOwner()
		} catch {
			// Older diamonds may not expose the pending owner getter.
		}

		if (adminAddress) {
			if (owner.toLowerCase() === adminAddress.toLowerCase()) {
				if (pending !== ethers.ZeroAddress) {
					pushAndLog(results, {
						category,
						check: "Owner",
						status: "fail",
						actual: `${owner} (unexpected pending owner ${pending})`,
						hint: "Resolve or cancel the unexpected ownership transfer before declaring the deployment healthy",
					})
				} else {
					pushAndLog(results, { category, check: "Owner", status: "pass", actual: owner })
				}
			} else if (
				options.allowPendingOwnership &&
				options.deployerAddress &&
				owner.toLowerCase() === options.deployerAddress.toLowerCase() &&
				pending.toLowerCase() === adminAddress.toLowerCase()
			) {
				pushAndLog(results, {
					category,
					check: "Owner",
					status: "warn",
					actual: `${owner}; pending ${pending}`,
					message: "Automated deployment finished; admin acceptance is pending",
					hint: `${adminAddress} must call acceptOwnership() on ${diamondAddress}`,
				})
			} else {
				pushAndLog(results, {
					category,
					check: "Owner",
					status: "fail",
					expected: adminAddress,
					actual: owner,
					hint: transferHint,
				})
			}
		} else if (owner === ethers.ZeroAddress) {
			pushAndLog(results, {
				category,
				check: "Owner",
				status: "fail",
				message: "Not set (zero address)",
				hint: transferHint,
			})
		} else {
			pushAndLog(results, { category, check: "Owner", status: "pass", actual: owner })
		}

		if (pending !== ethers.ZeroAddress && (!adminAddress || pending.toLowerCase() !== adminAddress.toLowerCase())) {
			pushAndLog(results, {
				category,
				check: "Pending owner",
				status: "fail",
				actual: pending,
				message: "Unexpected ownership transfer is in progress",
				hint: transferHint,
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: "Owner", status: "fail", message: e.message?.slice(0, 160) })
	}
}

// ============================================================================
// Core Diamond verification helpers
// ============================================================================

async function verifyCoreSystemParameters(
	ethers: any,
	diamondAddress: string,
	results: VerificationResult[],
	protocolConfig: ProtocolConfig,
	expected: {
		admin?: string
		symmioFeeReceiver?: string
		liquidationInsuranceVault?: string
		maxLiquidationProfitPerPosition?: string
		softLiquidationPenaltyCollector?: string
		signatureVerifier?: string
		muonAppId?: string
		muonUpnlValidTime?: string
		muonPriceValidTime?: string
	},
) {
	const cat = "Core: Params"
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamondAddress)

	console.log("")
	console.log(`   ${c.dim}-- System Parameters --${c.reset}`)

	const params = protocolConfig.parameters
	await checkExpectedValue(results, cat, "Balance limit per user", () => view.getBalanceLimitPerUser(), params.balanceLimitPerUser)
	await checkExpectedValue(results, cat, "Deallocate debounce time", () => view.getDeallocateDebounceTime(), params.deallocateDebounceTime)
	await checkExpectedValue(results, cat, "Liquidator share", () => view.liquidatorShare(), params.liquidatorShare)
	await checkExpectedValue(results, cat, "Liquidation timeout", () => view.liquidationTimeout(), params.liquidationTimeout)
	await checkExpectedValue(results, cat, "Pending quotes valid length", () => view.pendingQuotesValidLength(), params.pendingQuotesValidLength)
	await checkExpectedValue(results, cat, "Max connected counter party", () => view.maxConnectedCounterParty(), params.maxPartyAConnectionLimit)
	await checkExpectedValue(results, cat, "Deallocate cooldown", () => view.deallocateCooldown(), params.deallocateCooldown)
	await checkExpectedValue(results, cat, "Settlement cooldown", () => view.settlementCooldown(), params.settlementCooldown)
	await checkExpectedValue(results, cat, "Max withdraw parts", () => view.getMaxWithdrawParts(), params.maxWithdrawParts)

	// Force close cooldowns (returns tuple)
	try {
		const [first, second] = await view.forceCloseCooldowns()
		if (first.toString() === String(params.forceCloseCooldowns[0]) && second.toString() === String(params.forceCloseCooldowns[1])) {
			pushAndLog(results, { category: cat, check: "Force close cooldowns", status: "pass", actual: `first=${first}, second=${second}` })
		} else {
			pushAndLog(results, {
				category: cat,
				check: "Force close cooldowns",
				status: "fail",
				actual: `first=${first}, second=${second}`,
				expected: `${params.forceCloseCooldowns[0]},${params.forceCloseCooldowns[1]}`,
				message: "Force close cooldown tuple does not match protocol config",
				hint: "Call ControlFacet.setForceCloseCooldowns(firstCooldown, secondCooldown) on Diamond",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Force close cooldowns", status: "fail", message: e.message?.slice(0, 120) })
	}

	// MA cooldowns: withdrawCooldownPeriod, forceCancelCooldown, forceCancelCloseCooldown, forceCloseFirstCooldown
	try {
		const [withdrawCooldown, forceCancelCooldown, forceCancelCloseCooldown, forceCloseFirst] = await view.coolDownsOfMA()
		const cooldownChecks = [
			{
				name: "Withdraw cooldown period",
				value: withdrawCooldown,
				expected: params.deallocateCooldown,
				hint: "Call ControlFacet.setDeallocateCooldown(seconds) on Diamond",
			},
			{
				name: "Force cancel cooldown",
				value: forceCancelCooldown,
				expected: params.forceCancelCooldown,
				hint: "Call ControlFacet.setForceCancelCooldown(seconds) on Diamond",
			},
			{
				name: "Force cancel close cooldown",
				value: forceCancelCloseCooldown,
				expected: params.forceCancelCloseCooldown,
				hint: "Call ControlFacet.setForceCancelCloseCooldown(seconds) on Diamond",
			},
			{
				name: "Force close first cooldown (MA)",
				value: forceCloseFirst,
				expected: params.forceCloseCooldowns[0],
				hint: "Call ControlFacet.setForceCloseCooldowns(first, second) on Diamond",
			},
		]
		for (const cd of cooldownChecks) {
			if (cd.value.toString() === String(cd.expected)) {
				pushAndLog(results, { category: cat, check: cd.name, status: "pass", actual: String(cd.value) })
			} else {
				pushAndLog(results, {
					category: cat,
					check: cd.name,
					status: "fail",
					actual: String(cd.value),
					expected: String(cd.expected),
					message: "Value does not match protocol config",
					hint: cd.hint,
				})
			}
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "MA cooldowns", status: "fail", message: e.message?.slice(0, 120) })
	}

	// Address parameters
	console.log("")
	console.log(`   ${c.dim}-- Address Parameters --${c.reset}`)
	await checkAddress(results, cat, "Signature verifier", () => view.getSignatureVerifier(), ethers, {
		expected: expected.signatureVerifier,
		hint: "Call ControlFacet.setSignatureVerifierAddress(verifierAddress) on Diamond",
	})
	await checkAddress(results, cat, "Invalid bridged amounts pool", () => view.getInvalidBridgedAmountsPool(), ethers, {
		expected: expected.admin,
		hint: "Call ControlFacet.setInvalidBridgedAmountsPool(address) on Diamond",
	})
	await checkAddress(results, cat, "Default fee collector", () => view.getDefaultFeeCollector(), ethers, {
		expected: expected.symmioFeeReceiver,
		hint: "Call ControlFacet.setDefaultFeeCollector(address) on Diamond",
	})
	await checkAddress(results, cat, "Soft liquidation penalty collector", () => view.getSoftLiquidationPenaltyCollector(), ethers, {
		expected: expected.softLiquidationPenaltyCollector,
		failStatus: "fail",
		hint: "Call ControlFacet.setSoftLiquidationPenaltyCollector(address) on Diamond",
	})

	// Liquidation insurance vault
	try {
		const [vault, maxProfit] = await view.getLiquidationInsuranceVaultParams()
		if (expected.liquidationInsuranceVault && expected.maxLiquidationProfitPerPosition) {
			const expectedVault = ethers.getAddress(expected.liquidationInsuranceVault)
			const expectedMaxProfit = BigInt(expected.maxLiquidationProfitPerPosition)
			if (ethers.getAddress(vault) === expectedVault && BigInt(maxProfit) === expectedMaxProfit) {
				pushAndLog(results, {
					category: cat,
					check: "Liquidation insurance vault",
					status: "pass",
					actual: `vault=${vault}, maxProfit=${maxProfit}`,
				})
			} else {
				pushAndLog(results, {
					category: cat,
					check: "Liquidation insurance vault",
					status: "fail",
					expected: `vault=${expectedVault}, maxProfit=${expectedMaxProfit}`,
					actual: `vault=${vault}, maxProfit=${maxProfit}`,
					hint: "Call ControlFacet.setLiquidationInsuranceVaultParams(vaultAddress, maxProfit) on Diamond",
				})
			}
		} else if (ethers.getAddress(vault) !== ethers.ZeroAddress && BigInt(maxProfit) > BigInt(0)) {
			pushAndLog(results, {
				category: cat,
				check: "Liquidation insurance vault",
				status: "pass",
				actual: `vault=${vault}, maxProfit=${maxProfit}`,
			})
		} else {
			pushAndLog(results, {
				category: cat,
				check: "Liquidation insurance vault",
				status: "fail",
				message: `Unsafe liquidation accounting: vault=${vault}, maxProfit=${maxProfit}; both must be non-zero`,
				hint: "Call ControlFacet.setLiquidationInsuranceVaultParams(vaultAddress, maxProfit) on Diamond",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Liquidation insurance vault", status: "fail", message: e.message?.slice(0, 120) })
	}
	await checkSignerSessionCleared(ethers, view, cat, "Transient signer session", results)

	// Muon oracle config
	console.log("")
	console.log(`   ${c.dim}-- Muon Oracle --${c.reset}`)
	try {
		const [upnlValidTime, priceValidTime] = await view.getMuonConfig()
		if (expected.muonUpnlValidTime && expected.muonPriceValidTime) {
			const matches =
				upnlValidTime.toString() === BigInt(expected.muonUpnlValidTime).toString() &&
				priceValidTime.toString() === BigInt(expected.muonPriceValidTime).toString()
			pushAndLog(results, {
				category: cat,
				check: "Muon config",
				status: matches ? "pass" : "fail",
				expected: `upnlValidTime=${expected.muonUpnlValidTime}, priceValidTime=${expected.muonPriceValidTime}`,
				actual: `upnlValidTime=${upnlValidTime}, priceValidTime=${priceValidTime}`,
				hint: "Call ControlFacet.setMuonConfig(upnlValidTime, priceValidTime) on Diamond",
			})
		} else if (upnlValidTime > BigInt(0) && priceValidTime > BigInt(0)) {
			pushAndLog(results, {
				category: cat,
				check: "Muon config",
				status: "pass",
				actual: `upnlValidTime=${upnlValidTime}, priceValidTime=${priceValidTime}`,
			})
		} else {
			pushAndLog(results, {
				category: cat,
				check: "Muon config",
				status: "warn",
				actual: `upnlValidTime=${upnlValidTime}, priceValidTime=${priceValidTime}`,
				message: "Not configured (set before production)",
				hint: "Call ControlFacet.setMuonConfig(upnlValidTime, priceValidTime) on Diamond",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Muon config", status: "fail", message: e.message?.slice(0, 120) })
	}

	try {
		const muonAppId = await view.getMuonIds()
		if (expected.muonAppId) {
			const expectedAppId = BigInt(expected.muonAppId).toString()
			const actualAppId = muonAppId.toString()
			pushAndLog(results, {
				category: cat,
				check: "Muon app ID",
				status: actualAppId === expectedAppId ? "pass" : "fail",
				expected: expectedAppId,
				actual: actualAppId,
				hint: "Call ControlFacet.setMuonIds(muonAppId) on Diamond",
			})
		} else if (muonAppId > BigInt(0)) {
			pushAndLog(results, { category: cat, check: "Muon app ID", status: "pass", actual: String(muonAppId) })
		} else {
			pushAndLog(results, {
				category: cat,
				check: "Muon app ID",
				status: "warn",
				message: "Not configured (set before production)",
				hint: "Call ControlFacet.setMuonIds(muonAppId) on Diamond",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Muon app ID", status: "fail", message: e.message?.slice(0, 120) })
	}

	// Pause state
	console.log("")
	console.log(`   ${c.dim}-- Pause State --${c.reset}`)
	try {
		const [
			globalPaused,
			liquidationPaused,
			accountingPaused,
			partyBActionsPaused,
			partyAActionsPaused,
			emergencyMode,
			internalTransferPaused,
			partyBOpenPositionsPaused,
			instantLayerPaused,
		] = await view.pauseState()
		const pauseChecks = [
			{ name: "Global paused", value: globalPaused },
			{ name: "Liquidation paused", value: liquidationPaused },
			{ name: "Accounting paused", value: accountingPaused },
			{ name: "PartyB actions paused", value: partyBActionsPaused },
			{ name: "PartyA actions paused", value: partyAActionsPaused },
			{ name: "Emergency mode", value: emergencyMode },
			{ name: "Internal transfer paused", value: internalTransferPaused },
			{ name: "PartyB open positions paused", value: partyBOpenPositionsPaused },
			{ name: "InstantLayer paused", value: instantLayerPaused },
		]
		for (const p of pauseChecks) {
			if (!p.value) {
				pushAndLog(results, { category: "Core: Pause", check: p.name, status: "pass", actual: "false" })
			} else {
				pushAndLog(results, {
					category: "Core: Pause",
					check: p.name,
					status: "warn",
					actual: "true",
					message: "System is paused",
					hint: "Call the corresponding PauseControlFacet function on Diamond to unpause",
				})
			}
		}
	} catch (e: any) {
		pushAndLog(results, { category: "Core: Pause", check: "Pause state", status: "fail", message: e.message?.slice(0, 120) })
	}
}

async function verifyMuonSignatureVerifier(
	ethers: any,
	verifierAddress: string,
	results: VerificationResult[],
	expected: {
		deployMockVerifier?: boolean
		admin?: string
		muonPublicKeyX?: string
		muonPublicKeyParity?: string
		muonGatewaySigners?: string[]
		muonFunctionPermissions?: string[]
	} | null,
	deployerAddress: string,
) {
	const category = "MuonSignatureVerifier"
	console.log(`${c.bold}${category}${c.reset}  ${c.dim}${verifierAddress}${c.reset}`)

	const code = await ethers.provider.getCode(verifierAddress)
	if (code === "0x") {
		pushAndLog(results, { category, check: "Contract exists", status: "fail", message: "No contract code at verifier address" })
		return
	}
	pushAndLog(results, { category, check: "Contract exists", status: "pass" })

	if (!expected || typeof expected.deployMockVerifier !== "boolean") {
		pushAndLog(results, {
			category,
			check: "Deployment profile",
			status: "fail",
			message: "Verifier mode and permission profile are unavailable",
			hint: "Run check:deployment with --from-report=true using the scoped deployment report",
		})
		return
	}
	if (expected.deployMockVerifier) {
		pushAndLog(results, {
			category,
			check: "Verifier mode",
			status: "pass",
			actual: "Mock verifier (local/test deployment)",
		})
		return
	}

	let permissionNames: string[]
	try {
		permissionNames = assertGeneralDeploymentMuonPermissions(
			expected.muonFunctionPermissions || [],
			"deployment report Muon function permissions",
		).map(({ name }) => name)
		pushAndLog(results, { category, check: "Complete function permission profile", status: "pass", actual: permissionNames.join(",") })
	} catch (error) {
		pushAndLog(results, {
			category,
			check: "Complete function permission profile",
			status: "fail",
			message: error instanceof Error ? error.message : String(error),
			hint: "Deploy with all eight exact MUON_FUNCTION_PERMISSIONS categories",
		})
		return
	}

	const verifier = await ethers.getContractAt("MuonSignatureVerifier", verifierAddress)
	if (!expected.admin) {
		pushAndLog(results, { category, check: "Admin configuration", status: "fail", message: "Expected admin is missing from deployment report" })
	} else {
		await checkOzDefaultAdminRole(results, category, verifier, expected.admin, "fail", "MuonSignatureVerifier")
		await checkRole(results, category, verifier, expected.admin, "SETTER_ROLE", ethers, {
			ozStyle: true,
			contractLabel: "MuonSignatureVerifier",
		})
	}
	await checkRoleAbsent(results, `${category}: Deployer`, verifier, deployerAddress, "DEFAULT_ADMIN_ROLE", ethers, {
		ozStyle: true,
		contractLabel: "MuonSignatureVerifier",
	})
	await checkRoleAbsent(results, `${category}: Deployer`, verifier, deployerAddress, "SETTER_ROLE", ethers, {
		ozStyle: true,
		contractLabel: "MuonSignatureVerifier",
	})

	try {
		const registeredKeys = (await verifier.getAllPublicKeys()).map((key: { x: bigint; parity: bigint | number }) => ({
			x: key.x.toString(),
			parity: Number(key.parity),
		}))
		const registeredGatewaySigners = (await verifier.getAllGatewaySigners()).map((signer: string) => ethers.getAddress(signer))
		const hasConfiguredKey = Boolean(expected.muonPublicKeyX || expected.muonPublicKeyParity)
		if (Boolean(expected.muonPublicKeyX) !== Boolean(expected.muonPublicKeyParity)) {
			pushAndLog(results, {
				category,
				check: "Configured public key",
				status: "fail",
				message: "Deployment report contains an incomplete Muon public key",
			})
			return
		}
		const targetKeys = hasConfiguredKey
			? [{ x: BigInt(expected.muonPublicKeyX!).toString(), parity: Number(expected.muonPublicKeyParity) }]
			: registeredKeys
		const configuredGatewaySigners = expected.muonGatewaySigners || []
		const targetGatewaySigners = configuredGatewaySigners.length > 0 ? configuredGatewaySigners.map(ethers.getAddress) : registeredGatewaySigners
		const registeredKeyIds = new Set(registeredKeys.map((key: { x: string; parity: number }) => `${key.x}:${key.parity}`))
		const registeredGatewayIds = new Set(registeredGatewaySigners.map((signer: string) => signer.toLowerCase()))
		const missingKeys = targetKeys.filter((key: { x: string; parity: number }) => !registeredKeyIds.has(`${key.x}:${key.parity}`))
		const missingGateways = targetGatewaySigners.filter((signer: string) => !registeredGatewayIds.has(signer.toLowerCase()))

		if (targetKeys.length === 0) {
			pushAndLog(results, { category, check: "Registered public keys", status: "fail", message: "No Muon public keys are registered" })
		} else if (missingKeys.length > 0) {
			pushAndLog(results, {
				category,
				check: "Registered public keys",
				status: "fail",
				message: missingKeys.map((key: { x: string; parity: number }) => `x=${key.x}, parity=${key.parity}`).join("; "),
			})
		} else {
			pushAndLog(results, { category, check: "Registered public keys", status: "pass", actual: String(targetKeys.length) })
		}

		if (targetGatewaySigners.length === 0) {
			pushAndLog(results, { category, check: "Registered gateway signers", status: "fail", message: "No Muon gateway signers are registered" })
		} else if (missingGateways.length > 0) {
			pushAndLog(results, {
				category,
				check: "Registered gateway signers",
				status: "fail",
				message: missingGateways.join(", "),
			})
		} else {
			pushAndLog(results, { category, check: "Registered gateway signers", status: "pass", actual: String(targetGatewaySigners.length) })
		}

		const inspection = await inspectConfiguredMuonPermissions(verifier, {
			publicKeys: targetKeys,
			gatewaySigners: targetGatewaySigners,
			permissionNames,
		})
		try {
			assertConfiguredMuonPermissionsAuthorized(inspection)
			pushAndLog(results, {
				category,
				check: "Key and gateway function authorization",
				status: "pass",
				actual: `${targetKeys.length} key(s) and ${targetGatewaySigners.length} gateway(s) across ${permissionNames.length} categories`,
			})
		} catch (error) {
			pushAndLog(results, {
				category,
				check: "Key and gateway function authorization",
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				hint: "Grant the missing verifier permissions with an account holding SETTER_ROLE",
			})
		}
	} catch (error) {
		pushAndLog(results, {
			category,
			check: "Verifier key and gateway inspection",
			status: "fail",
			message: error instanceof Error ? error.message : String(error),
		})
	}
}

async function verifyCoreRoles(
	ethers: any,
	diamondAddress: string,
	addresses: { admin?: string; accountLayer?: string; instantLayer?: string },
	results: VerificationResult[],
	deployerAddress: string,
) {
	const cat = "Core: Roles"
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamondAddress)

	console.log("")
	console.log(`   ${c.dim}-- Admin Roles on Diamond --${c.reset}`)

	if (addresses.admin) {
		for (const role of CORE_ADMIN_ROLES) {
			await checkRole(results, cat, view, addresses.admin, role, ethers, { contractLabel: "Diamond ControlFacet" })
		}
	} else {
		pushAndLog(results, {
			category: cat,
			check: "Admin roles",
			status: "warn",
			message: "No admin address provided, skipping role checks",
			hint: "Re-run with --admin <address> to verify role assignments",
		})
	}

	console.log("")
	console.log(`   ${c.dim}-- Deployer Privilege Removal --${c.reset}`)
	for (const role of CORE_PRIVILEGED_ROLES) {
		await checkRoleAbsent(results, "Core: Deployer", view, deployerAddress, role, ethers, { contractLabel: "Diamond ControlFacet" })
	}

	// AccountLayerDiamond roles on Diamond
	if (addresses.accountLayer) {
		console.log("")
		console.log(`   ${c.dim}-- AccountLayer Roles on Diamond --${c.reset}`)
		const alRolesOnDiamond = ["SIGNER_ADMIN_ROLE", "AFFILIATE_MANAGER_ROLE", "BALANCE_SETTLER_ROLE"]
		for (const role of alRolesOnDiamond) {
			await checkRole(results, cat, view, addresses.accountLayer, role, ethers, { contractLabel: "Diamond ControlFacet" })
		}
	}

	// InstantLayer role on Diamond
	if (addresses.instantLayer) {
		console.log("")
		console.log(`   ${c.dim}-- InstantLayer Role on Diamond --${c.reset}`)
		await checkRole(results, cat, view, addresses.instantLayer, "INSTANT_LAYER_ROLE", ethers, { contractLabel: "Diamond ControlFacet" })
	}
}

// ============================================================================
// AccountLayer verification helpers
// ============================================================================

async function verifyAccountLayerFull(
	ethers: any,
	accountLayerAddress: string,
	addresses: { diamond?: string; admin?: string; instantLayer?: string; symmioFeeReceiver?: string },
	results: VerificationResult[],
	ownerOptions: { allowPendingOwnership?: boolean; deployerAddress?: string } = {},
) {
	const cat = "AccountLayer"

	// Facet count
	try {
		const loupe = await ethers.getContractAt("IDiamondLoupe", accountLayerAddress)
		const facets = await loupe.facets()
		const facetCount = facets.length
		if (facetCount === EXPECTED_ACCOUNTLAYER_FACETS) {
			pushAndLog(results, {
				category: cat,
				check: "Facet count",
				status: "pass",
				expected: String(EXPECTED_ACCOUNTLAYER_FACETS),
				actual: String(facetCount),
			})
		} else {
			pushAndLog(results, {
				category: cat,
				check: "Facet count",
				status: "fail",
				expected: String(EXPECTED_ACCOUNTLAYER_FACETS),
				actual: String(facetCount),
				hint: "Run deploy:diamond to add/remove AccountLayer facets via diamondCut. Expected " + EXPECTED_ACCOUNTLAYER_FACETS + " facets",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Facet count", status: "fail", message: e.message?.slice(0, 120) })
	}
	await checkExactFacetSelectors(ethers, accountLayerAddress, ACCOUNTLAYER_FACET_NAMES, cat, results)

	const alView = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", accountLayerAddress)

	// Owner (and pending owner if transfer in progress)
	await checkDiamondOwner(
		ethers,
		accountLayerAddress,
		"contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
		cat,
		addresses.admin,
		results,
		ownerOptions,
	)

	// Roles (Symmio-style: hasRole(address, bytes32))
	console.log("")
	console.log(`   ${c.dim}-- Roles --${c.reset}`)
	if (addresses.admin) {
		for (const role of ACCOUNTLAYER_ADMIN_ROLES) {
			await checkRole(results, cat, alView, addresses.admin, role, ethers, { contractLabel: "AccountLayer ControlFacet" })
		}
	} else {
		pushAndLog(results, {
			category: cat,
			check: "Admin roles",
			status: "warn",
			message: "No admin address provided, skipping role checks",
			hint: "Re-run with --admin <address> to verify role assignments",
		})
	}
	if (ownerOptions.deployerAddress) {
		console.log("")
		console.log(`   ${c.dim}-- Deployer Privilege Removal --${c.reset}`)
		for (const role of ACCOUNTLAYER_PRIVILEGED_ROLES) {
			await checkRoleAbsent(results, "AccountLayer: Deployer", alView, ownerOptions.deployerAddress, role, ethers, {
				contractLabel: "AccountLayer ControlFacet",
			})
		}
	} else {
		pushAndLog(results, {
			category: "AccountLayer: Deployer",
			check: "Deployer privilege removal",
			status: "fail",
			message: "Deployer address unavailable",
		})
	}

	if (addresses.instantLayer) {
		await checkRole(results, cat, alView, addresses.instantLayer, "SIGNER_SETTER_ROLE", ethers, { contractLabel: "AccountLayer ControlFacet" })
	}

	// Symmio Core whitelisted
	console.log("")
	console.log(`   ${c.dim}-- Configuration --${c.reset}`)
	if (addresses.diamond) {
		await checkBool(
			results,
			cat,
			"Symmio Core whitelisted",
			() => alView.isWhitelistedSymmioCore(addresses.diamond!),
			true,
			"fail",
			`Call AccountLayer ControlFacet.setWhitelistedSymmioCore(${addresses.diamond}, true)`,
		)
	}

	// System hook registered on Symmio Core
	if (addresses.diamond) {
		const hookHint = `Call Diamond ControlFacet.registerHook(address(0), ${accountLayerAddress})`
		try {
			const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
			const hookAddress = await coreView.getAffiliateHook(ethers.ZeroAddress)
			if (hookAddress === ethers.ZeroAddress) {
				pushAndLog(results, {
					category: cat,
					check: "System hook registered on Symmio Core",
					status: "fail",
					expected: accountLayerAddress,
					actual: hookAddress,
					message: "No system hook registered",
					hint: hookHint,
				})
			} else if (hookAddress.toLowerCase() !== accountLayerAddress.toLowerCase()) {
				pushAndLog(results, {
					category: cat,
					check: "System hook registered on Symmio Core",
					status: "fail",
					expected: accountLayerAddress,
					actual: hookAddress,
					hint: hookHint,
				})
			} else {
				pushAndLog(results, { category: cat, check: "System hook registered on Symmio Core", status: "pass", actual: hookAddress })
			}
		} catch (e: any) {
			pushAndLog(results, {
				category: cat,
				check: "System hook registered on Symmio Core",
				status: "fail",
				message: e.message?.slice(0, 120),
				hint: hookHint,
			})
		}
	}

	// Symmio fee receiver
	await checkAddress(results, cat, "Symmio fee receiver", () => alView.symmioFeeReceiver(), ethers, {
		expected: addresses.symmioFeeReceiver,
		hint: "Call AccountLayer ControlFacet.setSymmioFeeReceiver(address)",
	})

	// A signer is transaction-scoped and must never remain set between calls.
	await checkSignerSessionCleared(ethers, alView, cat, "Transient signer session", results)

	// Account manager implementation
	try {
		const impl = await alView.accountManagerImplementation()
		if (impl && impl !== "0x") {
			pushAndLog(results, { category: cat, check: "Account manager implementation", status: "pass", actual: `${impl.length} bytes` })
		} else {
			pushAndLog(results, {
				category: cat,
				check: "Account manager implementation",
				status: "warn",
				message: "Not set (needed for account creation)",
				hint: "Call AccountLayer ControlFacet.setAccountManagerImplementation(bytecode)",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Account manager implementation", status: "fail", message: e.message?.slice(0, 120) })
	}

	// Pause state
	await checkBool(
		results,
		cat,
		"Not paused",
		() => alView.paused().then((p: boolean) => !p),
		true,
		"warn",
		"Call AccountLayer ControlFacet.unpause()",
	)
}

// ============================================================================
// InstantLayer verification helpers
// ============================================================================

async function verifyInstantLayerFull(
	ethers: any,
	instantLayerAddress: string,
	addresses: { diamond?: string; accountLayer?: string; admin?: string },
	results: VerificationResult[],
	protocolConfig: ProtocolConfig,
	partyBAddresses: string[],
	deployerAddress: string,
) {
	const cat = "InstantLayer"
	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress)

	// AccountLayer set
	await checkAddress(results, cat, "AccountLayer set", () => instantLayer.accountLayer(), ethers, {
		expected: addresses.accountLayer,
		hint: "Call InstantLayer.setAccountLayer(accountLayerAddress)",
	})

	// Diamond whitelisted
	if (addresses.diamond) {
		await checkBool(
			results,
			cat,
			"Diamond whitelisted",
			() => instantLayer.whitelistedTargets(addresses.diamond!),
			true,
			"fail",
			`Call InstantLayer.setTargetWhitelist(${addresses.diamond}, true)`,
		)
	}

	// AccountLayer whitelisted
	if (addresses.accountLayer) {
		await checkBool(
			results,
			cat,
			"AccountLayer whitelisted",
			() => instantLayer.whitelistedTargets(addresses.accountLayer!),
			true,
			"fail",
			`Call InstantLayer.setTargetWhitelist(${addresses.accountLayer}, true)`,
		)
	}

	// Roles (OZ-style: hasRole(bytes32, address))
	console.log("")
	console.log(`   ${c.dim}-- Roles --${c.reset}`)
	if (addresses.admin) {
		for (const role of INSTANTLAYER_ADMIN_ROLES) {
			if (role === "DEFAULT_ADMIN_ROLE") {
				await checkOzDefaultAdminRole(results, cat, instantLayer, addresses.admin, "fail", "InstantLayer")
			} else {
				await checkRole(results, cat, instantLayer, addresses.admin, role, ethers, { ozStyle: true, contractLabel: "InstantLayer" })
			}
		}
	} else {
		pushAndLog(results, {
			category: cat,
			check: "Admin roles",
			status: "warn",
			message: "No admin address provided, skipping role checks",
			hint: "Re-run with --admin <address> to verify role assignments",
		})
	}
	for (const partyBAddress of partyBAddresses) {
		await checkRole(results, cat, instantLayer, partyBAddress, "OPERATOR_ROLE", ethers, { ozStyle: true, contractLabel: "InstantLayer" })
	}

	console.log("")
	console.log(`   ${c.dim}-- Deployer Privilege Removal --${c.reset}`)
	for (const role of INSTANTLAYER_PRIVILEGED_ROLES) {
		await checkRoleAbsent(results, "InstantLayer: Deployer", instantLayer, deployerAddress, role, ethers, {
			ozStyle: true,
			contractLabel: "InstantLayer",
		})
	}

	// Templates
	console.log("")
	console.log(`   ${c.dim}-- Templates --${c.reset}`)
	const templateHint = "Run the InstantLayer template setup (SETUP_INSTANT_LAYER_TEMPLATES=true in deploy:system)"
	try {
		const nextTemplateId = await instantLayer.nextTemplateId()
		const templateCount = Number(nextTemplateId)

		if (templateCount === protocolConfig.instantLayerTemplates.length) {
			pushAndLog(results, { category: cat, check: "Template count", status: "pass", actual: String(templateCount) })
		} else {
			pushAndLog(results, {
				category: cat,
				check: "Template count",
				status: "fail",
				expected: String(protocolConfig.instantLayerTemplates.length),
				actual: String(templateCount),
				hint: templateHint,
			})
		}

		for (const [templateId, expectedTemplate] of protocolConfig.instantLayerTemplates.entries()) {
			if (templateId >= templateCount) continue
			const template = await instantLayer.getTemplate(templateId)
			let instantOpenMode: boolean | undefined
			try {
				instantOpenMode = await instantLayer.templateInstantOpenMode(templateId)
			} catch {
				// Older InstantLayer versions may not expose this public mapping.
			}
			const mismatches = templateConfigMismatches(templateId, template, expectedTemplate, instantOpenMode)
			if (mismatches.length === 0) {
				pushAndLog(results, { category: cat, check: `Template ${templateId}: ${expectedTemplate.name}`, status: "pass", actual: "exact match" })
			} else {
				pushAndLog(results, {
					category: cat,
					check: `Template ${templateId}: ${expectedTemplate.name}`,
					status: "fail",
					message: mismatches.join("; ").slice(0, 500),
					hint: templateHint,
				})
			}
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Templates", status: "fail", message: e.message?.slice(0, 120) })
	}
}

// ============================================================================
// PartyB verification helpers
// ============================================================================

async function verifyPartyBFull(
	ethers: any,
	partyBAddress: string,
	addresses: { diamond?: string; instantLayer?: string; admin?: string },
	results: VerificationResult[],
	deployerAddress: string,
) {
	const cat = "PartyB"
	const partyB = await ethers.getContractAt("SymmioPartyB", partyBAddress)

	// Symmio address
	try {
		const symmioAddr = await partyB.symmioAddress()
		if (addresses.diamond && symmioAddr.toLowerCase() !== addresses.diamond.toLowerCase()) {
			pushAndLog(results, {
				category: cat,
				check: "Symmio address",
				status: "fail",
				expected: addresses.diamond,
				actual: symmioAddr,
				hint: `Call SymmioPartyB.setSymmioAddress(${addresses.diamond})`,
			})
		} else if (symmioAddr === ethers.ZeroAddress) {
			pushAndLog(results, {
				category: cat,
				check: "Symmio address",
				status: "fail",
				message: "Not set (zero address)",
				hint: "Call SymmioPartyB.setSymmioAddress(diamondAddress)",
			})
		} else {
			pushAndLog(results, { category: cat, check: "Symmio address", status: "pass", actual: symmioAddr })
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Symmio address", status: "fail", message: e.message?.slice(0, 120) })
	}

	// Registered in Diamond
	if (addresses.diamond) {
		try {
			const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
			await checkBool(
				results,
				cat,
				"Registered in Diamond",
				() => view.isPartyB(partyBAddress),
				true,
				"fail",
				`Call Diamond ControlFacet.registerPartyB(${partyBAddress})`,
			)
		} catch (e: any) {
			pushAndLog(results, { category: cat, check: "Registered in Diamond", status: "fail", message: e.message?.slice(0, 120) })
		}
	}

	// Registered in InstantLayer
	if (addresses.instantLayer) {
		try {
			const il = await ethers.getContractAt("InstantLayer", addresses.instantLayer)
			await checkBool(
				results,
				cat,
				"Registered in InstantLayer",
				() => il.registeredPartyBs(partyBAddress),
				true,
				"fail",
				`Call InstantLayer.registerPartyBs([${partyBAddress}])`,
			)
		} catch (e: any) {
			pushAndLog(results, { category: cat, check: "Registered in InstantLayer", status: "fail", message: e.message?.slice(0, 120) })
		}
	}

	// Roles (OZ-style: hasRole(bytes32, address))
	console.log("")
	console.log(`   ${c.dim}-- Roles --${c.reset}`)
	if (addresses.admin) {
		for (const role of PARTYB_ADMIN_ROLES) {
			if (role === "DEFAULT_ADMIN_ROLE") {
				await checkOzDefaultAdminRole(results, cat, partyB, addresses.admin, "fail", "SymmioPartyB")
			} else {
				await checkRole(results, cat, partyB, addresses.admin, role, ethers, { ozStyle: true, contractLabel: "SymmioPartyB" })
			}
		}
	} else {
		pushAndLog(results, {
			category: cat,
			check: "Admin roles",
			status: "warn",
			message: "No admin address provided, skipping role checks",
			hint: "Re-run with --admin <address> to verify role assignments",
		})
	}

	if (addresses.instantLayer) {
		await checkRole(results, cat, partyB, addresses.instantLayer, "TRUSTED_ROLE", ethers, { ozStyle: true, contractLabel: "SymmioPartyB" })
	}

	console.log("")
	console.log(`   ${c.dim}-- Deployer Privilege Removal --${c.reset}`)
	for (const role of PARTYB_ADMIN_ROLES) {
		await checkRoleAbsent(results, "PartyB: Deployer", partyB, deployerAddress, role, ethers, {
			ozStyle: true,
			contractLabel: "SymmioPartyB",
		})
	}

	// Multicast whitelist for InstantLayer
	if (addresses.instantLayer) {
		console.log("")
		console.log(`   ${c.dim}-- Configuration --${c.reset}`)
		await checkBool(
			results,
			cat,
			"InstantLayer multicast whitelisted",
			() => partyB.multicastWhitelist(addresses.instantLayer!),
			true,
			"fail",
			`Call SymmioPartyB.setMulticastWhitelist(${addresses.instantLayer}, true)`,
		)
	}

	// Signer
	try {
		const signer = await partyB.signer()
		if (signer === ethers.ZeroAddress) {
			pushAndLog(results, {
				category: cat,
				check: "Signer",
				status: "warn",
				message: "Not set (may need manual configuration)",
				hint: "Call SymmioPartyB.setSigner(signerAddress)",
			})
		} else {
			pushAndLog(results, { category: cat, check: "Signer", status: "pass", actual: signer })
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Signer", status: "fail", message: e.message?.slice(0, 120) })
	}
}

async function verifySymbolManagerFull(
	ethers: any,
	symbolManagerAddress: string,
	addresses: { diamond?: string; admin?: string; symbolManagerOperator?: string },
	results: VerificationResult[],
	deployerAddress: string,
	allowPendingAdminActions: boolean,
) {
	const cat = "SymbolManager"
	const symbolManager = await ethers.getContractAt("SymmioSymbolManager", symbolManagerAddress)

	await checkAddress(results, cat, "Symmio Core", () => symbolManager.symmioAddress(), ethers, {
		expected: addresses.diamond,
		hint: "Redeploy SymbolManager with the correct immutable Symmio core address",
	})
	await checkBool(
		results,
		cat,
		"Not paused",
		() => symbolManager.paused().then((paused: boolean) => !paused),
		true,
		"warn",
		"Call SymbolManager.unpause()",
	)

	console.log("")
	console.log(`   ${c.dim}-- Roles --${c.reset}`)
	if (addresses.admin) {
		await checkOzDefaultAdminRole(results, cat, symbolManager, addresses.admin, "fail", "SymbolManager")
	} else {
		pushAndLog(results, { category: cat, check: "Admin role", status: "fail", message: "Expected admin address unavailable" })
	}

	if (addresses.symbolManagerOperator) {
		for (const role of ["SYMBOL_ADDER_ROLE", "SYMBOL_REMOVER_ROLE"]) {
			await checkRole(results, cat, symbolManager, addresses.symbolManagerOperator, role, ethers, {
				ozStyle: true,
				contractLabel: "SymbolManager",
				failStatus: allowPendingAdminActions ? "warn" : "fail",
			})
		}
	} else {
		pushAndLog(results, {
			category: cat,
			check: "Operator roles",
			status: "fail",
			message: "No SymbolManager operator is configured",
			hint: "Set SYMBOL_MANAGER_OPERATOR and grant SYMBOL_ADDER_ROLE plus SYMBOL_REMOVER_ROLE",
		})
	}

	await checkRoleAbsent(results, "SymbolManager: Deployer", symbolManager, deployerAddress, "DEFAULT_ADMIN_ROLE", ethers, {
		ozStyle: true,
		contractLabel: "SymbolManager",
	})

	if (addresses.diamond) {
		const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
		for (const role of ["SYMBOL_MANAGER_ROLE", "FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"]) {
			await checkRole(results, cat, coreView, symbolManagerAddress, role, ethers, { contractLabel: "Diamond ControlFacet" })
		}
	}
}

async function verifyLiquidatorFull(
	ethers: any,
	liquidatorAddress: string,
	addresses: { diamond?: string; admin?: string; operators?: string[] },
	results: VerificationResult[],
) {
	const cat = "Liquidator"
	const liquidator = await ethers.getContractAt("SymmioLiquidator", liquidatorAddress)

	// Symmio address
	try {
		const symmioAddr = await liquidator.symmioAddress()
		if (addresses.diamond && symmioAddr.toLowerCase() !== addresses.diamond.toLowerCase()) {
			pushAndLog(results, {
				category: cat,
				check: "Symmio address",
				status: "fail",
				expected: addresses.diamond,
				actual: symmioAddr,
				hint: `Call SymmioLiquidator.setSymmioAddress(${addresses.diamond})`,
			})
		} else if (symmioAddr === ethers.ZeroAddress) {
			pushAndLog(results, {
				category: cat,
				check: "Symmio address",
				status: "fail",
				message: "Not set (zero address)",
				hint: "Call SymmioLiquidator.setSymmioAddress(diamondAddress)",
			})
		} else {
			pushAndLog(results, { category: cat, check: "Symmio address", status: "pass", actual: symmioAddr })
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Symmio address", status: "fail", message: e.message?.slice(0, 120) })
	}

	// Pause state
	try {
		const paused = await liquidator.paused()
		pushAndLog(results, { category: cat, check: "Paused", status: paused ? "warn" : "pass", actual: String(paused) })
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Paused", status: "fail", message: e.message?.slice(0, 120) })
	}

	// Admin roles on SymmioLiquidator
	console.log("")
	console.log(`   ${c.dim}-- Roles on SymmioLiquidator --${c.reset}`)
	if (addresses.admin) {
		await checkOzDefaultAdminRole(results, cat, liquidator, addresses.admin, "fail", "SymmioLiquidator")
		await checkRole(results, cat, liquidator, addresses.admin, "MANAGER_ROLE", ethers, { ozStyle: true, contractLabel: "SymmioLiquidator" })
	} else {
		pushAndLog(results, {
			category: cat,
			check: "Admin roles",
			status: "warn",
			message: "No admin address provided, skipping role checks",
			hint: "Re-run with --admin <address> to verify role assignments",
		})
	}

	if (addresses.operators && addresses.operators.length > 0) {
		for (const op of addresses.operators) {
			await checkRole(results, cat, liquidator, op, "OPERATOR_ROLE", ethers, { ozStyle: true, contractLabel: "SymmioLiquidator" })
		}
	}

	// LIQUIDATOR_ROLE + PARTYB_LIQUIDATOR_ROLE on core
	if (addresses.diamond) {
		console.log("")
		console.log(`   ${c.dim}-- Core roles granted to SymmioLiquidator --${c.reset}`)
		try {
			const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
			await checkRole(results, cat, view, liquidatorAddress, "LIQUIDATOR_ROLE", ethers, { contractLabel: "Diamond ControlFacet" })
			await checkRole(results, cat, view, liquidatorAddress, "PARTYB_LIQUIDATOR_ROLE", ethers, { contractLabel: "Diamond ControlFacet" })
		} catch (e: any) {
			pushAndLog(results, { category: cat, check: "Core role check", status: "fail", message: e.message?.slice(0, 120) })
		}
	}

	// Hardcoded liquidation selectors
	console.log("")
	console.log(`   ${c.dim}-- Allowed selectors --${c.reset}`)
	const partyA = await ethers.getContractAt("IPartyALiquidationFacet", ethers.ZeroAddress)
	const partyASnapshot = await ethers.getContractAt("IPartyALiquidationSnapshotFacet", ethers.ZeroAddress)
	const partyB = await ethers.getContractAt("IPartyBLiquidationFacet", ethers.ZeroAddress)
	const expected: Array<[string, string]> = [
		["liquidatePartyA", partyA.interface.getFunction("liquidatePartyA").selector],
		["setSymbolsPrice", partyA.interface.getFunction("setSymbolsPrice").selector],
		["liquidatePartyAWithSnapshot", partyASnapshot.interface.getFunction("liquidatePartyAWithSnapshot").selector],
		["singleStepLiquidatePartyAWithSnapshot", partyASnapshot.interface.getFunction("singleStepLiquidatePartyAWithSnapshot").selector],
		["deferredLiquidatePartyA", partyA.interface.getFunction("deferredLiquidatePartyA").selector],
		["deferredSetSymbolsPrice", partyA.interface.getFunction("deferredSetSymbolsPrice").selector],
		["liquidatePendingPositionsPartyA", partyA.interface.getFunction("liquidatePendingPositionsPartyA").selector],
		["liquidatePositionsPartyA", partyA.interface.getFunction("liquidatePositionsPartyA").selector],
		["settlePartyALiquidation", partyA.interface.getFunction("settlePartyALiquidation").selector],
		["liquidatePartyB", partyB.interface.getFunction("liquidatePartyB").selector],
		["liquidatePositionsPartyB", partyB.interface.getFunction("liquidatePositionsPartyB").selector],
	]
	for (const [name, selector] of expected) {
		await checkBool(
			results,
			cat,
			`${name} allowed`,
			() => liquidator.allowedSelectors(selector),
			true,
			"fail",
			`Call SymmioLiquidator.setAllowedSelector(${selector}, true)`,
		)
	}
}

// ============================================================================
// Address loading helpers
// ============================================================================

function loadAddressesFromCheckpoint(checkpoint: any, existing: any) {
	return {
		diamond: existing.diamond || checkpoint.contracts?.diamond?.diamond?.address,
		accountLayer: existing.accountLayer || checkpoint.contracts?.accountLayerDiamond?.diamond?.address,
		instantLayer: existing.instantLayer || checkpoint.contracts?.instantLayer?.address,
		partyB: existing.partyB || checkpoint.contracts?.symmioPartyB?.address,
		symbolManager: existing.symbolManager || checkpoint.contracts?.symbolManager?.address,
		liquidator: existing.liquidator || checkpoint.contracts?.symmioLiquidator?.address,
		collateral: existing.collateral || checkpoint.contracts?.collateral?.address,
		signatureVerifier: existing.signatureVerifier || checkpoint.contracts?.signatureVerifier?.address,
		admin: existing.admin,
		symmioFeeReceiver: existing.symmioFeeReceiver,
		symbolManagerOperator: existing.symbolManagerOperator,
	}
}

function loadAddressesFromReport(report: any, existing: any) {
	return {
		diamond: existing.diamond || report.addresses?.diamond,
		accountLayer: existing.accountLayer || report.addresses?.accountLayerDiamond,
		instantLayer: existing.instantLayer || report.addresses?.instantLayer,
		partyB: existing.partyB || report.addresses?.symmioPartyB,
		symbolManager: existing.symbolManager || report.addresses?.symbolManager,
		liquidator: existing.liquidator || report.addresses?.symmioLiquidator,
		collateral: existing.collateral || report.addresses?.collateral,
		signatureVerifier: existing.signatureVerifier || report.addresses?.signatureVerifier,
		admin: existing.admin || report.config?.admin,
		symmioFeeReceiver: existing.symmioFeeReceiver || report.config?.symmioFeeReceiver,
		symbolManagerOperator: existing.symbolManagerOperator || report.config?.symbolManagerOperator,
	}
}

// ============================================================================
// Main check:deployment task
// ============================================================================

export const checkDeploymentTask = task("check:deployment", "Checks deployment health and configuration")
	.addOption({
		name: "diamond",
		description: "Diamond (Symmio Core) address",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "accountLayer",
		description: "AccountLayer Diamond address",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "instantLayer",
		description: "InstantLayer address",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "partyB",
		description: "SymmioPartyB address (optional, can pass multiple comma-separated)",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "symbolManager",
		description: "SymmioSymbolManager address (optional)",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "symbolManagerOperator",
		description: "Expected SymbolManager operator address",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "liquidator",
		description: "SymmioLiquidator address (optional)",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "operators",
		description: "SymmioLiquidator operator addresses (comma-separated, optional)",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "collateral",
		description: "Collateral token address",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "admin",
		description: "Expected admin address",
		type: ArgumentType.STRING,
		defaultValue: "",
	})
	.addOption({
		name: "fromCheckpoint",
		description: "Load addresses from latest checkpoint",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.addOption({
		name: "fromReport",
		description: "Load addresses from deployment-report.json",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.addOption({
		name: "allowPendingOwnership",
		description: "Allow only owner=deployer and pendingOwner=admin during the automated handover checkpoint",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.addOption({
		name: "allowPendingAdminActions",
		description: "Allow only configured SymbolManager operator roles to remain pending for admin execution",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.setAction(async () => ({
		default: async (args: any, hre: any) => {
			const connection = await getConnection(hre)
			const { ethers } = connection
			const chainId = (await ethers.provider.getNetwork()).chainId
			const isSimulatedNetwork = (connection as any).networkConfig?.type === "edr-simulated"
			setDataScope(chainId, { simulated: isSimulatedNetwork })
			const network = connection.networkName || "unknown"
			const protocolConfig = loadProtocolConfig(chainId)
			const [deployer] = await ethers.getSigners()
			let deployerAddress: string | undefined = deployer?.address

			// Convert empty strings to undefined for cleaner handling
			let addresses: {
				diamond?: string
				accountLayer?: string
				instantLayer?: string
				partyB?: string
				symbolManager?: string
				liquidator?: string
				collateral?: string
				signatureVerifier?: string
				admin?: string
				symmioFeeReceiver?: string
				symbolManagerOperator?: string
			} = {
				diamond: args.diamond || undefined,
				accountLayer: args.accountLayer || undefined,
				instantLayer: args.instantLayer || undefined,
				partyB: args.partyB || undefined,
				symbolManager: args.symbolManager || undefined,
				liquidator: args.liquidator || undefined,
				collateral: args.collateral || undefined,
				signatureVerifier: undefined,
				admin: args.admin || undefined,
				symmioFeeReceiver: undefined,
				symbolManagerOperator: args.symbolManagerOperator || undefined,
			}
			let reportConfig: any = undefined
			const operators: string[] = args.operators
				? String(args.operators)
						.split(",")
						.map((a: string) => a.trim())
						.filter(Boolean)
				: []

			// Load from deployment report if requested
			if (args.fromReport) {
				const scopedReport = `${getDataDir()}/deployment-report.json`
				if (!fs.existsSync(scopedReport)) throw new Error(`Scoped deployment report not found: ${scopedReport}`)
				let report: any
				try {
					report = JSON.parse(fs.readFileSync(scopedReport, "utf8"))
				} catch (err) {
					throw new Error(`Failed to parse ${scopedReport}: ${err instanceof Error ? err.message : String(err)}`)
				}
				if (!report || typeof report !== "object" || !report.addresses || !report.config) {
					throw new Error(`${scopedReport} is malformed: expected addresses and config objects`)
				}
				for (const field of ["liquidationInsuranceVault", "softLiquidationPenaltyCollector"] as const) {
					const value = report.config[field]
					if (typeof value !== "string" || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
						throw new Error(`${scopedReport} config.${field} must be a valid non-zero address`)
					}
				}
				if (
					typeof report.config.maxLiquidationProfitPerPosition !== "string" ||
					!/^\d+$/.test(report.config.maxLiquidationProfitPerPosition) ||
					BigInt(report.config.maxLiquidationProfitPerPosition) <= BigInt(0) ||
					BigInt(report.config.maxLiquidationProfitPerPosition) > (BigInt(1) << BigInt(256)) - BigInt(1)
				) {
					throw new Error(`${scopedReport} config.maxLiquidationProfitPerPosition must be a positive uint string`)
				}
				if (!Number.isSafeInteger(report.chainId) || report.chainId !== Number(chainId)) {
					throw new Error(`${scopedReport} chainId mismatch: expected ${Number(chainId)}, got ${JSON.stringify(report.chainId)}`)
				}
				if (typeof report.deployerAddress !== "string" || !ethers.isAddress(report.deployerAddress)) {
					throw new Error(`${scopedReport} is missing a valid deployerAddress; rerun deploy:system to refresh the report`)
				}
				deployerAddress = ethers.getAddress(report.deployerAddress)
				addresses = loadAddressesFromReport(report, addresses)
				reportConfig = report.config
				console.log(`Loaded addresses from ${scopedReport}`)
			}

			// Load from checkpoint if requested
			if (args.fromCheckpoint) {
				const suffix = isSimulatedNetwork ? "-fork" : ""
				const checkpointPath = path.join("./tasks/data/checkpoints", `checkpoint-${chainId}${suffix}.json`)
				let checkpointLoaded = false

				if (!fs.existsSync(checkpointPath)) {
					// Try completed checkpoints
					const completedDir = path.join("./tasks/data/checkpoints", "completed")
					if (fs.existsSync(completedDir)) {
						const files = fs
							.readdirSync(completedDir)
							.filter((f: string) => f.startsWith(`checkpoint-${chainId}-`) && (isSimulatedNetwork ? f.includes("-fork-") : !f.includes("-fork-")))
							.sort((a, b) => fs.statSync(path.join(completedDir, b)).mtimeMs - fs.statSync(path.join(completedDir, a)).mtimeMs)
						if (files.length > 0) {
							const checkpoint = JSON.parse(fs.readFileSync(path.join(completedDir, files[0]), "utf8"))
							if (checkpoint.chainId !== Number(chainId)) {
								throw new Error(`Completed checkpoint ${files[0]} has chainId ${checkpoint.chainId}; expected ${Number(chainId)}`)
							}
							if (checkpoint.step !== "complete") {
								throw new Error(`Completed checkpoint ${files[0]} is not terminal: step=${JSON.stringify(checkpoint.step)}`)
							}
							addresses = loadAddressesFromCheckpoint(checkpoint, addresses)
							deployerAddress = checkpoint.deployerAddress || deployerAddress
							console.log(`Loaded addresses from completed checkpoint: ${files[0]}`)
							checkpointLoaded = true
						}
					}
				} else {
					const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"))
					if (checkpoint.chainId !== Number(chainId)) {
						throw new Error(`${checkpointPath} has chainId ${checkpoint.chainId}; expected ${Number(chainId)}`)
					}
					addresses = loadAddressesFromCheckpoint(checkpoint, addresses)
					deployerAddress = checkpoint.deployerAddress || deployerAddress
					console.log(`Loaded addresses from checkpoint-${chainId}.json`)
					checkpointLoaded = true
				}
				if (!checkpointLoaded) throw new Error(`No checkpoint found for ${network} (chainId ${chainId}, simulated=${isSimulatedNetwork})`)
			}

			if (!deployerAddress || !ethers.isAddress(deployerAddress)) {
				throw new Error(
					"Original deployer address is unavailable. Use --from-report with a current deployment report, or configure the original signer for a legacy record.",
				)
			}
			const originalDeployerAddress = ethers.getAddress(deployerAddress)

			// Validate required addresses
			if (!addresses.diamond) {
				throw new Error("Diamond address is required. Use --diamond, --from-report, or --from-checkpoint")
			}
			if (args.fromReport || args.fromCheckpoint) {
				const requiredFields = args.fromReport
					? (["accountLayer", "instantLayer", "collateral", "signatureVerifier", "admin", "symmioFeeReceiver"] as const)
					: (["accountLayer", "instantLayer", "collateral", "signatureVerifier"] as const)
				for (const field of requiredFields) {
					if (!addresses[field]) throw new Error(`${field} address is missing from the requested deployment source`)
				}
				if (
					args.fromReport &&
					(reportConfig?.partyBMode ? reportConfig.partyBMode !== "skip" : reportConfig?.deployPartyB === true) &&
					!addresses.partyB
				) {
					throw new Error("partyB address is missing from a report that declares deployPartyB=true")
				}
				if (
					args.fromReport &&
					(reportConfig?.symbolManagerMode ? reportConfig.symbolManagerMode !== "skip" : reportConfig?.deploySymbolManager === true) &&
					!addresses.symbolManager
				) {
					throw new Error("symbolManager address is missing from a report that declares deploySymbolManager=true")
				}
			}
			for (const [field, value] of Object.entries(addresses)) {
				if (value === undefined) continue
				if (field === "partyB") continue
				if (typeof value !== "string" || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
					throw new Error(`${field} must be a valid non-zero address; received ${JSON.stringify(value)}`)
				}
			}

			// Parse multiple PartyB addresses (comma-separated)
			const partyBAddresses: string[] = addresses.partyB
				? addresses.partyB
						.split(",")
						.map((a: string) => a.trim())
						.filter(Boolean)
				: []
			for (const [label, values] of [
				["PartyB", partyBAddresses],
				["operator", operators],
			] as const) {
				for (const value of values) {
					if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${label} address is invalid or zero: ${value}`)
				}
			}

			console.log("")
			console.log(`${c.bold}Deployment Health Check${c.reset}  ${c.dim}${network} (${chainId})${c.reset}`)
			console.log("")
			console.log(`${c.dim}  Diamond        ${c.reset}${addresses.diamond || `${c.dim}(not set)${c.reset}`}`)
			console.log(`${c.dim}  AccountLayer   ${c.reset}${addresses.accountLayer || `${c.dim}(not set)${c.reset}`}`)
			console.log(`${c.dim}  InstantLayer   ${c.reset}${addresses.instantLayer || `${c.dim}(not set)${c.reset}`}`)
			console.log(`${c.dim}  SymbolManager ${c.reset}${addresses.symbolManager || `${c.dim}(not set)${c.reset}`}`)
			if (addresses.symbolManager) {
				console.log(`${c.dim}  SM Operator   ${c.reset}${addresses.symbolManagerOperator || `${c.dim}(not set)${c.reset}`}`)
			}
			if (partyBAddresses.length > 0) {
				for (let i = 0; i < partyBAddresses.length; i++) {
					console.log(`${c.dim}  PartyB [${i}]     ${c.reset}${partyBAddresses[i]}`)
				}
			} else {
				console.log(`${c.dim}  PartyB         (not set)${c.reset}`)
			}
			console.log(`${c.dim}  Liquidator     ${c.reset}${addresses.liquidator || `${c.dim}(not set)${c.reset}`}`)
			if (operators.length > 0) {
				for (let i = 0; i < operators.length; i++) {
					console.log(`${c.dim}  Operator [${i}]   ${c.reset}${operators[i]}`)
				}
			}
			console.log(`${c.dim}  Collateral     ${c.reset}${addresses.collateral || `${c.dim}(not set)${c.reset}`}`)
			console.log(`${c.dim}  Admin          ${c.reset}${addresses.admin || `${c.dim}(not set)${c.reset}`}`)
			console.log("")

			const results: VerificationResult[] = []

			// ========================================
			// 1. Core Diamond Verification
			// ========================================
			console.log(`${c.bold}Core Diamond${c.reset}`)

			// Check contract exists
			const diamondCode = await ethers.provider.getCode(addresses.diamond)
			if (diamondCode === "0x") {
				pushAndLog(results, {
					category: "Core Diamond",
					check: "Contract exists",
					status: "fail",
					message: "No contract at address",
					hint: "Verify the Diamond address is correct, or run deploy:system to deploy",
				})
			} else {
				pushAndLog(results, { category: "Core Diamond", check: "Contract exists", status: "pass" })

				// Check facets
				try {
					const loupe = await ethers.getContractAt("IDiamondLoupe", addresses.diamond)
					const facets = await loupe.facets()
					const facetCount = facets.length

					if (facetCount === EXPECTED_CORE_FACETS) {
						pushAndLog(results, {
							category: "Core Diamond",
							check: "Facet count",
							status: "pass",
							expected: String(EXPECTED_CORE_FACETS),
							actual: String(facetCount),
						})
					} else {
						pushAndLog(results, {
							category: "Core Diamond",
							check: "Facet count",
							status: "fail",
							expected: String(EXPECTED_CORE_FACETS),
							actual: String(facetCount),
							hint: "Run deploy:diamond to add/remove facets via diamondCut. Expected " + EXPECTED_CORE_FACETS + " facets",
						})
					}
				} catch (e: any) {
					pushAndLog(results, { category: "Core Diamond", check: "Facet count", status: "fail", message: e.message?.slice(0, 120) })
				}
				await checkExactFacetSelectors(ethers, addresses.diamond, FacetNames, "Core Diamond", results)

				// Check solver-fee facet selectors are installed and the legacy no-affiliate sendQuote is removed (v0.8.6)
				try {
					const loupe = await ethers.getContractAt("IDiamondLoupe", addresses.diamond)
					const solverFeeInterface = (await ethers.getContractAt("IPartyBSolverFeeActionsFacet", ethers.ZeroAddress)).interface
					const missing: string[] = []
					for (const fragment of solverFeeInterface.fragments) {
						if (fragment.type !== "function") continue
						const fn = fragment as any
						if ((await loupe.facetAddress(fn.selector)) === ethers.ZeroAddress) {
							missing.push(fn.name)
						}
					}
					if (missing.length === 0) {
						pushAndLog(results, { category: "Core Diamond", check: "Solver-fee facet selectors", status: "pass" })
					} else {
						pushAndLog(results, {
							category: "Core Diamond",
							check: "Solver-fee facet selectors",
							status: "fail",
							message: `Missing fee-aware selectors: ${missing.join(", ")}`,
							hint: "Run deploy:diamond to add PartyBSolverFeeActionsFacet via diamondCut",
						})
					}

					const legacySendQuoteSelector = ethers
						.id(
							"sendQuote(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)))",
						)
						.slice(0, 10)
					if ((await loupe.facetAddress(legacySendQuoteSelector)) === ethers.ZeroAddress) {
						pushAndLog(results, { category: "Core Diamond", check: "Legacy no-affiliate sendQuote removed", status: "pass" })
					} else {
						pushAndLog(results, {
							category: "Core Diamond",
							check: "Legacy no-affiliate sendQuote removed",
							status: "warn",
							message: "Legacy no-affiliate sendQuote selector is still installed",
							hint: "v0.8.6 removes the no-affiliate sendQuote; run deploy:diamond to update PartyAFacet selectors",
						})
					}
				} catch (e: any) {
					pushAndLog(results, { category: "Core Diamond", check: "Solver-fee facet selectors", status: "fail", message: e.message?.slice(0, 120) })
				}

				// Check owner (and pending owner if transfer in progress)
				await checkDiamondOwner(
					ethers,
					addresses.diamond,
					"contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet",
					"Core Diamond",
					addresses.admin,
					results,
					{ allowPendingOwnership: args.allowPendingOwnership, deployerAddress: originalDeployerAddress },
				)

				// Check collateral
				await checkAddress(
					results,
					"Core Diamond",
					"Collateral",
					async () => {
						const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
						return view.getCollateral()
					},
					ethers,
					{ expected: addresses.collateral, hint: "Call ControlFacet.setCollateral(collateralAddress) on the Core Diamond" },
				)

				// System parameters, oracle, pause state
				await verifyCoreSystemParameters(ethers, addresses.diamond, results, protocolConfig, {
					admin: addresses.admin,
					symmioFeeReceiver: addresses.symmioFeeReceiver,
					liquidationInsuranceVault: reportConfig?.liquidationInsuranceVault,
					maxLiquidationProfitPerPosition: reportConfig?.maxLiquidationProfitPerPosition,
					softLiquidationPenaltyCollector: reportConfig?.softLiquidationPenaltyCollector,
					signatureVerifier: addresses.signatureVerifier,
					muonAppId: reportConfig?.muonAppId,
					muonUpnlValidTime: reportConfig?.muonUpnlValidTime,
					muonPriceValidTime: reportConfig?.muonPriceValidTime,
				})

				// Roles
				await verifyCoreRoles(ethers, addresses.diamond, addresses, results, originalDeployerAddress)
			}
			console.log("")

			// The core merely stores a verifier address. A healthy deployment must also
			// prove the verifier's role handoff, registered identities, and all category
			// authorizations recorded in the scoped deployment report.
			if (addresses.signatureVerifier) {
				await verifyMuonSignatureVerifier(
					ethers,
					addresses.signatureVerifier,
					results,
					reportConfig
						? {
								deployMockVerifier: reportConfig.deployMockVerifier,
								admin: addresses.admin,
								muonPublicKeyX: reportConfig.muonPublicKeyX,
								muonPublicKeyParity: reportConfig.muonPublicKeyParity,
								muonGatewaySigners: reportConfig.muonGatewaySigners,
								muonFunctionPermissions: reportConfig.muonFunctionPermissions,
							}
						: null,
					originalDeployerAddress,
				)
				console.log("")
			}

			// ========================================
			// 2. AccountLayer Diamond Verification
			// ========================================
			if (addresses.accountLayer) {
				console.log(`${c.bold}AccountLayer Diamond${c.reset}`)

				const alCode = await ethers.provider.getCode(addresses.accountLayer)
				if (alCode === "0x") {
					pushAndLog(results, {
						category: "AccountLayer",
						check: "Contract exists",
						status: "fail",
						message: "No contract at address",
						hint: "Verify the AccountLayer address is correct, or run deploy:system to deploy",
					})
				} else {
					pushAndLog(results, { category: "AccountLayer", check: "Contract exists", status: "pass" })
					await verifyAccountLayerFull(ethers, addresses.accountLayer, addresses, results, {
						allowPendingOwnership: args.allowPendingOwnership,
						deployerAddress: originalDeployerAddress,
					})
				}
				console.log("")
			}

			// ========================================
			// 3. InstantLayer Verification
			// ========================================
			if (addresses.instantLayer) {
				console.log(`${c.bold}InstantLayer${c.reset}`)

				const ilCode = await ethers.provider.getCode(addresses.instantLayer)
				if (ilCode === "0x") {
					pushAndLog(results, {
						category: "InstantLayer",
						check: "Contract exists",
						status: "fail",
						message: "No contract at address",
						hint: "Verify the InstantLayer address is correct, or run deploy:system to deploy",
					})
				} else {
					pushAndLog(results, { category: "InstantLayer", check: "Contract exists", status: "pass" })
					await verifyInstantLayerFull(ethers, addresses.instantLayer, addresses, results, protocolConfig, partyBAddresses, originalDeployerAddress)
				}
				console.log("")
			}

			// ========================================
			// 4. PartyB Verification (supports multiple)
			// ========================================
			for (let i = 0; i < partyBAddresses.length; i++) {
				const pbAddr = partyBAddresses[i]
				console.log(`${c.bold}PartyB${partyBAddresses.length > 1 ? ` [${i}]` : ""}${c.reset}  ${c.dim}${pbAddr}${c.reset}`)

				const pbCode = await ethers.provider.getCode(pbAddr)
				if (pbCode === "0x") {
					pushAndLog(results, {
						category: `PartyB[${i}]`,
						check: "Contract exists",
						status: "fail",
						message: "No contract at address",
						hint: "Verify the PartyB address is correct, or run deploy:system to deploy",
					})
				} else {
					pushAndLog(results, { category: `PartyB[${i}]`, check: "Contract exists", status: "pass" })
					await verifyPartyBFull(ethers, pbAddr, addresses, results, originalDeployerAddress)
				}
				console.log("")
			}

			// ========================================
			// 5. SymbolManager Verification
			// ========================================
			if (addresses.symbolManager) {
				console.log(`${c.bold}SymbolManager${c.reset}  ${c.dim}${addresses.symbolManager}${c.reset}`)
				const symbolManagerCode = await ethers.provider.getCode(addresses.symbolManager)
				if (symbolManagerCode === "0x") {
					pushAndLog(results, {
						category: "SymbolManager",
						check: "Contract exists",
						status: "fail",
						message: "No contract at address",
						hint: "Verify the SymbolManager address or run deploy:system",
					})
				} else {
					pushAndLog(results, { category: "SymbolManager", check: "Contract exists", status: "pass" })
					await verifySymbolManagerFull(ethers, addresses.symbolManager, addresses, results, originalDeployerAddress, args.allowPendingAdminActions)
				}
				console.log("")
			}

			// ========================================
			// 6. SymmioLiquidator Verification
			// ========================================
			if (addresses.liquidator) {
				console.log(`${c.bold}SymmioLiquidator${c.reset}  ${c.dim}${addresses.liquidator}${c.reset}`)

				const liqCode = await ethers.provider.getCode(addresses.liquidator)
				if (liqCode === "0x") {
					pushAndLog(results, {
						category: "Liquidator",
						check: "Contract exists",
						status: "fail",
						message: "No contract at address",
						hint: "Verify the SymmioLiquidator address is correct, or run scripts/deployLiquidator.ts",
					})
				} else {
					pushAndLog(results, { category: "Liquidator", check: "Contract exists", status: "pass" })
					await verifyLiquidatorFull(ethers, addresses.liquidator, { ...addresses, operators }, results)
				}
				console.log("")
			}

			// ========================================
			// Summary
			// ========================================
			const passed = results.filter(r => r.status === "pass").length
			const failed = results.filter(r => r.status === "fail").length
			const warnings = results.filter(r => r.status === "warn").length

			console.log(`${c.dim}${"─".repeat(60)}${c.reset}`)
			console.log(
				`  ${c.green}${passed} passed${c.reset}  ${failed > 0 ? `${c.red}${failed} failed${c.reset}` : `${c.dim}0 failed${c.reset}`}  ${warnings > 0 ? `${c.yellow}${warnings} warnings${c.reset}` : `${c.dim}0 warnings${c.reset}`}  ${c.dim}(${results.length} total)${c.reset}`,
			)

			if (failed > 0) {
				console.log("")
				for (const r of results.filter(r => r.status === "fail")) {
					const detail = r.message || (r.expected && r.actual ? `expected ${r.expected}, got ${r.actual}` : "")
					console.log(`  ${c.red}\u2717 ${r.category} \u203A ${r.check}${detail ? `  ${c.dim}${detail}` : ""}${c.reset}`)
				}
			}

			if (warnings > 0) {
				console.log("")
				for (const r of results.filter(r => r.status === "warn")) {
					const detail = r.message || (r.expected && r.actual ? `expected ${r.expected}, got ${r.actual}` : "")
					console.log(`  ${c.yellow}\u26A0 ${r.category} \u203A ${r.check}${detail ? `  ${c.dim}${detail}` : ""}${c.reset}`)
				}
			}

			console.log("")
			if (failed === 0 && warnings === 0) {
				console.log(`${c.green}${c.bold}  \u2713 All checks passed${c.reset}`)
			} else if (failed === 0) {
				console.log(`${c.yellow}${c.bold}  \u26A0 Passed with ${warnings} warning${warnings > 1 ? "s" : ""}${c.reset}`)
			} else {
				console.log(`${c.red}${c.bold}  \u2717 ${failed} check${failed > 1 ? "s" : ""} failed${c.reset}`)
			}
			console.log("")

			// Exit non-zero when checks failed. Previously this reported failures via
			// console.error and still exited 0, so a broken deployment looked healthy to
			// any script or CI job that checked only the status code.
			if (failed > 0) {
				throw new Error(`Deployment health check failed: ${failed} check${failed > 1 ? "s" : ""} did not pass — see the report above.`)
			}

			return { results, passed, failed, warnings }
		},
	}))
	.build()
