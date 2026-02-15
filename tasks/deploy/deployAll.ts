import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { ControlFacet } from "../../src/types/index.js"
import { writeData } from "../utils/fs.js"
import { deployAccountLayerDiamond } from "./accountLayerDiamond.js"
import {
	loadCheckpoint,
	saveCheckpoint,
	createCheckpoint,
	clearCheckpoint,
	displayCheckpointStatus,
	DeploymentCheckpoint,
	createDeployedContract,
	checkpointedStep,
	checkpointedBatch,
	isCompleted,
	markCompleted,
} from "./checkpoint.js"
import { deployDiamond } from "./diamond.js"
import { getConnection } from "./helpers.js"
import { deployInstantLayer } from "./instantLayer.js"
import { deploySymmioPartyB } from "./partyB.js"
import { deployStablecoin } from "./stablecoin.js"

interface DeploymentResult {
	contract: string
	address: string
	status: "success" | "failed" | "skipped"
	error?: string
	timestamp: string
}

interface SystemDeploymentReport {
	deployments: DeploymentResult[]
	config: {
		admin: string
		symmioFeeReceiver: string
		collateralAddress: string
		deployPartyB: boolean
		registerDummyAffiliate: boolean
		setupInstantLayerTemplates: boolean
	}
	summary: {
		totalContracts: number
		successfulDeployments: number
		failedDeployments: number
		skippedDeployments: number
	}
	timestamp: string
}

interface DeployedContracts {
	collateral?: string
	diamond?: string
	accountLayerDiamond?: string
	instantLayer?: string
	symmioPartyB?: string
	accountManager?: string
}

async function getEnvConfig(hre: any) {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()

	// Admin defaults to deployer wallet if not set
	const admin = process.env.ADMIN_PUBLIC_KEY || deployer.address
	const symmioFeeReceiver = process.env.SYMMIO_FEE_RECEIVER || admin
	const collateralAddress = process.env.COLLATERAL_ADDRESS || ""
	// Default to true unless explicitly set to "false"
	const deployPartyB = process.env.DEPLOY_PARTYB !== "false"
	const registerDummyAffiliate = process.env.REGISTER_DUMMY_AFFILIATE !== "false"
	// Optional signer address for SymmioPartyB (ERC-1271 signature verification)
	const partyBSigner = process.env.PARTYB_SIGNER || ""
	// Setup InstantLayer templates (default: true, set to "false" to skip)
	const setupInstantLayerTemplates = process.env.SETUP_INSTANT_LAYER_TEMPLATES !== "false"

	return {
		admin,
		symmioFeeReceiver,
		collateralAddress,
		deployPartyB,
		registerDummyAffiliate,
		partyBSigner,
		setupInstantLayerTemplates,
	}
}

type DeploymentStep = {
	id: string
	title: string
	order: number
	run: () => Promise<void>
}

async function runDeploymentStep(checkpoint: DeploymentCheckpoint, step: DeploymentStep): Promise<void> {
	checkpoint.step = step.id
	saveCheckpoint(checkpoint)
	console.log(`Step ${step.order}: ${step.title}...`)
	await step.run()
}

