import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import fs from "fs"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import path from "path"

import { readData } from "../utils/fs.js"
import {
	ACCOUNTLAYER_ACCOUNT_DEPLOYMENT_LOG_FILE,
	ACCOUNTLAYER_DEPLOYMENT_FILE,
	ACCOUNTLAYER_AFFILIATE_DEPLOYMENT_FILE,
	DEPLOYMENT_LOG_FILE,
	INSTANTLAYER_DEPLOYMENT_FILE,
	PARTYB_DEPLOYMENT_FILE,
	STABLECOIN_DEPLOYMENT_FILE,
} from "./constants.js"
import { getConnection } from "./helpers.js"

const verifyDeploymentAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(DEPLOYMENT_LOG_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await verifyContract(
				{
					address: address.address,
					constructorArgs: address.constructorArguments,
				},
				hre,
			)
		} catch (err) {
			console.error(err)
		}
	}
}

const verifyAffiliateAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(ACCOUNTLAYER_AFFILIATE_DEPLOYMENT_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await verifyContract(
				{
					address: address.address,
					constructorArgs: address.constructorArguments,
				},
				hre,
			)
		} catch (err) {
			console.error(err)
		}
	}
}

const verifyAccountAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(ACCOUNTLAYER_ACCOUNT_DEPLOYMENT_LOG_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await verifyContract(
				{
					address: address.address,
					constructorArgs: address.constructorArguments,
				},
				hre,
			)
		} catch (err) {
			console.error(err)
		}
	}
}

const verifyInstantLayerAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(INSTANTLAYER_DEPLOYMENT_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await verifyContract(
				{
					address: address.address,
					constructorArgs: address.constructorArguments,
				},
				hre,
			)
		} catch (err) {
			console.error(err)
		}
	}
}

const verifyAccountLayerAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(ACCOUNTLAYER_DEPLOYMENT_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await verifyContract(
				{
					address: address.address,
					constructorArgs: address.constructorArguments,
				},
				hre,
			)
		} catch (err) {
			console.error(err)
		}
	}
}

export const verifyDeploymentTask = task("verify:deployment", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyDeploymentAction }))
	.build()

// ============================================================================
// Verify All Contracts from Deployment Logs
// ============================================================================

interface ContractToVerify {
	name: string
	address: string
	constructorArguments: any[]
}

