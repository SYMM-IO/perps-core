import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import fs from "fs"
import { task } from "hardhat/config"
// ============================================================================
// Verify All Contracts from Checkpoint
// ============================================================================

import { ArgumentType } from "hardhat/types/arguments"
import path from "path"

import { readData } from "../utils/fs.js"
import { loadCheckpoint } from "./checkpoint.js"
import {
	ACCOUNTHUB_DEPLOYMENT_LOG_FILE,
	ACCOUNTLAYER_DEPLOYMENT_FILE,
	AFFILIATEHUB_DEPLOYMENT_FILE,
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

const verifyAffiliateHubAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(AFFILIATEHUB_DEPLOYMENT_FILE)

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

const verifyAccountHubAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(ACCOUNTHUB_DEPLOYMENT_LOG_FILE)

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

interface ContractToVerify {
	name: string
	address: string
	constructorArguments: any[]
	libraries?: Record<string, string>
}

function collectContractsFromCheckpoint(checkpoint: any): ContractToVerify[] {
	const contracts: ContractToVerify[] = []

	// Collateral (if it was deployed, not an existing one)
	if (checkpoint.contracts?.collateral?.constructorArgs) {
		contracts.push({
			name: "FakeStablecoin",
			address: checkpoint.contracts.collateral.address,
			constructorArguments: checkpoint.contracts.collateral.constructorArgs || [],
		})
	}

	// Core Diamond
	const diamond = checkpoint.contracts?.diamond
	if (diamond) {
		if (diamond.diamondCutFacet) {
			contracts.push({
				name: "DiamondCutFacet",
				address: diamond.diamondCutFacet.address,
				constructorArguments: [],
			})
		}
		if (diamond.diamond) {
			contracts.push({
				name: "Diamond",
				address: diamond.diamond.address,
				constructorArguments: diamond.diamond.constructorArgs || [],
			})
		}
		if (diamond.init) {
			contracts.push({
				name: "contracts/core/Init.sol:Init",
				address: diamond.init.address,
				constructorArguments: [],
			})
		}

		// Libraries
		if (diamond.libraries) {
			for (const [libName, libData] of Object.entries(diamond.libraries) as [string, any][]) {
				contracts.push({
					name: libName,
					address: libData.address,
					constructorArguments: [],
				})
			}
		}

		// Facets
		if (diamond.facets) {
			for (const [facetName, facetData] of Object.entries(diamond.facets) as [string, any][]) {
				contracts.push({
					name: facetName,
					address: facetData.address,
					constructorArguments: [],
				})
			}
		}
	}

	// AccountLayer Diamond
	const alDiamond = checkpoint.contracts?.accountLayerDiamond
	if (alDiamond) {
		if (alDiamond.diamondCutFacet) {
			contracts.push({
				name: "DiamondCutFacet",
				address: alDiamond.diamondCutFacet.address,
				constructorArguments: [],
			})
		}
		if (alDiamond.diamond) {
			contracts.push({
				name: "Diamond",
				address: alDiamond.diamond.address,
				constructorArguments: alDiamond.diamond.constructorArgs || [],
			})
		}
		if (alDiamond.init) {
			contracts.push({
				name: "contracts/accountLayer/Init.sol:Init",
				address: alDiamond.init.address,
				constructorArguments: [],
			})
		}

		// Libraries
		if (alDiamond.libraries) {
			for (const [libName, libData] of Object.entries(alDiamond.libraries) as [string, any][]) {
				contracts.push({
					name: `contracts/accountLayer/libraries/${libName}.sol:${libName}`,
					address: libData.address,
					constructorArguments: [],
				})
			}
		}

		// Facets
		if (alDiamond.facets) {
			const facetPathMap: Record<string, string> = {
				CoreFacet: "Core",
				MarginFacet: "Margin",
				SymmioHookFacet: "SymmioHook",
				ControlFacet: "Control",
				ViewFacet: "View",
				AffiliateFacet: "Affiliate",
			}
			for (const [facetName, facetData] of Object.entries(alDiamond.facets) as [string, any][]) {
				const facetPath = facetPathMap[facetName] || facetName.replace("Facet", "")
				contracts.push({
					name: `contracts/accountLayer/facets/${facetPath}/${facetName}.sol:${facetName}`,
					address: facetData.address,
					constructorArguments: [],
				})
			}
		}
	}

	// InstantLayer
	if (checkpoint.contracts?.instantLayer) {
		contracts.push({
			name: "InstantLayer",
			address: checkpoint.contracts.instantLayer.address,
			constructorArguments: checkpoint.contracts.instantLayer.constructorArgs || [],
		})
	}

	// SymmioPartyB
	if (checkpoint.contracts?.symmioPartyB) {
		contracts.push({
			name: "SymmioPartyB",
			address: checkpoint.contracts.symmioPartyB.address,
			constructorArguments: checkpoint.contracts.symmioPartyB.constructorArgs || [],
		})
	}

	return contracts
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
			const { ethers } = await getConnection(hre)
			const chainId = Number((await ethers.provider.getNetwork()).chainId)
			const network = hre.network?.name || "localhost"

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

export const verifyAffiliateHubTask = task("verify:affiliateHub", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyAffiliateHubAction }))
	.build()