export const deployAllTask = task("deploy:system", "Deploys all system contracts and sets up the complete environment")
	.addOption({ name: "verify", description: "Verify contracts after deployment", type: ArgumentType.BOOLEAN, defaultValue: false })
	.addOption({ name: "logData", description: "Write deployment addresses to data files", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({ name: "fresh", description: "Ignore checkpoint and start fresh deployment", type: ArgumentType.BOOLEAN, defaultValue: false })
	.setAction(async () => ({
		default: async ({ verify, logData, fresh }, hre) => {
			const { ethers } = await getConnection(hre)
			const [deployer] = await ethers.getSigners()
			const deployerAddress = deployer.address
			const config = await getEnvConfig(hre)
			const network = hre.network?.name || "localhost"
			const chainId = (await ethers.provider.getNetwork()).chainId

			// Check for existing checkpoint (using chainId as primary identifier)
			let checkpoint: DeploymentCheckpoint | null = null
			if (!fresh) {
				checkpoint = loadCheckpoint(Number(chainId))
				if (checkpoint) {
					displayCheckpointStatus(checkpoint)
					console.log("Resuming deployment from checkpoint...")
					console.log("Use --fresh=true flag to start a new deployment.\n")
				}
			}

			// Create new checkpoint if none exists
			if (!checkpoint) {
				checkpoint = createCheckpoint(network, Number(chainId))
			}

			console.log("=".repeat(80))
			console.log("SYSTEM DEPLOYMENT STARTED")
			console.log("=".repeat(80))
			console.log(`Network: ${network}`)
			console.log(`Chain ID: ${chainId}`)
			console.log(`Deployer: ${deployer.address}`)
			console.log(`Admin: ${config.admin}`)
			console.log(`Symmio Fee Receiver: ${config.symmioFeeReceiver}`)
			console.log(`Collateral Address: ${config.collateralAddress || "(will deploy FakeStablecoin)"}`)
			console.log(`Deploy PartyB: ${config.deployPartyB}`)
			console.log(`PartyB Signer: ${config.partyBSigner || "(not set)"}`)
			console.log(`Register Dummy Affiliate: ${config.registerDummyAffiliate}`)
			console.log(`Setup InstantLayer Templates: ${config.setupInstantLayerTemplates}`)
			console.log("=".repeat(80))
			console.log()

			const deploymentResults: DeploymentResult[] = []
			const deployedContracts: DeployedContracts = {}

			await runDeploymentStep(checkpoint, {
				id: "collateral",
				title: "Setting up Collateral",
				order: 1,
				run: async () => {
					if (config.collateralAddress) {
						console.log(`Using existing collateral at: ${config.collateralAddress}`)
						deployedContracts.collateral = config.collateralAddress
						// Save to checkpoint for reference
						if (!checkpoint.contracts.collateral) {
							checkpoint.contracts.collateral = createDeployedContract(config.collateralAddress)
							saveCheckpoint(checkpoint)
						}
						deploymentResults.push({
							contract: "Collateral (existing)",
							address: config.collateralAddress,
							status: "skipped",
							timestamp: new Date().toISOString(),
						})
					} else {
						try {
							const wasAlreadyDeployed = !!checkpoint.contracts.collateral
							console.log(wasAlreadyDeployed ? "Resuming FakeStablecoin..." : "Deploying FakeStablecoin...")
							const stablecoin = await deployStablecoin(hre, { logData, checkpoint })
							deployedContracts.collateral = await stablecoin.getAddress()
							console.log(`FakeStablecoin deployed at: ${deployedContracts.collateral}`)
							deploymentResults.push({
								contract: "FakeStablecoin",
								address: deployedContracts.collateral!,
								status: wasAlreadyDeployed ? "skipped" : "success",
								timestamp: new Date().toISOString(),
							})
						} catch (err: any) {
							console.error(`Failed to deploy FakeStablecoin: ${err.message}`)
							deploymentResults.push({
								contract: "FakeStablecoin",
								address: "N/A",
								status: "failed",
								error: err.message,
								timestamp: new Date().toISOString(),
							})
							throw err
						}
					}
					console.log()
				},
			})

			await runDeploymentStep(checkpoint, {
				id: "diamond",
				title: "Deploying Diamond",
				order: 2,
				run: async () => {
					try {
						const wasAlreadyComplete = !!checkpoint.contracts.diamond?.diamondCutComplete
						const diamond = await deployDiamond(hre, { logData, genABI: false, reportGas: false, checkpoint })
						deployedContracts.diamond = await diamond.getAddress()
						console.log(`Diamond deployed at: ${deployedContracts.diamond}`)
						deploymentResults.push({
							contract: "Diamond",
							address: deployedContracts.diamond,
							status: wasAlreadyComplete ? "skipped" : "success",
							timestamp: new Date().toISOString(),
						})
					} catch (err: any) {
						console.error(`Failed to deploy Diamond: ${err.message}`)
						deploymentResults.push({
							contract: "Diamond",
							address: "N/A",
							status: "failed",
							error: err.message,
							timestamp: new Date().toISOString(),
						})
						throw err
					}
					console.log()
				},
			})

			await runDeploymentStep(checkpoint, {
				id: "accountLayerDiamond",
				title: "Deploying AccountLayer Diamond",
				order: 3,
				run: async () => {
					try {
						const wasAlreadyComplete = !!checkpoint.contracts.accountLayerDiamond?.diamondCutComplete
						const accountLayerResult = await deployAccountLayerDiamond(hre, {
							admin: deployer,
							symmioFeeReceiver: deployer,
							logData,
							checkpoint,
						})
						deployedContracts.accountLayerDiamond = accountLayerResult.diamond
						console.log(`AccountLayerDiamond deployed at: ${deployedContracts.accountLayerDiamond}`)
						deploymentResults.push({
							contract: "AccountLayerDiamond",
							address: deployedContracts.accountLayerDiamond,
							status: wasAlreadyComplete ? "skipped" : "success",
							timestamp: new Date().toISOString(),
						})
					} catch (err: any) {
						console.error(`Failed to deploy AccountLayerDiamond: ${err.message}`)
						deploymentResults.push({
							contract: "AccountLayerDiamond",
							address: "N/A",
							status: "failed",
							error: err.message,
							timestamp: new Date().toISOString(),
						})
						throw err
					}
					console.log()
				},
			})

			await runDeploymentStep(checkpoint, {
				id: "instantLayer",
				title: "Deploying InstantLayer",
				order: 4,
				run: async () => {
					try {
						const wasAlreadyDeployed = !!checkpoint.contracts.instantLayer
						const instantLayer = await deployInstantLayer(hre, {
							symmioaddress: deployedContracts.diamond!,
							admin: deployerAddress,
							logData,
							checkpoint,
						})
						deployedContracts.instantLayer = await instantLayer.getAddress()
						console.log(`InstantLayer deployed at: ${deployedContracts.instantLayer}`)
						deploymentResults.push({
							contract: "InstantLayer",
							address: deployedContracts.instantLayer,
							status: wasAlreadyDeployed ? "skipped" : "success",
							timestamp: new Date().toISOString(),
						})
					} catch (err: any) {
						console.error(`Failed to deploy InstantLayer: ${err.message}`)
						deploymentResults.push({
							contract: "InstantLayer",
							address: "N/A",
							status: "failed",
							error: err.message,
							timestamp: new Date().toISOString(),
						})
						throw err
					}
					console.log()
				},
			})

			if (config.deployPartyB) {
				await runDeploymentStep(checkpoint, {
					id: "symmioPartyB",
					title: "Deploying SymmioPartyB",
					order: 5,
					run: async () => {
						try {
							const wasAlreadyDeployed = !!checkpoint.contracts.symmioPartyB
							const symmioPartyB = await deploySymmioPartyB(hre, {
								symmioAddress: deployedContracts.diamond!,
								admin: deployerAddress,
								logData,
								checkpoint,
							})
							deployedContracts.symmioPartyB = await symmioPartyB.getAddress()
							console.log(`SymmioPartyB deployed at: ${deployedContracts.symmioPartyB}`)
							deploymentResults.push({
								contract: "SymmioPartyB",
								address: deployedContracts.symmioPartyB,
								status: wasAlreadyDeployed ? "skipped" : "success",
								timestamp: new Date().toISOString(),
							})
						} catch (err: any) {
							console.error(`Failed to deploy SymmioPartyB: ${err.message}`)
							deploymentResults.push({
								contract: "SymmioPartyB",
								address: "N/A",
								status: "failed",
								error: err.message,
								timestamp: new Date().toISOString(),
							})
							throw err
						}
						console.log()
					},
				})
			}

			await runDeploymentStep(checkpoint, {
				id: "systemSetup",
				title: "Setting up system roles and connections",
				order: 6,
				run: async () => {
					if (!checkpoint.setupComplete?.systemRoles) {
						await setupSystem(hre, deployedContracts, config, checkpoint)
						checkpoint.setupComplete = checkpoint.setupComplete || {}
						checkpoint.setupComplete.systemRoles = true
						saveCheckpoint(checkpoint)
					} else {
						console.log("  ⏭ System roles already configured")
					}
					console.log()
				},
			})

			if (config.setupInstantLayerTemplates) {
				await runDeploymentStep(checkpoint, {
					id: "instantLayerTemplates",
					title: "Setting up InstantLayer templates",
					order: 7,
					run: async () => {
						if (!checkpoint.setupComplete?.instantLayerTemplates) {
							await setupInstantLayerTemplates(hre, deployedContracts, checkpoint)
							checkpoint.setupComplete = checkpoint.setupComplete || {}
							checkpoint.setupComplete.instantLayerTemplates = true
							saveCheckpoint(checkpoint)
						} else {
							console.log("  ⏭ InstantLayer templates already configured")
						}
						console.log()
					},
				})
			}

			if (config.registerDummyAffiliate) {
				await runDeploymentStep(checkpoint, {
					id: "dummyAffiliate",
					title: "Registering dummy affiliate",
					order: 8,
					run: async () => {
						if (!checkpoint.setupComplete?.dummyAffiliate) {
							const accountManagerAddress = await registerDummyAffiliate(hre, deployedContracts, config, checkpoint)
							if (accountManagerAddress) {
								deployedContracts.accountManager = accountManagerAddress
								checkpoint.contracts.accountManager = createDeployedContract(accountManagerAddress)
								checkpoint.setupComplete = checkpoint.setupComplete || {}
								checkpoint.setupComplete.dummyAffiliate = true
								saveCheckpoint(checkpoint)
								deploymentResults.push({
									contract: "AccountManager (Dummy Affiliate)",
									address: accountManagerAddress,
									status: "success",
									timestamp: new Date().toISOString(),
								})
							}
						} else {
							console.log("  ⏭ Dummy affiliate already registered")
							if (checkpoint.contracts.accountManager) {
								deployedContracts.accountManager = checkpoint.contracts.accountManager.address
								deploymentResults.push({
									contract: "AccountManager (Dummy Affiliate)",
									address: checkpoint.contracts.accountManager.address,
									status: "skipped",
									timestamp: new Date().toISOString(),
								})
							}
						}
						console.log()
					},
				})
			}

			await runDeploymentStep(checkpoint, {
				id: "transferOwnership",
				title: "Transferring Diamond ownership to admin",
				order: 9,
				run: async () => {
					const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", deployedContracts.diamond!)
					await checkpointedStep(checkpoint, "setup.transferOwnership", "Transferring ownership to admin", async () => {
						await controlFacet.connect(deployer).transferOwnership(config.admin)
					})
					if (config.admin.toLowerCase() === deployer.address.toLowerCase()) {
						await checkpointedStep(checkpoint, "setup.acceptOwnership", "Accepting ownership transfer (admin = deployer)", async () => {
							await controlFacet.connect(deployer).acceptOwnership()
						})
					} else {
						console.log(`  ⏭ Admin must call acceptOwnership() to finalize: ${config.admin}`)
					}
					console.log()
				},
			})

			// Mark deployment as complete
			checkpoint.step = "complete"
			saveCheckpoint(checkpoint)

			// Generate and display report
			console.log()
			console.log("=".repeat(80))
			console.log("DEPLOYMENT REPORT")
			console.log("=".repeat(80))
			console.log()

			const report = generateReport(deploymentResults, config)
			displayReport(report, deployedContracts)
			saveReport(report, deployedContracts)

			// Clear checkpoint on successful completion
			clearCheckpoint(Number(chainId), network)
			console.log("Checkpoint cleared - deployment complete!")

			return {
				deployments: deployedContracts,
				report,
			}
		},
	}))
	.build()

async function setupSystem(
	hre: any,
	deployedContracts: DeployedContracts,
	config: ReturnType<typeof getEnvConfig>,
	checkpoint: DeploymentCheckpoint,
) {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()
	const deployerAddress = deployer.address

	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", deployedContracts.diamond!)
	const alControlFacet = await ethers.getContractAt(
		"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
		deployedContracts.accountLayerDiamond!,
	)
	const instantLayer = await ethers.getContractAt("InstantLayer", deployedContracts.instantLayer!)
	const roleHash = (role: string) => ethers.keccak256(ethers.toUtf8Bytes(role))
	const instantLayerDefaultAdminRole = await instantLayer.DEFAULT_ADMIN_ROLE()

	// Diamond admin setup
	await checkpointedStep(checkpoint, "setup.setDeployerAdmin", "Granting DEFAULT_ADMIN_ROLE to deployer on Diamond", async () => {
		await controlFacet.connect(deployer).setAdmin(deployerAddress)
	})

	await checkpointedStep(checkpoint, "setup.setAdmin", "Setting admin on Diamond", async () => {
		await controlFacet.connect(deployer).setAdmin(config.admin)
	})

	// Grant roles to admin on Diamond (batch)
	const diamondRoles = [
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
	await checkpointedBatch(checkpoint, "setup.diamondRoles", diamondRoles, "Granting roles to admin on Diamond", async role => {
		await controlFacet.connect(deployer).grantRole(config.admin, roleHash(role))
	})

	// AccountLayerDiamond roles on Diamond
	await checkpointedStep(checkpoint, "setup.alRolesOnDiamond", "Granting roles to AccountLayerDiamond on Diamond", async () => {
		await controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("SIGNER_ADMIN_ROLE"))
		await controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("AFFILIATE_MANAGER_ROLE"))
		await controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("INTERNAL_TRANSFER_TO_BALANCE_ROLE"))
	})

	// InstantLayer role on Diamond
	await checkpointedStep(checkpoint, "setup.ilRoleOnDiamond", "Granting INSTANT_LAYER_ROLE to InstantLayer on Diamond", async () => {
		await controlFacet.connect(deployer).grantRole(deployedContracts.instantLayer!, roleHash("INSTANT_LAYER_ROLE"))
	})

	// AccountLayerDiamond admin roles
	await checkpointedStep(checkpoint, "setup.alDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on AccountLayerDiamond to admin", async () => {
		await alControlFacet.connect(deployer).grantRole(config.admin, roleHash("DEFAULT_ADMIN_ROLE"))
	})

	await checkpointedStep(checkpoint, "setup.alAdminRoles", "Setting up AccountLayerDiamond admin roles", async () => {
		await alControlFacet.connect(deployer).grantRole(config.admin, roleHash("SETTER_ROLE"))
		await alControlFacet.connect(deployer).grantRole(config.admin, roleHash("APPROVER_ROLE"))
		await alControlFacet.connect(deployer).grantRole(config.admin, roleHash("PAUSER_ROLE"))
		await alControlFacet.connect(deployer).grantRole(config.admin, roleHash("UNPAUSER_ROLE"))
	})

	// InstantLayer role on AccountLayerDiamond
	await checkpointedStep(checkpoint, "setup.ilRoleOnAL", "Granting INSTANT_LAYER_ROLE on AccountLayerDiamond", async () => {
		await alControlFacet.connect(deployer).grantRole(deployedContracts.instantLayer!, roleHash("INSTANT_LAYER_ROLE"))
	})

	// Whitelist Symmio Core
	await checkpointedStep(checkpoint, "setup.alWhitelistSymmio", "Whitelisting Symmio Core on AccountLayerDiamond", async () => {
		await alControlFacet.connect(deployer).setWhitelistedSymmioCore(deployedContracts.diamond!, true)
	})

	// InstantLayer AccountLayer
	await checkpointedStep(checkpoint, "setup.ilSetAccountLayer", "Setting AccountLayer on InstantLayer", async () => {
		await instantLayer.connect(deployer).setAccountLayer(deployedContracts.accountLayerDiamond!)
	})

	// Diamond system parameters
	console.log("  Configuring Diamond system parameters...")
	const parameterSetters: Array<{ key: string; name: string; action: () => Promise<void> }> = [
		{ key: "setup.setCollateral", name: "setCollateral", action: () => controlFacet.connect(deployer).setCollateral(deployedContracts.collateral!) },
		{
			key: "setup.setBalanceLimitPerUser",
			name: "setBalanceLimitPerUser",
			action: () => controlFacet.connect(deployer).setBalanceLimitPerUser(ethers.parseEther("10000")),
		},
		{
			key: "setup.setMaxWithdrawParts",
			name: "setMaxWithdrawParts",
			action: () => controlFacet.connect(deployer).setMaxWithdrawParts(30),
		},
		{ key: "setup.setDeallocateCooldown", name: "setDeallocateCooldown", action: () => controlFacet.connect(deployer).setDeallocateCooldown(120) },
		{ key: "setup.setSettlementCooldown", name: "setSettlementCooldown", action: () => controlFacet.connect(deployer).setSettlementCooldown(300) },
		{
			key: "setup.setDeallocateDebounceTime",
			name: "setDeallocateDebounceTime",
			action: () => controlFacet.connect(deployer).setDeallocateDebounceTime(120),
		},
		{
			key: "setup.setLiquidatorShare",
			name: "setLiquidatorShare",
			action: () => controlFacet.connect(deployer).setLiquidatorShare(ethers.parseEther("0.1")),
		},
		{ key: "setup.setLiquidationTimeout", name: "setLiquidationTimeout", action: () => controlFacet.connect(deployer).setLiquidationTimeout(100) },
		{
			key: "setup.setForceCloseCooldowns",
			name: "setForceCloseCooldowns",
			action: () => controlFacet.connect(deployer).setForceCloseCooldowns(300, 120),
		},
		{ key: "setup.setForceCancelCooldown", name: "setForceCancelCooldown", action: () => controlFacet.connect(deployer).setForceCancelCooldown(300) },
		{
			key: "setup.setForceCancelCloseCooldown",
			name: "setForceCancelCloseCooldown",
			action: () => controlFacet.connect(deployer).setForceCancelCloseCooldown(300),
		},
		{
			key: "setup.setPendingQuotesValidLength",
			name: "setPendingQuotesValidLength",
			action: () => controlFacet.connect(deployer).setPendingQuotesValidLength(10),
		},
		{
			key: "setup.setMaxPartyAConnectionLimit",
			name: "setMaxPartyAConnectionLimit",
			action: () => controlFacet.connect(deployer).setMaxPartyAConnectionLimit(5),
		},
		{
			key: "setup.setInvalidBridgedAmountsPool",
			name: "setInvalidBridgedAmountsPool",
			action: () => controlFacet.connect(deployer).setInvalidBridgedAmountsPool(config.admin),
		},
	]
	for (const { key, name, action } of parameterSetters) {
		const executed = await checkpointedStep(checkpoint, key, name, action, { indent: "    ", skipLog: true })
		if (executed) console.log(`    ✓ ${name}`)
	}

	// InstantLayer roles and whitelist
	await checkpointedStep(checkpoint, "setup.ilDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on InstantLayer to admin", async () => {
		await instantLayer.connect(deployer).grantRole(instantLayerDefaultAdminRole, config.admin)
	})

	await checkpointedStep(checkpoint, "setup.ilGrantSetterRole", "Granting SETTER_ROLE on InstantLayer to admin", async () => {
		await instantLayer.connect(deployer).grantRole(roleHash("SETTER_ROLE"), config.admin)
	})

	await checkpointedStep(checkpoint, "setup.ilWhitelistDiamond", "Whitelisting Symmio (Diamond) on InstantLayer", async () => {
		await instantLayer.connect(deployer).setTargetWhitelist(deployedContracts.diamond!, true)
	})

	await checkpointedStep(checkpoint, "setup.ilWhitelistAL", "Whitelisting AccountLayerDiamond on InstantLayer", async () => {
		await instantLayer.connect(deployer).setTargetWhitelist(deployedContracts.accountLayerDiamond!, true)
	})

	// PartyB setup (if deployed)
	if (deployedContracts.symmioPartyB) {
		await checkpointedStep(checkpoint, "setup.registerPartyB", "Registering SymmioPartyB in Diamond", async () => {
			await controlFacet.connect(deployer).registerPartyB(deployedContracts.symmioPartyB!)
		})

		const symmioPartyB = await ethers.getContractAt("SymmioPartyB", deployedContracts.symmioPartyB)
		const partyBDefaultAdminRole = await symmioPartyB.DEFAULT_ADMIN_ROLE()

		await checkpointedStep(checkpoint, "setup.pbDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE to admin on SymmioPartyB", async () => {
			await symmioPartyB.connect(deployer).grantRole(partyBDefaultAdminRole, config.admin)
		})

		await checkpointedStep(checkpoint, "setup.pbTrustedRole", "Granting TRUSTED_ROLE to InstantLayer on SymmioPartyB", async () => {
			await symmioPartyB.connect(deployer).grantRole(roleHash("TRUSTED_ROLE"), deployedContracts.instantLayer!)
		})

		await checkpointedStep(checkpoint, "setup.pbManagerRole", "Granting MANAGER_ROLE to admin on SymmioPartyB", async () => {
			await symmioPartyB.connect(deployer).grantRole(roleHash("MANAGER_ROLE"), config.admin)
		})

		await checkpointedStep(checkpoint, "setup.pbSetterRole", "Granting SETTER_ROLE to admin on SymmioPartyB", async () => {
			await symmioPartyB.connect(deployer).grantRole(roleHash("SETTER_ROLE"), config.admin)
		})

		await checkpointedStep(checkpoint, "setup.pbMulticastWhitelist", "Setting multicastWhitelist for InstantLayer on SymmioPartyB", async () => {
			await symmioPartyB.connect(deployer).setMulticastWhitelist(deployedContracts.instantLayer!, true)
		})

		if (config.partyBSigner) {
			await checkpointedStep(checkpoint, "setup.pbSetSigner", "Setting signer on SymmioPartyB", async () => {
				await symmioPartyB.connect(deployer).setSigner(config.partyBSigner)
			})
		}

		await checkpointedStep(checkpoint, "setup.ilRegisterPartyB", "Registering SymmioPartyB on InstantLayer (also grants OPERATOR_ROLE)", async () => {
			await instantLayer.connect(deployer).registerPartyBs([deployedContracts.symmioPartyB!])
		})
	}

	console.log("  System setup complete!")
}