export const verifyAllTask = task("verify:all", "Verifies all deployed contracts from deployment logs on block explorer")
	.addOption({
		name: "skip",
		description: "Number of contracts to skip (for resuming)",
		type: ArgumentType.INT,
		defaultValue: 0,
	})
	.setAction(async () => ({
		default: async (args: { skip: number }, hre: any) => {
			const connection = await getConnection(hre)
			const { ethers } = connection
			const chainId = Number((await ethers.provider.getNetwork()).chainId)
			const network = connection.networkName || "unknown"

			console.log("")
			console.log("=".repeat(80))
			console.log("CONTRACT VERIFICATION ON BLOCK EXPLORER")
			console.log("=".repeat(80))
			console.log(`Network: ${network}`)
			console.log(`Chain ID: ${chainId}`)
			console.log("")

			let contracts: ContractToVerify[] = []

			// Read from deployment log files
			const logFiles = [
				{ file: STABLECOIN_DEPLOYMENT_FILE, name: "Stablecoin (stablecoin.json)" },
				{ file: DEPLOYMENT_LOG_FILE, name: "Core Diamond (deployed.json)" },
				{ file: ACCOUNTLAYER_DEPLOYMENT_FILE, name: "AccountLayer (accountlayer.json)" },
				{ file: INSTANTLAYER_DEPLOYMENT_FILE, name: "InstantLayer (instantlayer.json)" },
				{ file: PARTYB_DEPLOYMENT_FILE, name: "PartyB (partyb.json)" },
			]

			for (const { file, name } of logFiles) {
				const filePath = `./tasks/data/${file}`
				if (fs.existsSync(filePath)) {
					try {
						const data = JSON.parse(fs.readFileSync(filePath, "utf8"))
						if (Array.isArray(data)) {
							contracts.push(
								...data.map((c: any) => ({
									name: c.name,
									address: c.address,
									constructorArguments: c.constructorArguments || [],
								})),
							)
							console.log(`Loaded ${data.length} contracts from ${name}`)
						}
					} catch (e) {
						console.log(`Could not read ${name}: ${e}`)
					}
				} else {
					console.log(`${name} not found, skipping`)
				}
			}

			console.log(`Found ${contracts.length} contracts to verify`)
			if (args.skip > 0) {
				console.log(`Skipping first ${args.skip} contracts`)
				contracts = contracts.slice(args.skip)
			}
			console.log("")

			let verified = 0
			let failed = 0
			let alreadyVerified = 0

			for (let i = 0; i < contracts.length; i++) {
				const contract = contracts[i]
				const idx = args.skip + i + 1
				console.log(`[${idx}/${args.skip + contracts.length}] Verifying ${contract.name} at ${contract.address}...`)

				try {
					await verifyContract(
						{
							address: contract.address,
							constructorArgs: contract.constructorArguments,
							contract: contract.name.includes(":") ? contract.name : undefined,
						},
						hre,
					)
					verified++
					console.log(`   [OK] Verified`)
				} catch (err: any) {
					if (err.message?.includes("Already Verified") || err.message?.includes("already verified")) {
						alreadyVerified++
						console.log(`   [SKIP] Already verified`)
					} else {
						failed++
						console.log(`   [FAIL] ${err.message?.slice(0, 100)}`)
					}
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
				console.log(`\nTo resume from where it failed, use: --skip=${args.skip + verified + alreadyVerified}`)
			}
		},
	}))
	.build()

export const verifyAffiliateTask = task("verify:affiliate", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyAffiliateAction }))
	.build()

export const verifyAccountTask = task("verify:account", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyAccountAction }))
	.build()

export const verifyInstantLayerTask = task("verify:instantLayer", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyInstantLayerAction }))
	.build()

export const verifyAccountLayerTask = task("verify:accountLayer", "Verifies the AccountLayer diamond contracts")
	.setAction(async () => ({ default: verifyAccountLayerAction }))
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

const EXPECTED_CORE_FACETS = 29
const EXPECTED_ACCOUNTLAYER_FACETS = 8

function roleHash(ethers: any, role: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(role))
}

// ANSI color codes for terminal output
const c = {
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
}

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

