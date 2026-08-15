import { Contract, Interface, ZeroAddress, formatEther, getAddress, keccak256, toUtf8Bytes, type Provider } from "ethers"
import hre from "hardhat"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { loadDeploymentRecipe } from "../deployment/recipe.js"
import { ledgerAddressFromOutput, ledgerArguments, ledgerCandidatePaths, receiptHash } from "./utils/ledgerHandover.js"
import { resolveHttpRpcUrl } from "./utils/resolveHttpRpcUrl.js"

const CHAIN_ID = 42161n
const MAX_BLOCK_AGE_SECONDS = 300
const ADMIN_ACTION_CONFIRMATION = "EXECUTE ARBITRUM HANDOVER"
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url))
const RECIPE_PATH = fileURLToPath(new URL("../deployments/arbitrum.json", import.meta.url))
const REPORT_PATH = fileURLToPath(new URL("../tasks/data/42161/deployment-report.json", import.meta.url))
const CHECKPOINT_PATH = fileURLToPath(new URL("../tasks/data/checkpoints/checkpoint-42161.json", import.meta.url))
const LEDGER_CACHE_PATH = fileURLToPath(new URL("../.ledger-handover-cache.json", import.meta.url))
const DEFAULT_LEDGER_SCAN_COUNT = 100

interface DeploymentReport {
	deploymentId: string
	chainId: number
	network: string
	lifecycle: string
	deployerAddress: string
	checks?: { health?: string; healthError?: string; verification?: string }
	recipe?: { name?: string; digest?: string }
	config?: { admin?: string; symbolManagerOperator?: string }
	addresses?: {
		diamond?: string
		accountLayerDiamond?: string
		symbolManager?: string
		expressProvider?: string
	}
	ownershipHandover?: { targets?: Array<{ label?: string; address?: string; owner?: string; pendingOwner?: string }> }
	manualActions?: string[]
}

interface DeploymentCheckpoint {
	deploymentId?: string
	step?: string
	transactions?: Array<{ status?: string; hash?: string; label?: string }>
}

interface HandoverAction {
	label: string
	to: string
	data: string
	isComplete: () => Promise<boolean>
}

interface DeploymentContext {
	admin: string
	operator: string
	deployer: string
	core: string
	accountLayer: string
	symbolManager: string
	expressProvider: string
}

interface LedgerPathCache {
	version: 1
	accounts: Record<string, { address: string; path: string; updatedAt: string }>
}

function fail(message: string): never {
	throw new Error(message)
}