async function registerDummyAffiliate(
	hre: any,
	deployedContracts: DeployedContracts,
	config: ReturnType<typeof getEnvConfig>,
	checkpoint: DeploymentCheckpoint,
): Promise<string | null> {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()

	const alAffiliateFacet = await ethers.getContractAt(
		"contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet",
		deployedContracts.accountLayerDiamond!,
	)

	const affiliateData = {
		name: "Test Affiliate",
		brandColor: "d69d00",
		admin: config.admin,
		stakeholders: [{ receiver: config.admin, share: ethers.parseEther("0.9") }],
		symmioShare: ethers.parseEther("0.1"),
		metadata: "0x",
		legacyMultiAccounts: [],
		symmioCores: [deployedContracts.diamond!],
	}

	// Register affiliate (only get predicted address if not already registered)
	let accountManagerAddress: string | undefined = checkpoint.contracts.accountManager?.address

	await checkpointedStep(checkpoint, "affiliate.register", "Registering dummy affiliate", async () => {
		// Get predicted account manager address (view call, no tx) - only if not resuming
		accountManagerAddress = await alAffiliateFacet.connect(deployer).requestToRegisterAffiliate.staticCall(affiliateData)
		await alAffiliateFacet.connect(deployer).requestToRegisterAffiliate(affiliateData)
		// Save the predicted address so we can use it on resume
		checkpoint.contracts.accountManager = createDeployedContract(accountManagerAddress)
		saveCheckpoint(checkpoint)
	})

	// Approve affiliate
	await checkpointedStep(checkpoint, "affiliate.approve", "Approving affiliate", async () => {
		await alAffiliateFacet.connect(deployer).approveAffiliate(accountManagerAddress!)
	})

	console.log(`  Dummy affiliate registered! AccountManager: ${accountManagerAddress}`)

	return accountManagerAddress!
}