export const verifyAccountHubTask = task("verify:accountHub", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyAccountHubAction }))
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
}

const EXPECTED_CORE_FACETS = 29
const EXPECTED_AL_FACETS = 8

async function verifySystemParameters(ethers: any, diamondAddress: string, results: VerificationResult[]) {
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamondAddress)

	const checks = [
		{ name: "Balance limit per user", fn: () => view.getBalanceLimitPerUser(), minValue: BigInt(0) },
		{ name: "Deallocate debounce time", fn: () => view.getDeallocateDebounceTime(), minValue: BigInt(0) },
		{ name: "Liquidator share", fn: () => view.liquidatorShare(), minValue: BigInt(0) },
		{ name: "Liquidation timeout", fn: () => view.liquidationTimeout(), minValue: BigInt(0) },
		{ name: "Pending quotes valid length", fn: () => view.pendingQuotesValidLength(), minValue: BigInt(0) },
	]

	for (const check of checks) {
		try {
			const value = await check.fn()
			if (value > check.minValue) {
				results.push({
					category: "Core Diamond",
					check: check.name,
					status: "pass",
					actual: String(value),
				})
				console.log(`   [PASS] ${check.name}: ${value}`)
			} else {
				results.push({
					category: "Core Diamond",
					check: check.name,
					status: "warn",
					actual: String(value),
					message: "Value is 0 or not set",
				})
				console.log(`   [WARN] ${check.name}: ${value} (not configured?)`)
			}
		} catch (e: any) {
			results.push({
				category: "Core Diamond",
				check: check.name,
				status: "fail",
				message: e.message,
			})
			console.log(`   [FAIL] ${check.name}: ${e.message}`)
		}
	}
}

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
		description: "SymmioPartyB address (optional)",
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
			const { ethers } = await getConnection(hre)
			const chainId = (await ethers.provider.getNetwork()).chainId
			const network = hre.network?.name || "localhost"

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
				const fs = await import("fs")
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
				const fs = await import("fs")
				const path = await import("path")
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

			console.log("")
			console.log("=".repeat(80))
			console.log("DEPLOYMENT HEALTH CHECK")
			console.log("=".repeat(80))
			console.log(`Network: ${network}`)
			console.log(`Chain ID: ${chainId}`)
			console.log("")
			console.log("Addresses to verify:")
			console.log(`  Diamond:        ${addresses.diamond || "(not set)"}`)
			console.log(`  AccountLayer:   ${addresses.accountLayer || "(not set)"}`)
			console.log(`  InstantLayer:   ${addresses.instantLayer || "(not set)"}`)
			console.log(`  PartyB:         ${addresses.partyB || "(not set)"}`)
			console.log(`  Collateral:     ${addresses.collateral || "(not set)"}`)
			console.log(`  Admin:          ${addresses.admin || "(not set)"}`)
			console.log("=".repeat(80))
			console.log("")

			const results: VerificationResult[] = []

			// ========================================
			// 1. Core Diamond Verification
			// ========================================
			console.log("1. CORE DIAMOND")
			console.log("-".repeat(40))

			// Check contract exists
			const diamondCode = await ethers.provider.getCode(addresses.diamond)
			if (diamondCode === "0x") {
				results.push({
					category: "Core Diamond",
					check: "Contract exists",
					status: "fail",
					message: "No contract at address",
				})
				console.log("   [FAIL] No contract at Diamond address")
			} else {
				results.push({
					category: "Core Diamond",
					check: "Contract exists",
					status: "pass",
				})
				console.log("   [PASS] Contract exists")

				// Check facets
				try {
					const loupe = await ethers.getContractAt("IDiamondLoupe", addresses.diamond)
					const facets = await loupe.facets()
					const facetCount = facets.length

					if (facetCount === EXPECTED_CORE_FACETS) {
						results.push({
							category: "Core Diamond",
							check: "Facet count",
							status: "pass",
							expected: String(EXPECTED_CORE_FACETS),
							actual: String(facetCount),
						})
						console.log(`   [PASS] Facet count: ${facetCount}/${EXPECTED_CORE_FACETS}`)
					} else {
						results.push({
							category: "Core Diamond",
							check: "Facet count",
							status: "warn",
							expected: String(EXPECTED_CORE_FACETS),
							actual: String(facetCount),
						})
						console.log(`   [WARN] Facet count: ${facetCount}/${EXPECTED_CORE_FACETS}`)
					}
				} catch (e: any) {
					results.push({
						category: "Core Diamond",
						check: "Facet count",
						status: "fail",
						message: e.message,
					})
					console.log(`   [FAIL] Could not get facets: ${e.message}`)
				}

				// Check owner (admin)
				try {
					const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
					const owner = await view.owner()

					if (addresses.admin) {
						if (owner.toLowerCase() === addresses.admin.toLowerCase()) {
							results.push({
								category: "Core Diamond",
								check: "Owner",
								status: "pass",
								expected: addresses.admin,
								actual: owner,
							})
							console.log(`   [PASS] Owner: ${owner}`)
						} else {
							results.push({
								category: "Core Diamond",
								check: "Owner",
								status: "fail",
								expected: addresses.admin,
								actual: owner,
							})
							console.log(`   [FAIL] Owner mismatch: expected ${addresses.admin}, got ${owner}`)
						}
					} else {
						results.push({
							category: "Core Diamond",
							check: "Owner",
							status: "pass",
							actual: owner,
						})
						console.log(`   [PASS] Owner set: ${owner}`)
					}
				} catch (e: any) {
					results.push({
						category: "Core Diamond",
						check: "Owner",
						status: "fail",
						message: e.message,
					})
					console.log(`   [FAIL] Could not get owner: ${e.message}`)
				}

				// Check collateral
				try {
					const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
					const collateral = await view.getCollateral()

					if (collateral === ethers.ZeroAddress) {
						results.push({
							category: "Core Diamond",
							check: "Collateral",
							status: "fail",
							message: "Collateral not set",
						})
						console.log("   [FAIL] Collateral not set")
					} else if (addresses.collateral && collateral.toLowerCase() !== addresses.collateral.toLowerCase()) {
						results.push({
							category: "Core Diamond",
							check: "Collateral",
							status: "fail",
							expected: addresses.collateral,
							actual: collateral,
						})
						console.log(`   [FAIL] Collateral mismatch: expected ${addresses.collateral}, got ${collateral}`)
					} else {
						results.push({
							category: "Core Diamond",
							check: "Collateral",
							status: "pass",
							actual: collateral,
						})
						console.log(`   [PASS] Collateral: ${collateral}`)
					}
				} catch (e: any) {
					results.push({
						category: "Core Diamond",
						check: "Collateral",
						status: "fail",
						message: e.message,
					})
					console.log(`   [FAIL] Could not get collateral: ${e.message}`)
				}

				// Check system parameters
				await verifySystemParameters(ethers, addresses.diamond, results)
			}
			console.log("")

			// ========================================
			// 2. AccountLayer Diamond Verification
			// ========================================
			if (addresses.accountLayer) {
				console.log("2. ACCOUNTLAYER DIAMOND")
				console.log("-".repeat(40))

				const alCode = await ethers.provider.getCode(addresses.accountLayer)
				if (alCode === "0x") {
					results.push({
						category: "AccountLayer",
						check: "Contract exists",
						status: "fail",
						message: "No contract at address",
					})
					console.log("   [FAIL] No contract at AccountLayer address")
				} else {
					results.push({
						category: "AccountLayer",
						check: "Contract exists",
						status: "pass",
					})
					console.log("   [PASS] Contract exists")

					// Check admin has DEFAULT_ADMIN_ROLE
					try {
						const alControl = await ethers.getContractAt(
							"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
							addresses.accountLayer,
						)
						// DEFAULT_ADMIN_ROLE is bytes32(0)
						const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000"

						if (addresses.admin) {
							const hasAdminRole = await alControl.isRoleAdmin(addresses.admin, DEFAULT_ADMIN_ROLE)
							if (hasAdminRole) {
								results.push({
									category: "AccountLayer",
									check: "Admin has DEFAULT_ADMIN_ROLE",
									status: "pass",
									actual: addresses.admin,
								})
								console.log(`   [PASS] Admin has DEFAULT_ADMIN_ROLE: ${addresses.admin}`)
							} else {
								results.push({
									category: "AccountLayer",
									check: "Admin has DEFAULT_ADMIN_ROLE",
									status: "warn",
									actual: addresses.admin,
									message: "Admin does not have DEFAULT_ADMIN_ROLE",
								})
								console.log(`   [WARN] Admin does not have DEFAULT_ADMIN_ROLE: ${addresses.admin}`)
							}
						} else {
							results.push({
								category: "AccountLayer",
								check: "Admin role check",
								status: "pass",
								message: "No admin address provided to check",
							})
							console.log("   [PASS] Admin role check skipped (no admin address provided)")
						}
					} catch (e: any) {
						results.push({
							category: "AccountLayer",
							check: "Admin role check",
							status: "fail",
							message: e.message,
						})
						console.log(`   [FAIL] Could not check admin role: ${e.message}`)
					}

					// Check Symmio Core whitelisted
					try {
						const alView = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", addresses.accountLayer)
						const isWhitelisted = await alView.isWhitelistedSymmioCore(addresses.diamond)
						if (isWhitelisted) {
							results.push({
								category: "AccountLayer",
								check: "Symmio Core whitelisted",
								status: "pass",
							})
							console.log("   [PASS] Symmio Core whitelisted")
						} else {
							results.push({
								category: "AccountLayer",
								check: "Symmio Core whitelisted",
								status: "fail",
							})
							console.log("   [FAIL] Symmio Core NOT whitelisted")
						}
					} catch (e: any) {
						results.push({
							category: "AccountLayer",
							check: "Symmio Core whitelisted",
							status: "fail",
							message: e.message,
						})
						console.log(`   [FAIL] Could not check whitelist: ${e.message}`)
					}
				}
				console.log("")
			}

			// ========================================
			// 3. InstantLayer Verification
			// ========================================
			if (addresses.instantLayer) {
				console.log("3. INSTANTLAYER")
				console.log("-".repeat(40))

				const ilCode = await ethers.provider.getCode(addresses.instantLayer)
				if (ilCode === "0x") {
					results.push({
						category: "InstantLayer",
						check: "Contract exists",
						status: "fail",
						message: "No contract at address",
					})
					console.log("   [FAIL] No contract at InstantLayer address")
				} else {
					results.push({
						category: "InstantLayer",
						check: "Contract exists",
						status: "pass",
					})
					console.log("   [PASS] Contract exists")

					const instantLayer = await ethers.getContractAt("InstantLayer", addresses.instantLayer)

					// Check AccountHub
					try {
						const accountHub = await instantLayer.accountHub()
						if (accountHub === ethers.ZeroAddress) {
							results.push({
								category: "InstantLayer",
								check: "AccountHub set",
								status: "fail",
							})
							console.log("   [FAIL] AccountHub not set")
						} else if (addresses.accountLayer && accountHub.toLowerCase() !== addresses.accountLayer.toLowerCase()) {
							results.push({
								category: "InstantLayer",
								check: "AccountHub set",
								status: "fail",
								expected: addresses.accountLayer,
								actual: accountHub,
							})
							console.log(`   [FAIL] AccountHub mismatch: expected ${addresses.accountLayer}, got ${accountHub}`)
						} else {
							results.push({
								category: "InstantLayer",
								check: "AccountHub set",
								status: "pass",
								actual: accountHub,
							})
							console.log(`   [PASS] AccountHub: ${accountHub}`)
						}
					} catch (e: any) {
						results.push({
							category: "InstantLayer",
							check: "AccountHub set",
							status: "fail",
							message: e.message,
						})
						console.log(`   [FAIL] Could not get AccountHub: ${e.message}`)
					}

					// Check Diamond whitelisted
					try {
						const isWhitelisted = await instantLayer.whitelistedTargets(addresses.diamond)
						if (isWhitelisted) {
							results.push({
								category: "InstantLayer",
								check: "Diamond whitelisted",
								status: "pass",
							})
							console.log("   [PASS] Diamond whitelisted")
						} else {
							results.push({
								category: "InstantLayer",
								check: "Diamond whitelisted",
								status: "fail",
							})
							console.log("   [FAIL] Diamond NOT whitelisted")
						}
					} catch (e: any) {
						results.push({
							category: "InstantLayer",
							check: "Diamond whitelisted",
							status: "fail",
							message: e.message,
						})
						console.log(`   [FAIL] Could not check whitelist: ${e.message}`)
					}

					// Check templates (templates are indexed by uint256, not string)
					try {
						const nextTemplateId = await instantLayer.nextTemplateId()
						const templateCount = Number(nextTemplateId)

						if (templateCount > 0) {
							// Get all templates and check for OpenPosition and ClosePosition by name
							const templateNames: string[] = []
							for (let i = 0; i < templateCount; i++) {
								const template = await instantLayer.getTemplate(i)
								templateNames.push(template.name)
							}

							const hasOpenPosition = templateNames.includes("OpenPosition")
							const hasClosePosition = templateNames.includes("ClosePosition")

							if (hasOpenPosition) {
								results.push({
									category: "InstantLayer",
									check: "OpenPosition template",
									status: "pass",
									actual: "configured",
								})
								console.log("   [PASS] OpenPosition template configured")
							} else {
								results.push({
									category: "InstantLayer",
									check: "OpenPosition template",
									status: "fail",
								})
								console.log("   [FAIL] OpenPosition template not found")
							}

							if (hasClosePosition) {
								results.push({
									category: "InstantLayer",
									check: "ClosePosition template",
									status: "pass",
									actual: "configured",
								})
								console.log("   [PASS] ClosePosition template configured")
							} else {
								results.push({
									category: "InstantLayer",
									check: "ClosePosition template",
									status: "fail",
								})
								console.log("   [FAIL] ClosePosition template not found")
							}

							console.log(`   [INFO] Total templates: ${templateCount} (${templateNames.join(", ")})`)
						} else {
							results.push({
								category: "InstantLayer",
								check: "Templates",
								status: "fail",
								message: "No templates configured",
							})
							console.log("   [FAIL] No templates configured")
						}
					} catch (e: any) {
						results.push({
							category: "InstantLayer",
							check: "Templates",
							status: "fail",
							message: e.message,
						})
						console.log(`   [FAIL] Could not check templates: ${e.message}`)
					}
				}
				console.log("")
			}

			// ========================================
			// 4. PartyB Verification
			// ========================================
			if (addresses.partyB) {
				console.log("4. SYMMIO PARTYB")
				console.log("-".repeat(40))

				const pbCode = await ethers.provider.getCode(addresses.partyB)
				if (pbCode === "0x") {
					results.push({
						category: "PartyB",
						check: "Contract exists",
						status: "fail",
						message: "No contract at address",
					})
					console.log("   [FAIL] No contract at PartyB address")
				} else {
					results.push({
						category: "PartyB",
						check: "Contract exists",
						status: "pass",
					})
					console.log("   [PASS] Contract exists")

					// Check registered in Diamond
					try {
						const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", addresses.diamond)
						const isPartyB = await view.isPartyB(addresses.partyB)
						if (isPartyB) {
							results.push({
								category: "PartyB",
								check: "Registered in Diamond",
								status: "pass",
							})
							console.log("   [PASS] Registered in Diamond")
						} else {
							results.push({
								category: "PartyB",
								check: "Registered in Diamond",
								status: "fail",
							})
							console.log("   [FAIL] NOT registered in Diamond")
						}
					} catch (e: any) {
						results.push({
							category: "PartyB",
							check: "Registered in Diamond",
							status: "fail",
							message: e.message,
						})
						console.log(`   [FAIL] Could not check registration: ${e.message}`)
					}

					// Check registered in InstantLayer
					if (addresses.instantLayer) {
						try {
							const instantLayer = await ethers.getContractAt("InstantLayer", addresses.instantLayer)
							const isRegistered = await instantLayer.registeredPartyBs(addresses.partyB)
							if (isRegistered) {
								results.push({
									category: "PartyB",
									check: "Registered in InstantLayer",
									status: "pass",
								})
								console.log("   [PASS] Registered in InstantLayer")
							} else {
								results.push({
									category: "PartyB",
									check: "Registered in InstantLayer",
									status: "fail",
								})
								console.log("   [FAIL] NOT registered in InstantLayer")
							}
						} catch (e: any) {
							results.push({
								category: "PartyB",
								check: "Registered in InstantLayer",
								status: "fail",
								message: e.message,
							})
							console.log(`   [FAIL] Could not check IL registration: ${e.message}`)
						}
					}
				}
				console.log("")
			}

			// ========================================
			// Summary
			// ========================================
			console.log("=".repeat(80))
			console.log("VERIFICATION SUMMARY")
			console.log("=".repeat(80))

			const passed = results.filter(r => r.status === "pass").length
			const failed = results.filter(r => r.status === "fail").length
			const warnings = results.filter(r => r.status === "warn").length

			console.log(`Total checks: ${results.length}`)
			console.log(`  Passed:   ${passed}`)
			console.log(`  Failed:   ${failed}`)
			console.log(`  Warnings: ${warnings}`)
			console.log("")

			if (failed > 0) {
				console.log("FAILED CHECKS:")
				for (const r of results.filter(r => r.status === "fail")) {
					console.log(`  - [${r.category}] ${r.check}: ${r.message || `expected ${r.expected}, got ${r.actual}`}`)
				}
				console.log("")
			}

			if (warnings > 0) {
				console.log("WARNINGS:")
				for (const r of results.filter(r => r.status === "warn")) {
					console.log(`  - [${r.category}] ${r.check}: expected ${r.expected}, got ${r.actual}`)
				}
				console.log("")
			}

			console.log("=".repeat(80))

			if (failed === 0) {
				console.log("DEPLOYMENT HEALTH CHECK PASSED")
			} else {
				console.log("DEPLOYMENT HEALTH CHECK FAILED")
			}
			console.log("=".repeat(80))

			return { results, passed, failed, warnings }
		},
	}))
	.build()