function readJson<T>(path: string, label: string): T {
	if (!fs.existsSync(path)) fail(`${label} is missing: ${path}`)
	try {
		return JSON.parse(fs.readFileSync(path, "utf8")) as T
	} catch (error) {
		fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function address(value: unknown, label: string): string {
	if (typeof value !== "string") fail(`${label} is missing`)
	try {
		return getAddress(value)
	} catch {
		fail(`${label} is not a valid address`)
	}
}

function sameAddress(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase()
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	return message.replace(/(?:https?|wss?):\/\/[^\s'"`<>]+/giu, "<redacted-rpc-url>")
}

function requireManualAction(report: DeploymentReport, expected: string): void {
	if (!report.manualActions?.includes(expected)) fail(`deployment report is not authorizing the expected action: ${expected}`)
}

function loadAndValidateDeployment(expectedLedgerAddress: string): DeploymentContext {
	const loaded = loadDeploymentRecipe(RECIPE_PATH, { projectRoot: PROJECT_ROOT })
	const report = readJson<DeploymentReport>(REPORT_PATH, "Arbitrum deployment report")
	const checkpoint = fs.existsSync(CHECKPOINT_PATH) ? readJson<DeploymentCheckpoint>(CHECKPOINT_PATH, "Arbitrum deployment checkpoint") : null

	if (loaded.recipe.network.name !== "arbitrum" || loaded.recipe.network.chainId !== Number(CHAIN_ID) || loaded.recipe.network.mode !== "live") {
		fail("deployments/arbitrum.json is not bound to live Arbitrum One (chainId 42161)")
	}
	if (report.chainId !== Number(CHAIN_ID) || report.network !== "arbitrum") fail("deployment report is not for Arbitrum One")
	if (report.recipe?.name !== loaded.recipe.name || report.recipe?.digest !== loaded.digest) {
		fail("deployment report is not bound to the current deployments/arbitrum.json digest")
	}
	if (report.lifecycle === "complete") {
		if (checkpoint) fail("deployment report is complete but an active Arbitrum checkpoint still exists")
	} else {
		if (!checkpoint) fail(`deployment report lifecycle is ${report.lifecycle}, but the active Arbitrum checkpoint is missing`)
		if (checkpoint.deploymentId !== report.deploymentId) fail("deployment report and active checkpoint have different deployment IDs")
		if (checkpoint.step !== "pending_handover") fail(`active checkpoint step is ${String(checkpoint.step)}; expected pending_handover`)
		const unresolved = checkpoint.transactions?.filter(transaction => transaction.status !== "confirmed") ?? []
		if (unresolved.length > 0) fail(`active checkpoint has ${unresolved.length} deployment transaction(s) without confirmed receipts`)
		if (report.lifecycle !== "pending_handover" && !(report.lifecycle === "failed" && report.checks?.health === "failed")) {
			fail(`deployment report lifecycle is ${report.lifecycle}; expected pending_handover or the recorded pending-handover health failure`)
		}
	}

	const admin = address(loaded.recipe.governance.admin, "recipe governance.admin")
	const operator = address(loaded.recipe.symbolManager.operator, "recipe symbolManager.operator")
	const deployer = address(report.deployerAddress, "deployment report deployerAddress")
	const core = address(report.addresses?.diamond, "deployment report Core Diamond")
	const accountLayer = address(report.addresses?.accountLayerDiamond, "deployment report AccountLayer Diamond")
	const symbolManager = address(report.addresses?.symbolManager, "deployment report SymbolManager")
	const expressProvider = address(report.addresses?.expressProvider, "deployment report ExpressProvider")
	if (!sameAddress(expectedLedgerAddress, admin)) {
		fail(`expected Ledger address ${expectedLedgerAddress} does not match recipe admin ${admin}`)
	}

	if (!sameAddress(address(report.config?.admin, "deployment report admin"), admin)) fail("deployment report admin does not match the recipe")
	if (!sameAddress(address(report.config?.symbolManagerOperator, "deployment report SymbolManager operator"), operator)) {
		fail("deployment report SymbolManager operator does not match the recipe")
	}

	if (report.lifecycle !== "complete") {
		const acceptData = "0x79ba5097"
		const registerData = new Interface(["function registerExpressProvider(address provider)"]).encodeFunctionData("registerExpressProvider", [
			expressProvider,
		])
		requireManualAction(report, `${admin} calls acceptOwnership() on Diamond ${core}`)
		requireManualAction(report, `${admin} calls acceptOwnership() on AccountLayerDiamond ${accountLayer}`)
		requireManualAction(report, `${admin} grants SYMBOL_ADDER_ROLE, SYMBOL_REMOVER_ROLE on SymbolManager ${symbolManager} to ${operator}`)
		requireManualAction(report, `${admin} executes: Register ExpressProvider ${expressProvider} on core (to ${core}, data ${registerData})`)
		requireManualAction(
			report,
			`${admin} executes: Accept ExpressProvider ownership at ${expressProvider} (to ${expressProvider}, data ${acceptData})`,
		)
	}

	return { admin, operator, deployer, core, accountLayer, symbolManager, expressProvider }
}

function assertOwnershipState(label: string, owner: string, pendingOwner: string, admin: string, expectedCurrentOwner: string): boolean {
	if (sameAddress(owner, admin)) {
		if (!sameAddress(pendingOwner, ZeroAddress)) fail(`${label} is owned by the admin but still has unexpected pendingOwner ${pendingOwner}`)
		return true
	}
	if (!sameAddress(owner, expectedCurrentOwner) || !sameAddress(pendingOwner, admin)) {
		fail(`${label} ownership is unsafe: owner=${owner}, pendingOwner=${pendingOwner}`)
	}
	return false
}

async function requireRuntimeCode(provider: Provider, targets: Array<{ label: string; address: string }>): Promise<void> {
	for (const target of targets) {
		if ((await provider.getCode(target.address)) === "0x") fail(`${target.label} ${target.address} has no runtime bytecode`)
	}
}

async function buildActions(provider: Provider, context: DeploymentContext): Promise<HandoverAction[]> {
	const ownershipAbi = ["function getOwner() view returns (address)", "function pendingOwner() view returns (address)"]
	const expressOwnershipAbi = ["function owner() view returns (address)", "function pendingOwner() view returns (address)"]
	const symbolManagerAbi = [
		"function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
		"function SYMBOL_ADDER_ROLE() view returns (bytes32)",
		"function SYMBOL_REMOVER_ROLE() view returns (bytes32)",
		"function hasRole(bytes32 role, address account) view returns (bool)",
	]
	const coreViewAbi = [
		"function isExpressProviderRegistered(address provider) view returns (bool)",
		"function isVirtualProviderRegistered(address provider) view returns (bool)",
	]
	const coreOwnership = new Contract(context.core, ownershipAbi, provider)
	const accountOwnership = new Contract(context.accountLayer, ownershipAbi, provider)
	const expressOwnership = new Contract(context.expressProvider, expressOwnershipAbi, provider)
	const symbolManager = new Contract(context.symbolManager, symbolManagerAbi, provider)
	const coreView = new Contract(context.core, coreViewAbi, provider)
	const ownershipInterface = new Interface(["function acceptOwnership()"])
	const roleInterface = new Interface(["function grantRole(bytes32 role, address account)"])
	const coreControlInterface = new Interface(["function registerExpressProvider(address provider)"])
	const acceptOwnershipData = ownershipInterface.encodeFunctionData("acceptOwnership")
	const expectedAdderRole = keccak256(toUtf8Bytes("SYMBOL_ADDER_ROLE"))
	const expectedRemoverRole = keccak256(toUtf8Bytes("SYMBOL_REMOVER_ROLE"))
	const [defaultAdminRole, adderRole, removerRole] = await Promise.all([
		symbolManager.DEFAULT_ADMIN_ROLE(),
		symbolManager.SYMBOL_ADDER_ROLE(),
		symbolManager.SYMBOL_REMOVER_ROLE(),
	])
	if (defaultAdminRole !== `0x${"00".repeat(32)}`) fail(`SymbolManager returned unexpected DEFAULT_ADMIN_ROLE ${defaultAdminRole}`)
	if (adderRole !== expectedAdderRole || removerRole !== expectedRemoverRole)
		fail("SymbolManager role constants do not match the reviewed role names")

	const adminHasSymbolManagerAuthority = async (): Promise<boolean> => Boolean(await symbolManager.hasRole(defaultAdminRole, context.admin))
	const roleAction = (label: string, role: string): HandoverAction => ({
		label,
		to: context.symbolManager,
		data: roleInterface.encodeFunctionData("grantRole", [role, context.operator]),
		isComplete: async () => Boolean(await symbolManager.hasRole(role, context.operator)),
	})

	const actions: HandoverAction[] = [
		{
			label: "Accept Core Diamond ownership",
			to: context.core,
			data: acceptOwnershipData,
			isComplete: async () =>
				assertOwnershipState(
					"Core Diamond",
					address(await coreOwnership.getOwner(), "Core owner"),
					address(await coreOwnership.pendingOwner(), "Core pending owner"),
					context.admin,
					context.deployer,
				),
		},
		{
			label: "Accept AccountLayer Diamond ownership",
			to: context.accountLayer,
			data: acceptOwnershipData,
			isComplete: async () =>
				assertOwnershipState(
					"AccountLayer Diamond",
					address(await accountOwnership.getOwner(), "AccountLayer owner"),
					address(await accountOwnership.pendingOwner(), "AccountLayer pending owner"),
					context.admin,
					context.deployer,
				),
		},
		roleAction("Grant SymbolManager SYMBOL_ADDER_ROLE", adderRole),
		roleAction("Grant SymbolManager SYMBOL_REMOVER_ROLE", removerRole),
		{
			label: "Register ExpressProvider on Core",
			to: context.core,
			data: coreControlInterface.encodeFunctionData("registerExpressProvider", [context.expressProvider]),
			isComplete: async () => {
				if (await coreView.isVirtualProviderRegistered(context.expressProvider)) {
					fail("ExpressProvider is unexpectedly registered as a VirtualProvider; refusing to continue")
				}
				return Boolean(await coreView.isExpressProviderRegistered(context.expressProvider))
			},
		},
		{
			label: "Accept ExpressProvider ownership",
			to: context.expressProvider,
			data: acceptOwnershipData,
			isComplete: async () =>
				assertOwnershipState(
					"ExpressProvider",
					address(await expressOwnership.owner(), "ExpressProvider owner"),
					address(await expressOwnership.pendingOwner(), "ExpressProvider pending owner"),
					context.admin,
					context.deployer,
				),
		},
	]

	for (const action of actions.slice(2, 4)) {
		if (!(await action.isComplete()) && !(await adminHasSymbolManagerAuthority())) {
			fail(`admin ${context.admin} does not hold SymbolManager DEFAULT_ADMIN_ROLE required for ${action.label}`)
		}
	}
	return actions
}

function runCast(castBin: string, args: string[], environment: NodeJS.ProcessEnv): string {
	const result = spawnSync(castBin, args, {
		encoding: "utf8",
		env: environment,
		stdio: ["inherit", "pipe", "pipe"],
	})
	const stderr = safeError(result.stderr ?? "").trim()
	if (stderr) console.error(stderr)
	if (result.error) fail(`failed to start cast: ${safeError(result.error)}`)
	if (result.status !== 0) fail(`cast exited with status ${String(result.status)}`)
	return result.stdout ?? ""
}

function ledgerAddress(castBin: string, environment: NodeJS.ProcessEnv, derivationPath: string): string {
	const walletEnvironment = { ...environment }
	delete walletEnvironment.ETH_FROM
	const output = runCast(castBin, ["wallet", "address", ...ledgerArguments(derivationPath)], walletEnvironment)
	return ledgerAddressFromOutput(output, derivationPath)
}

function ledgerScanCount(): number {
	const raw = process.env.LEDGER_SCAN_COUNT ?? String(DEFAULT_LEDGER_SCAN_COUNT)
	if (!/^\d+$/u.test(raw)) fail(`LEDGER_SCAN_COUNT must be a whole number; received ${JSON.stringify(raw)}`)
	const count = Number(raw)
	if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) fail("LEDGER_SCAN_COUNT must be between 1 and 1000")
	return count
}

function readCachedLedgerPath(expectedAddress: string): string | null {
	if (!fs.existsSync(LEDGER_CACHE_PATH)) return null
	try {
		const cache = readJson<LedgerPathCache>(LEDGER_CACHE_PATH, "Ledger handover path cache")
		const cached = cache.version === 1 ? cache.accounts?.[expectedAddress.toLowerCase()] : undefined
		if (cached && sameAddress(address(cached.address, "cached Ledger address"), expectedAddress) && typeof cached.path === "string") {
			return cached.path
		}
	} catch {
		return null
	}
	return null
}

function writeCachedLedgerPath(expectedAddress: string, derivationPath: string): void {
	let cache: LedgerPathCache = { version: 1, accounts: {} }
	if (fs.existsSync(LEDGER_CACHE_PATH)) {
		try {
			const existing = readJson<LedgerPathCache>(LEDGER_CACHE_PATH, "Ledger handover path cache")
			if (existing.version === 1 && existing.accounts && typeof existing.accounts === "object") cache = existing
		} catch {
			cache = { version: 1, accounts: {} }
		}
	}
	cache.accounts[expectedAddress.toLowerCase()] = {
		address: expectedAddress,
		path: derivationPath,
		updatedAt: new Date().toISOString(),
	}
	const temporaryPath = `${LEDGER_CACHE_PATH}.tmp-${process.pid}`
	fs.writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
	fs.renameSync(temporaryPath, LEDGER_CACHE_PATH)
}

function discoverLedgerPath(castBin: string, environment: NodeJS.ProcessEnv, expectedAddress: string): string {
	const cachedPath = readCachedLedgerPath(expectedAddress)
	if (cachedPath) {
		console.log(`Checking cached Ledger derivation path ${cachedPath}...`)
		const cachedAddress = ledgerAddress(castBin, environment, cachedPath)
		if (sameAddress(cachedAddress, expectedAddress)) {
			console.log(`PASS cached path resolves to ${cachedAddress}`)
			return cachedPath
		}
		console.warn(`Cached path resolved to ${cachedAddress}; scanning the connected Ledger again.`)
	}

	const scanCount = ledgerScanCount()
	const candidates = ledgerCandidatePaths(scanCount)
	console.log(`Scanning ${candidates.length} standard Ledger Ethereum paths for ${expectedAddress}...`)
	for (const [index, derivationPath] of candidates.entries()) {
		if (index === 0 || (index + 1) % 10 === 0) console.log(`  checked ${index}/${candidates.length}; trying ${derivationPath}`)
		const candidateAddress = ledgerAddress(castBin, environment, derivationPath)
		if (!sameAddress(candidateAddress, expectedAddress)) continue
		writeCachedLedgerPath(expectedAddress, derivationPath)
		console.log(`PASS Ledger address matched at ${derivationPath}: ${candidateAddress}`)
		return derivationPath
	}
	fail(
		`expected Ledger address ${expectedAddress} was not found across ${candidates.length} paths; ` +
			`increase LEDGER_SCAN_COUNT above ${scanCount} if this is a later account`,
	)
}

async function waitForCompletion(action: HandoverAction): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt++) {
		if (await action.isComplete()) return
		await new Promise(resolve => setTimeout(resolve, 2_000))
	}
	fail(`${action.label} receipt was mined, but the expected on-chain post-state was not visible after 60 seconds`)
}

async function confirmation(): Promise<string> {
	const { createInterface } = await import("node:readline/promises")
	const prompt = createInterface({ input: process.stdin, output: process.stdout })
	try {
		return (await prompt.question(`Type ${ADMIN_ACTION_CONFIRMATION} to submit these transactions: `)).trim()
	} finally {
		prompt.close()
	}
}

function confirmationCount(): number {
	const raw = process.env.HANDOVER_CONFIRMATIONS ?? "1"
	if (!/^\d+$/u.test(raw)) fail(`HANDOVER_CONFIRMATIONS must be a whole number; received ${JSON.stringify(raw)}`)
	const count = Number(raw)
	if (!Number.isSafeInteger(count) || count < 1 || count > 20) fail("HANDOVER_CONFIRMATIONS must be between 1 and 20")
	return count
}

async function main(): Promise<void> {
	const mode = process.env.HANDOVER_MODE ?? "execute"
	if (mode !== "execute" && mode !== "check") fail(`HANDOVER_MODE must be execute or check; received ${JSON.stringify(mode)}`)
	const expectedLedgerAddress = address(process.env.EXPECTED_LEDGER_ADDRESS, "expected Ledger address argument")
	const context = loadAndValidateDeployment(expectedLedgerAddress)
	const connection = await hre.network.getOrCreate()
	const { ethers } = connection
	const provider = ethers.provider
	const network = await provider.getNetwork()
	if (network.chainId !== CHAIN_ID) fail(`wrong chain: expected Arbitrum One (${CHAIN_ID}), received chainId ${network.chainId}`)
	const latest = await provider.getBlock("latest")
	if (!latest) fail("RPC did not return the latest Arbitrum block")
	const blockAge = Math.floor(Date.now() / 1000) - latest.timestamp
	if (blockAge < -60 || blockAge > MAX_BLOCK_AGE_SECONDS) fail(`latest Arbitrum block ${latest.number} has unsafe age ${blockAge}s`)

	await requireRuntimeCode(provider, [
		{ label: "Core Diamond", address: context.core },
		{ label: "AccountLayer Diamond", address: context.accountLayer },
		{ label: "SymbolManager", address: context.symbolManager },
		{ label: "ExpressProvider", address: context.expressProvider },
	])
	const actions = await buildActions(provider, context)
	const pending: Array<{ action: HandoverAction; gas: bigint }> = []
	console.log(`\nArbitrum handover deployment ${readJson<DeploymentReport>(REPORT_PATH, "deployment report").deploymentId}`)
	console.log(`Admin Ledger address: ${context.admin}`)
	console.log("Items 6 and 7 in the CLI are post-state checks, not additional transactions.\n")
	for (const action of actions) {
		if (await action.isComplete()) {
			console.log(`  SKIP  ${action.label} (already complete)`)
			continue
		}
		try {
			const gas = await provider.estimateGas({ from: context.admin, to: action.to, data: action.data })
			pending.push({ action, gas })
			console.log(`  READY ${action.label}`)
			console.log(`        to=${action.to} selector=${action.data.slice(0, 10)} estimatedGas=${gas}`)
		} catch (error) {
			fail(`${action.label} simulation failed: ${safeError(error)}`)
		}
	}

	if (pending.length === 0) {
		console.log("\nAll six handover transactions are already reflected on-chain. No Ledger signature is needed.")
		return
	}
	const feeData = await provider.getFeeData()
	const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice
	const balance = await provider.getBalance(context.admin)
	console.log(`\nPending Ledger signatures: ${pending.length}`)
	console.log(`Admin ETH balance: ${formatEther(balance)} ETH`)
	if (feePerGas !== null) {
		const estimatedExecutionFee = pending.reduce((total, item) => total + item.gas * feePerGas, 0n)
		console.log(`Approximate EVM execution-fee ceiling: ${formatEther(estimatedExecutionFee)} ETH (Arbitrum L1 data fee is additional)`)
		if (balance < estimatedExecutionFee) fail("admin balance is below the estimated EVM execution fee before Arbitrum L1 data fees")
	}
	if (mode === "check") {
		console.log("\nCheck-only mode: every pending action simulated successfully. No transaction was sent and the Ledger was not opened.")
		return
	}

	const rpcUrl = await resolveHttpRpcUrl((connection.networkConfig as { type?: string; url?: unknown }).url)
	const castBin = process.env.CAST_BIN ?? "cast"
	const castEnvironment = { ...process.env, ETH_RPC_URL: rpcUrl, ETH_FROM: context.admin }
	console.log("\nOpen the Ethereum app on the Ledger. Contract-data signing may need to be enabled for these reviewed calls.")
	const ledgerPath = discoverLedgerPath(castBin, castEnvironment, expectedLedgerAddress)
	console.log(`PASS connected Ledger matches admin ${context.admin} at ${ledgerPath}`)
	if ((await confirmation()) !== ADMIN_ACTION_CONFIRMATION) fail("confirmation text did not match; no transaction was sent")

	const confirmations = confirmationCount()
	const receipts: string[] = []
	for (const [index, item] of pending.entries()) {
		console.log(`\n[${index + 1}/${pending.length}] ${item.action.label}`)
		console.log(`to=${item.action.to} data=${item.action.data}`)
		const output = runCast(
			castBin,
			[
				"send",
				item.action.to,
				item.action.data,
				"--from",
				context.admin,
				"--chain",
				CHAIN_ID.toString(),
				"--confirmations",
				String(confirmations),
				"--timeout",
				"300",
				"--json",
				...ledgerArguments(ledgerPath),
			],
			castEnvironment,
		)
		const hash = receiptHash(output)
		receipts.push(hash)
		console.log(`CONFIRMED ${hash}`)
		await waitForCompletion(item.action)
		console.log("PASS expected post-state is visible")
	}

	for (const action of actions) {
		if (!(await action.isComplete())) fail(`${action.label} is not complete after the handover run`)
	}
	console.log("\nAll handover actions are confirmed on Arbitrum:")
	for (const hash of receipts) console.log(`  ${hash}`)
	console.log("\nResume the authoritative deployment gate now:")
	console.log("  ./symmio deploy --config deployments/arbitrum.json")
	console.log("Then run the independent read-only status check:")
	console.log("  ./symmio status --config deployments/arbitrum.json")
}

try {
	await main()
} catch (error) {
	console.error(`\nHandover FAILED: ${safeError(error)}`)
	process.exitCode = 1
}