/**
 * Sets up InstantLayer templates for OpenPosition and ClosePosition flows
 *
 * OpenPosition Template (6 operations):
 * 0. predictNextVirtualAccountAddress -> returns virtualAccount address
 * 1. addMargin(virtualAccount, amount) -> virtualAccount from op 0
 * 2. sendQuoteWithAffiliateAndData -> returns quoteId
 * 3. allocateForPartyB(amount, partyA) -> partyA from op 0
 * 4. lockQuote(quoteId, upnlSig) -> quoteId from op 2
 * 5. openPosition(quoteId, filledAmount, openedPrice, upnlSig) -> quoteId from op 2
 *
 * ClosePosition Template (4 operations):
 * 0. predictNextVirtualAccountAddress -> returns virtualAccount address
 * 1. requestToClosePosition(quoteId, closePrice, quantityToClose, orderType, deadline) -> no dependencies
 * 2. fillCloseRequest(quoteId, filledAmount, closedPrice, upnlSig) -> no dependencies
 * 3. deallocateForPartyB(amount, partyA, upnlSig) -> partyA from op 0
 */
async function setupInstantLayerTemplates(hre: any, deployedContracts: DeployedContracts, checkpoint: DeploymentCheckpoint): Promise<void> {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()

	const instantLayer = await ethers.getContractAt("InstantLayer", deployedContracts.instantLayer!)

	// OpenPosition Template
	await checkpointedStep(checkpoint, "templates.openPosition", "Adding OpenPosition template", async () => {
		const openPositionOps = [
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0: predictNextVirtualAccountAddress
			{ sourceIndices: [0], insertionPoints: [0], sourceOffsets: [0] }, // op 1: addMargin - first param from op 0
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 2: sendQuoteWithAffiliateAndData
			{ sourceIndices: [0], insertionPoints: [32], sourceOffsets: [0] }, // op 3: allocateForPartyB - second param from op 0
			{ sourceIndices: [2], insertionPoints: [0], sourceOffsets: [0] }, // op 4: lockQuote - first param from op 2
			{ sourceIndices: [2], insertionPoints: [0], sourceOffsets: [0] }, // op 5: openPosition - first param from op 2
		]
		await instantLayer.connect(deployer).addTemplate("OpenPosition", openPositionOps)
	})

	// ClosePosition Template
	await checkpointedStep(checkpoint, "templates.closePosition", "Adding ClosePosition template", async () => {
		const closePositionOps = [
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0: predictNextVirtualAccountAddress
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1: requestToClosePosition
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 2: fillCloseRequest
			{ sourceIndices: [0], insertionPoints: [32], sourceOffsets: [0] }, // op 3: deallocateForPartyB - second param from op 0
		]
		await instantLayer.connect(deployer).addTemplate("ClosePosition", closePositionOps)
	})

	console.log("  InstantLayer templates setup complete!")
}