async function checkValue(
	results: VerificationResult[],
	category: string,
	name: string,
	fn: () => Promise<any>,
	opts: { failOnZero?: boolean; failStatus?: "fail" | "warn"; hint?: string } = {},
) {
	const failStatus = opts.failStatus || (opts.failOnZero !== false ? "fail" : "warn")
	try {
		const value = await fn()
		if (value > BigInt(0)) {
			pushAndLog(results, { category, check: name, status: "pass", actual: String(value) })
		} else {
			pushAndLog(results, { category, check: name, status: failStatus, actual: String(value), message: "Value is 0 or not set", hint: opts.hint })
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: name, status: "fail", message: e.message?.slice(0, 120), hint: opts.hint })
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
			pushAndLog(results, {
				category,
				check: `${shortHolder} has ${roleName}`,
				status: failStatus,
				message: "Role not granted",
				hint: `Call ${target}.grantRole(${holder}, keccak256("${roleName}"))`,
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category, check: `${roleName} check`, status: "fail", message: e.message?.slice(0, 120) })
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

// ============================================================================
// Core Diamond verification helpers
// ============================================================================

async function verifyCoreSystemParameters(ethers: any, diamondAddress: string, results: VerificationResult[]) {
	const cat = "Core: Params"
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamondAddress)

	console.log("")
	console.log(`   ${c.dim}-- System Parameters --${c.reset}`)

	// Numeric parameters that must be > 0
	await checkValue(results, cat, "Balance limit per user", () => view.getBalanceLimitPerUser(), {
		hint: "Call ControlFacet.setBalanceLimitPerUser(amount) on Diamond",
	})
	await checkValue(results, cat, "Deallocate debounce time", () => view.getDeallocateDebounceTime(), {
		hint: "Call ControlFacet.setDeallocateDebounceTime(seconds) on Diamond",
	})
	await checkValue(results, cat, "Liquidator share", () => view.liquidatorShare(), {
		hint: "Call ControlFacet.setLiquidatorShare(share) on Diamond  (1e17 = 10%)",
	})
	await checkValue(results, cat, "Liquidation timeout", () => view.liquidationTimeout(), {
		hint: "Call ControlFacet.setLiquidationTimeout(seconds) on Diamond",
	})
	await checkValue(results, cat, "Pending quotes valid length", () => view.pendingQuotesValidLength(), {
		hint: "Call ControlFacet.setPendingQuotesValidLength(length) on Diamond",
	})
	await checkValue(results, cat, "Max connected counter party", () => view.maxConnectedCounterParty(), {
		hint: "Call ControlFacet.setMaxPartyAConnectionLimit(limit) on Diamond",
	})
	await checkValue(results, cat, "Deallocate cooldown", () => view.deallocateCooldown(), {
		hint: "Call ControlFacet.setDeallocateCooldown(seconds) on Diamond",
	})
	await checkValue(results, cat, "Settlement cooldown", () => view.settlementCooldown(), {
		hint: "Call ControlFacet.setSettlementCooldown(seconds) on Diamond",
	})

	// Force close cooldowns (returns tuple)
	try {
		const [first, second] = await view.forceCloseCooldowns()
		if (first > BigInt(0) && second > BigInt(0)) {
			pushAndLog(results, { category: cat, check: "Force close cooldowns", status: "pass", actual: `first=${first}, second=${second}` })
		} else {
			pushAndLog(results, {
				category: cat,
				check: "Force close cooldowns",
				status: "fail",
				actual: `first=${first}, second=${second}`,
				message: "One or both cooldowns are 0",
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
			{ name: "Withdraw cooldown period", value: withdrawCooldown, hint: "Call ControlFacet.setDeallocateCooldown(seconds) on Diamond" },
			{ name: "Force cancel cooldown", value: forceCancelCooldown, hint: "Call ControlFacet.setForceCancelCooldown(seconds) on Diamond" },
			{
				name: "Force cancel close cooldown",
				value: forceCancelCloseCooldown,
				hint: "Call ControlFacet.setForceCancelCloseCooldown(seconds) on Diamond",
			},
		]
		for (const cd of cooldownChecks) {
			if (cd.value > BigInt(0)) {
				pushAndLog(results, { category: cat, check: cd.name, status: "pass", actual: String(cd.value) })
			} else {
				pushAndLog(results, {
					category: cat,
					check: cd.name,
					status: "fail",
					actual: String(cd.value),
					message: "Value is 0 or not set",
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
		hint: "Call ControlFacet.setSignatureVerifierAddress(verifierAddress) on Diamond",
	})
	await checkAddress(results, cat, "Invalid bridged amounts pool", () => view.getInvalidBridgedAmountsPool(), ethers, {
		hint: "Call ControlFacet.setInvalidBridgedAmountsPool(address) on Diamond",
	})
	await checkAddress(results, cat, "Default fee collector", () => view.getDefaultFeeCollector(), ethers, {
		failStatus: "warn",
		hint: "Call ControlFacet.setDefaultFeeCollector(address) on Diamond",
	})
	await checkAddress(results, cat, "Soft liquidation penalty collector", () => view.getSoftLiquidationPenaltyCollector(), ethers, {
		failStatus: "warn",
		hint: "Call ControlFacet.setSoftLiquidationPenaltyCollector(address) on Diamond",
	})

	// Liquidation insurance vault
	try {
		const [vault, maxProfit] = await view.getLiquidationInsuranceVaultParams()
		if (vault !== ethers.ZeroAddress) {
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
				status: "warn",
				message: "Not set (zero address)",
				hint: "Call ControlFacet.setLiquidationInsuranceVaultParams(vaultAddress, maxProfit) on Diamond",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Liquidation insurance vault", status: "fail", message: e.message?.slice(0, 120) })
	}

	// Muon oracle config
	console.log("")
	console.log(`   ${c.dim}-- Muon Oracle --${c.reset}`)
	try {
		const [upnlValidTime, priceValidTime] = await view.getMuonConfig()
		if (upnlValidTime > BigInt(0) && priceValidTime > BigInt(0)) {
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
		if (muonAppId > BigInt(0)) {
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

async function verifyCoreRoles(
	ethers: any,
	diamondAddress: string,
	addresses: { admin?: string; accountLayer?: string; instantLayer?: string },
	results: VerificationResult[],
) {
	const cat = "Core: Roles"
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamondAddress)

	console.log("")
	console.log(`   ${c.dim}-- Admin Roles on Diamond --${c.reset}`)

	if (addresses.admin) {
		const adminRoles = [
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
		for (const role of adminRoles) {
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

	// AccountLayerDiamond roles on Diamond
	if (addresses.accountLayer) {
		console.log("")
		console.log(`   ${c.dim}-- AccountLayer Roles on Diamond --${c.reset}`)
		const alRolesOnDiamond = ["SIGNER_ADMIN_ROLE", "AFFILIATE_MANAGER_ROLE", "INTERNAL_TRANSFER_TO_BALANCE_ROLE"]
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
	addresses: { diamond?: string; admin?: string; instantLayer?: string },
	results: VerificationResult[],
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
				status: "warn",
				expected: String(EXPECTED_ACCOUNTLAYER_FACETS),
				actual: String(facetCount),
				hint: "Run deploy:diamond to add/remove AccountLayer facets via diamondCut. Expected " + EXPECTED_ACCOUNTLAYER_FACETS + " facets",
			})
		}
	} catch (e: any) {
		pushAndLog(results, { category: cat, check: "Facet count", status: "fail", message: e.message?.slice(0, 120) })
	}

	const alView = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", accountLayerAddress)

	// Roles (Symmio-style: hasRole(address, bytes32))
	console.log("")
	console.log(`   ${c.dim}-- Roles --${c.reset}`)
	if (addresses.admin) {
		const adminRoles = ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE", "APPROVER_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE"]
		for (const role of adminRoles) {
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

	if (addresses.instantLayer) {
		await checkRole(results, cat, alView, addresses.instantLayer, "INSTANT_LAYER_ROLE", ethers, { contractLabel: "AccountLayer ControlFacet" })
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
		failStatus: "warn",
		hint: "Call AccountLayer ControlFacet.setSymmioFeeReceiver(address)",
	})

	// Signer
	await checkAddress(results, cat, "Signer", () => alView.getSigner(), ethers, {
		failStatus: "warn",
		hint: "Call AccountLayer ControlFacet.setSigner(address)",
	})

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
		await checkOzDefaultAdminRole(results, cat, instantLayer, addresses.admin, "fail", "InstantLayer")
		await checkRole(results, cat, instantLayer, addresses.admin, "SETTER_ROLE", ethers, { ozStyle: true, contractLabel: "InstantLayer" })
	} else {
		pushAndLog(results, {
			category: cat,
			check: "Admin roles",
			status: "warn",
			message: "No admin address provided, skipping role checks",
			hint: "Re-run with --admin <address> to verify role assignments",
		})
	}

	// Templates
	console.log("")
	console.log(`   ${c.dim}-- Templates --${c.reset}`)
	const templateHint = "Run the InstantLayer template setup (SETUP_INSTANT_LAYER_TEMPLATES=true in deploy:system)"
	try {
		const nextTemplateId = await instantLayer.nextTemplateId()
		const templateCount = Number(nextTemplateId)

		if (templateCount > 0) {
			const templateNames: string[] = []
			for (let i = 0; i < templateCount; i++) {
				const template = await instantLayer.getTemplate(i)
				templateNames.push(template.name)
			}

			const hasOpenPosition = templateNames.includes("OpenPosition")
			const hasClosePosition = templateNames.includes("ClosePosition")

			if (hasOpenPosition) {
				pushAndLog(results, { category: cat, check: "OpenPosition template", status: "pass", actual: "configured" })
			} else {
				pushAndLog(results, { category: cat, check: "OpenPosition template", status: "fail", message: "Template not found", hint: templateHint })
			}

			if (hasClosePosition) {
				pushAndLog(results, { category: cat, check: "ClosePosition template", status: "pass", actual: "configured" })
			} else {
				pushAndLog(results, {
					category: cat,
					check: "ClosePosition template",
					status: "fail",
					message: "Template not found",
					hint: templateHint,
				})
			}

			console.log(`   ${c.dim}[INFO] Total templates: ${templateCount} (${templateNames.join(", ")})${c.reset}`)
		} else {
			pushAndLog(results, { category: cat, check: "Templates", status: "fail", message: "No templates configured", hint: templateHint })
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
		await checkOzDefaultAdminRole(results, cat, partyB, addresses.admin, "fail", "SymmioPartyB")
		await checkRole(results, cat, partyB, addresses.admin, "MANAGER_ROLE", ethers, { ozStyle: true, contractLabel: "SymmioPartyB" })
		await checkRole(results, cat, partyB, addresses.admin, "SETTER_ROLE", ethers, { ozStyle: true, contractLabel: "SymmioPartyB" })
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

// ============================================================================
// Address loading helpers
// ============================================================================

function loadAddressesFromCheckpoint(checkpoint: any, existing: any) {
	return {
		diamond: existing.diamond || checkpoint.contracts?.diamond?.diamond?.address,
		accountLayer: existing.accountLayer || checkpoint.contracts?.accountLayerDiamond?.diamond?.address,
		instantLayer: existing.instantLayer || checkpoint.contracts?.instantLayer?.address,
		partyB: existing.partyB || checkpoint.contracts?.symmioPartyB?.address,
		collateral: existing.collateral || checkpoint.contracts?.collateral?.address,
		admin: existing.admin,
	}
}

function loadAddressesFromReport(report: any, existing: any) {
	return {
		diamond: existing.diamond || report.addresses?.diamond,
		accountLayer: existing.accountLayer || report.addresses?.accountLayerDiamond,
		instantLayer: existing.instantLayer || report.addresses?.instantLayer,
		partyB: existing.partyB || report.addresses?.symmioPartyB,
		collateral: existing.collateral || report.addresses?.collateral,
		admin: existing.admin || report.config?.admin,
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
	.setAction(async () => ({
		default: async (args: any, hre: any) => {
			const connection = await getConnection(hre)
			const { ethers } = connection
			const chainId = (await ethers.provider.getNetwork()).chainId
			const network = connection.networkName || "unknown"

			// Convert empty strings to undefined for cleaner handling
			let addresses = {
				diamond: args.diamond || undefined,
				accountLayer: args.accountLayer || undefined,
				instantLayer: args.instantLayer || undefined,
				partyB: args.partyB || undefined,
				collateral: args.collateral || undefined,
				admin: args.admin || undefined,
			}

			// Load from deployment report if requested
			if (args.fromReport) {
				const reportPath = "./tasks/data/deployment-report.json"

				if (fs.existsSync(reportPath)) {
					const report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
					addresses = loadAddressesFromReport(report, addresses)
					console.log(`Loaded addresses from deployment-report.json`)
				} else {
					console.error("Error: deployment-report.json not found")
				}
			}

			// Load from checkpoint if requested
			if (args.fromCheckpoint) {
				const checkpointPath = path.join("./tasks/data/checkpoints", `checkpoint-${chainId}.json`)

				if (!fs.existsSync(checkpointPath)) {
					// Try completed checkpoints
					const completedDir = path.join("./tasks/data/checkpoints", "completed")
					if (fs.existsSync(completedDir)) {
						const files = fs.readdirSync(completedDir).filter((f: string) => f.includes(`${chainId}`))
						if (files.length > 0) {
							// Get most recent
							files.sort().reverse()
							const checkpoint = JSON.parse(fs.readFileSync(path.join(completedDir, files[0]), "utf8"))
							addresses = loadAddressesFromCheckpoint(checkpoint, addresses)
							console.log(`Loaded addresses from completed checkpoint: ${files[0]}`)
						}
					}
				} else {
					const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"))
					addresses = loadAddressesFromCheckpoint(checkpoint, addresses)
					console.log(`Loaded addresses from checkpoint-${chainId}.json`)
				}
			}

			// Validate required addresses
			if (!addresses.diamond) {
				console.error("Error: Diamond address is required. Use --diamond or --fromCheckpoint")
				return
			}

			// Parse multiple PartyB addresses (comma-separated)
			const partyBAddresses: string[] = addresses.partyB
				? addresses.partyB
						.split(",")
						.map((a: string) => a.trim())
						.filter(Boolean)
				: []

			console.log("")
			console.log(`${c.bold}Deployment Health Check${c.reset}  ${c.dim}${network} (${chainId})${c.reset}`)
			console.log("")
			console.log(`${c.dim}  Diamond        ${c.reset}${addresses.diamond || `${c.dim}(not set)${c.reset}`}`)
			console.log(`${c.dim}  AccountLayer   ${c.reset}${addresses.accountLayer || `${c.dim}(not set)${c.reset}`}`)
			console.log(`${c.dim}  InstantLayer   ${c.reset}${addresses.instantLayer || `${c.dim}(not set)${c.reset}`}`)
			if (partyBAddresses.length > 0) {
				for (let i = 0; i < partyBAddresses.length; i++) {
					console.log(`${c.dim}  PartyB [${i}]     ${c.reset}${partyBAddresses[i]}`)
				}
			} else {
				console.log(`${c.dim}  PartyB         (not set)${c.reset}`)
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
							status: "warn",
							expected: String(EXPECTED_CORE_FACETS),
							actual: String(facetCount),
							hint: "Run deploy:diamond to add/remove facets via diamondCut. Expected " + EXPECTED_CORE_FACETS + " facets",
						})
					}
				} catch (e: any) {
					pushAndLog(results, { category: "Core Diamond", check: "Facet count", status: "fail", message: e.message?.slice(0, 120) })
				}

				// Check owner
				try {
					const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
					const owner = await view.owner()

					if (addresses.admin) {
						if (owner.toLowerCase() === addresses.admin.toLowerCase()) {
							pushAndLog(results, { category: "Core Diamond", check: "Owner", status: "pass", actual: owner })
						} else {
							pushAndLog(results, {
								category: "Core Diamond",
								check: "Owner",
								status: "fail",
								expected: addresses.admin,
								actual: owner,
								hint: "Call Diamond.transferOwnership(newOwner), then newOwner calls Diamond.acceptOwnership()",
							})
						}
					} else {
						if (owner === ethers.ZeroAddress) {
							pushAndLog(results, {
								category: "Core Diamond",
								check: "Owner",
								status: "fail",
								message: "Not set (zero address)",
								hint: "Call Diamond.transferOwnership(newOwner), then newOwner calls Diamond.acceptOwnership()",
							})
						} else {
							pushAndLog(results, { category: "Core Diamond", check: "Owner", status: "pass", actual: owner })
						}
					}
				} catch (e: any) {
					pushAndLog(results, { category: "Core Diamond", check: "Owner", status: "fail", message: e.message?.slice(0, 120) })
				}

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
				await verifyCoreSystemParameters(ethers, addresses.diamond, results)

				// Roles
				await verifyCoreRoles(ethers, addresses.diamond, addresses, results)
			}
			console.log("")

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
					await verifyAccountLayerFull(ethers, addresses.accountLayer, addresses, results)
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
					await verifyInstantLayerFull(ethers, addresses.instantLayer, addresses, results)
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
					await verifyPartyBFull(ethers, pbAddr, addresses, results)
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

			return { results, passed, failed, warnings }
		},
	}))
	.build()