function generateReport(deployments: DeploymentResult[], config: ReturnType<typeof getEnvConfig>): SystemDeploymentReport {
	const successfulDeployments = deployments.filter(d => d.status === "success").length
	const failedDeployments = deployments.filter(d => d.status === "failed").length
	const skippedDeployments = deployments.filter(d => d.status === "skipped").length

	return {
		deployments,
		config: {
			admin: config.admin,
			symmioFeeReceiver: config.symmioFeeReceiver,
			collateralAddress: config.collateralAddress,
			deployPartyB: config.deployPartyB,
			registerDummyAffiliate: config.registerDummyAffiliate,
			setupInstantLayerTemplates: config.setupInstantLayerTemplates,
		},
		summary: {
			totalContracts: deployments.length,
			successfulDeployments,
			failedDeployments,
			skippedDeployments,
		},
		timestamp: new Date().toISOString(),
	}
}

function displayReport(report: SystemDeploymentReport, deployedContracts: DeployedContracts): void {
	console.log("DEPLOYMENT SUMMARY")
	console.log("-".repeat(80))
	console.log(`Total Contracts: ${report.summary.totalContracts}`)
	console.log(`Successful: ${report.summary.successfulDeployments}`)
	console.log(`Skipped (from checkpoint): ${report.summary.skippedDeployments}`)
	console.log(`Failed: ${report.summary.failedDeployments}`)
	console.log()

	console.log("DEPLOYED ADDRESSES")
	console.log("-".repeat(80))
	if (deployedContracts.collateral) console.log(`Collateral:           ${deployedContracts.collateral}`)
	if (deployedContracts.diamond) console.log(`Diamond:              ${deployedContracts.diamond}`)
	if (deployedContracts.accountLayerDiamond) console.log(`AccountLayerDiamond:  ${deployedContracts.accountLayerDiamond}`)
	if (deployedContracts.instantLayer) console.log(`InstantLayer:         ${deployedContracts.instantLayer}`)
	if (deployedContracts.symmioPartyB) console.log(`SymmioPartyB:         ${deployedContracts.symmioPartyB}`)
	if (deployedContracts.accountManager) console.log(`AccountManager:       ${deployedContracts.accountManager}`)
	console.log()

	console.log("CONFIGURATION")
	console.log("-".repeat(80))
	console.log(`Admin:                       ${report.config.admin}`)
	console.log(`Symmio Fee Receiver:         ${report.config.symmioFeeReceiver}`)
	console.log(`Deploy PartyB:               ${report.config.deployPartyB}`)
	console.log(`Register Dummy Affiliate:    ${report.config.registerDummyAffiliate}`)
	console.log(`Setup InstantLayer Templates: ${report.config.setupInstantLayerTemplates}`)
	console.log()

	console.log("=".repeat(80))
	console.log(`Report generated at: ${report.timestamp}`)
	console.log("=".repeat(80))
}

function saveReport(report: SystemDeploymentReport, deployedContracts: DeployedContracts): void {
	try {
		const filename = "deployment-report.json"
		const fullReport = {
			...report,
			addresses: deployedContracts,
		}

		writeData(filename, fullReport)

		console.log()
		console.log(`Full report saved to: data/${filename}`)
	} catch (err: any) {
		console.error(`Failed to save report: ${err.message}`)
	}
}
