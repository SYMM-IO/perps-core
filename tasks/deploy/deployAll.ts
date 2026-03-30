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
import { deploySignatureVerifier } from "./signatureVerifier.js"
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
		signatureVerifierAddress: string
		muonAppId: string
		muonUpnlValidTime: string
		muonPriceValidTime: string
		muonPublicKeyX: string
		muonPublicKeyParity: string
		muonGatewaySigners: string[]
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
	signatureVerifier?: string
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
	// Optional: use existing MuonSignatureVerifier address instead of deploying
	const signatureVerifierAddress = process.env.MUON_SIGNATURE_VERIFIER_ADDRESS || ""
	// Deploy MockMuonSignatureVerifier (accepts all signatures) instead of MuonSignatureVerifier
	const deployMockVerifier = process.env.DEPLOY_MOCK_VERIFIER === "true"
	// Muon runtime config (defaults: 300s validity for both)
	const muonAppId = process.env.MUON_APP_ID || ""
	const muonUpnlValidTime = process.env.MUON_UPNL_VALID_TIME || "300"
	const muonPriceValidTime = process.env.MUON_PRICE_VALID_TIME || "300"
	const muonPublicKeyX = process.env.MUON_PUBLIC_KEY_X || ""
	const muonPublicKeyParity = process.env.MUON_PUBLIC_KEY_PARITY || ""
	const muonGatewaySigners = (process.env.MUON_GATEWAY_SIGNERS || "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean)

	return {
		admin,
		symmioFeeReceiver,
		collateralAddress,
		deployPartyB,
		registerDummyAffiliate,
		partyBSigner,
		setupInstantLayerTemplates,
		signatureVerifierAddress,
		deployMockVerifier,
		muonAppId,
		muonUpnlValidTime,
		muonPriceValidTime,
		muonPublicKeyX,
		muonPublicKeyParity,
		muonGatewaySigners,
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
	.addOption({
		name: "deployFakeStablecoin",
		description: "Deploy FakeStablecoin as collateral (overrides COLLATERAL_ADDRESS env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "deployPartyb",
		description: "Deploy SymmioPartyB (overrides DEPLOY_PARTYB env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "deployMockVerifier",
		description: "Deploy MockMuonSignatureVerifier instead of real verifier (overrides DEPLOY_MOCK_VERIFIER env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "registerDummyAffiliate",
		description: "Register a dummy affiliate for testing (overrides REGISTER_DUMMY_AFFILIATE env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "setupInstantLayerTemplates",
		description: "Setup InstantLayer templates (overrides SETUP_INSTANT_LAYER_TEMPLATES env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async (
			{
				verify,
				logData,
				fresh,
				deployFakeStablecoin,
				deployPartyb,
				deployMockVerifier,
				registerDummyAffiliate: registerDummyAffiliateFlag,
				setupInstantLayerTemplates: setupIlTemplatesFlag,
			},
			hre,
		) => {
			const connection = await getConnection(hre)
			const { ethers } = connection
			const [deployer] = await ethers.getSigners()
			const deployerAddress = deployer.address
			const config = await getEnvConfig(hre)

			// CLI flags override env vars when explicitly provided
			if (deployFakeStablecoin !== undefined && deployFakeStablecoin === "true") config.collateralAddress = ""
			if (deployPartyb !== undefined) config.deployPartyB = deployPartyb === "true"
			if (deployMockVerifier !== undefined) config.deployMockVerifier = deployMockVerifier === "true"
			if (registerDummyAffiliateFlag !== undefined) config.registerDummyAffiliate = registerDummyAffiliateFlag === "true"
			if (setupIlTemplatesFlag !== undefined) config.setupInstantLayerTemplates = setupIlTemplatesFlag === "true"
			const network = connection.networkName || "unknown"
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
			console.log(
				`Signature Verifier Address: ${config.signatureVerifierAddress || (config.deployMockVerifier ? "(will deploy MockMuonSignatureVerifier)" : "(will deploy MuonSignatureVerifier)")}`,
			)
			console.log(`Muon App ID: ${config.muonAppId || "(not set)"}`)
			console.log(`Muon UPNL Valid Time: ${config.muonUpnlValidTime}${process.env.MUON_UPNL_VALID_TIME ? "" : " (default)"}`)
			console.log(`Muon Price Valid Time: ${config.muonPriceValidTime}${process.env.MUON_PRICE_VALID_TIME ? "" : " (default)"}`)
			console.log(`Muon Public Key X: ${config.muonPublicKeyX || "(not set)"}`)
			console.log(`Muon Public Key Parity: ${config.muonPublicKeyParity || "(not set)"}`)
			console.log(`Muon Gateway Signers: ${config.muonGatewaySigners.length > 0 ? config.muonGatewaySigners.join(",") : "(not set)"}`)
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
				id: "signatureVerifier",
				title: config.deployMockVerifier ? "Setting up MockMuonSignatureVerifier" : "Setting up MuonSignatureVerifier",
				order: 3,
				run: async () => {
					if (config.signatureVerifierAddress) {
						console.log(`Using existing MuonSignatureVerifier at: ${config.signatureVerifierAddress}`)
						deployedContracts.signatureVerifier = config.signatureVerifierAddress
						if (!checkpoint.contracts.signatureVerifier) {
							checkpoint.contracts.signatureVerifier = createDeployedContract(config.signatureVerifierAddress)
							saveCheckpoint(checkpoint)
						}
						deploymentResults.push({
							contract: "MuonSignatureVerifier (existing)",
							address: config.signatureVerifierAddress,
							status: "skipped",
							timestamp: new Date().toISOString(),
						})
					} else if (config.deployMockVerifier) {
						try {
							const wasAlreadyDeployed = !!checkpoint.contracts.signatureVerifier
							if (wasAlreadyDeployed) {
								const address = checkpoint.contracts.signatureVerifier!.address
								console.log(`Resuming MockMuonSignatureVerifier at ${address}...`)
								deployedContracts.signatureVerifier = address
							} else {
								console.log("Deploying MockMuonSignatureVerifier...")
								const factory = await ethers.getContractFactory("MockMuonSignatureVerifier")
								const mock = await factory.connect(deployer).deploy()
								await mock.waitForDeployment()
								await mock.deploymentTransaction()!.wait()
								deployedContracts.signatureVerifier = await mock.getAddress()
								checkpoint.contracts.signatureVerifier = createDeployedContract(deployedContracts.signatureVerifier)
								saveCheckpoint(checkpoint)
							}
							console.log(`MockMuonSignatureVerifier deployed at: ${deployedContracts.signatureVerifier}`)
							deploymentResults.push({
								contract: "MockMuonSignatureVerifier",
								address: deployedContracts.signatureVerifier,
								status: wasAlreadyDeployed ? "skipped" : "success",
								timestamp: new Date().toISOString(),
							})
						} catch (err: any) {
							console.error(`Failed to deploy MockMuonSignatureVerifier: ${err.message}`)
							deploymentResults.push({
								contract: "MockMuonSignatureVerifier",
								address: "N/A",
								status: "failed",
								error: err.message,
								timestamp: new Date().toISOString(),
							})
							throw err
						}
					} else {
						try {
							const wasAlreadyDeployed = !!checkpoint.contracts.signatureVerifier
							console.log(wasAlreadyDeployed ? "Resuming MuonSignatureVerifier..." : "Deploying MuonSignatureVerifier...")
							const signatureVerifier = await deploySignatureVerifier(hre, {
								admin: deployerAddress,
								logData,
								checkpoint,
							})
							deployedContracts.signatureVerifier = await signatureVerifier.getAddress()
							console.log(`MuonSignatureVerifier deployed at: ${deployedContracts.signatureVerifier}`)
							deploymentResults.push({
								contract: "MuonSignatureVerifier",
								address: deployedContracts.signatureVerifier,
								status: wasAlreadyDeployed ? "skipped" : "success",
								timestamp: new Date().toISOString(),
							})
						} catch (err: any) {
							console.error(`Failed to deploy MuonSignatureVerifier: ${err.message}`)
							deploymentResults.push({
								contract: "MuonSignatureVerifier",
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
				id: "accountLayerDiamond",
				title: "Deploying AccountLayer Diamond",
				order: 4,
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
				order: 5,
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
					order: 6,
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
				order: 7,
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
					order: 8,
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
					order: 9,
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
				order: 10,
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
			displayReport(report, deployedContracts, config)
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
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", deployedContracts.diamond!)
	const alControlFacet = await ethers.getContractAt(
		"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
		deployedContracts.accountLayerDiamond!,
	)
	const instantLayer = await ethers.getContractAt("InstantLayer", deployedContracts.instantLayer!)
	const isMockVerifier = !!(config as any).deployMockVerifier
	const signatureVerifier = deployedContracts.signatureVerifier
		? await ethers.getContractAt(isMockVerifier ? "MockMuonSignatureVerifier" : "MuonSignatureVerifier", deployedContracts.signatureVerifier)
		: null
	const roleHash = (role: string) => ethers.keccak256(ethers.toUtf8Bytes(role))
	const instantLayerDefaultAdminRole = await instantLayer.DEFAULT_ADMIN_ROLE()
	const requireMuonSetterOnVerifier = (hasSetterRole: boolean) => {
		if (!hasSetterRole) {
			throw new Error("Cannot seed MuonSignatureVerifier: deployer does not have SETTER_ROLE on the verifier")
		}
	}

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
		await controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("BALANCE_SETTLER_ROLE"))
	})

	// Register AccountLayer as system hook on Diamond
	await checkpointedStep(checkpoint, "setup.registerHook", "Registering AccountLayer as system hook on Diamond", async () => {
		await controlFacet.connect(deployer).registerHook(ethers.ZeroAddress, deployedContracts.accountLayerDiamond!)
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

	// InstantLayer SIGNER_SETTER_ROLE on AccountLayerDiamond (allows InstantLayer to call setSigner)
	await checkpointedStep(checkpoint, "setup.ilRoleOnAL", "Granting SIGNER_SETTER_ROLE on AccountLayerDiamond", async () => {
		await alControlFacet.connect(deployer).grantRole(deployedContracts.instantLayer!, roleHash("SIGNER_SETTER_ROLE"))
	})

	// Whitelist Symmio Core
	await checkpointedStep(checkpoint, "setup.alWhitelistSymmio", "Whitelisting Symmio Core on AccountLayerDiamond", async () => {
		await alControlFacet.connect(deployer).setWhitelistedSymmioCore(deployedContracts.diamond!, true)
	})

	// InstantLayer AccountLayer
	await checkpointedStep(checkpoint, "setup.ilSetAccountLayer", "Setting AccountLayer on InstantLayer", async () => {
		await instantLayer.connect(deployer).setAccountLayer(deployedContracts.accountLayerDiamond!)
	})

	// MuonSignatureVerifier setup
	if (signatureVerifier) {
		if (isMockVerifier) {
			// MockMuonSignatureVerifier has no AccessControl roles - just set the address on Diamond
			console.log("  Using MockMuonSignatureVerifier (no role grants needed)")

			await checkpointedStep(checkpoint, "setup.setSignatureVerifier", "Setting MockMuonSignatureVerifier on Diamond", async () => {
				await controlFacet.connect(deployer).setSignatureVerifierAddress(deployedContracts.signatureVerifier!)
			})
		} else {
			const signatureVerifierDefaultAdminRole = await signatureVerifier.DEFAULT_ADMIN_ROLE()
			const signatureVerifierSetterRole = await signatureVerifier.SETTER_ROLE()
			const deployerIsVerifierAdmin = await signatureVerifier.hasRole(signatureVerifierDefaultAdminRole, deployerAddress)
			const deployerIsVerifierSetter = await signatureVerifier.hasRole(signatureVerifierSetterRole, deployerAddress)

			if (deployerIsVerifierAdmin) {
				await checkpointedStep(checkpoint, "setup.msvDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on MuonSignatureVerifier to admin", async () => {
					await signatureVerifier.connect(deployer).grantRole(signatureVerifierDefaultAdminRole, config.admin)
				})

				await checkpointedStep(checkpoint, "setup.msvSetterRole", "Granting SETTER_ROLE on MuonSignatureVerifier to admin", async () => {
					await signatureVerifier.connect(deployer).grantRole(signatureVerifierSetterRole, config.admin)
				})
			} else {
				console.log("  ⚠ Skipping verifier role grants: deployer is not DEFAULT_ADMIN_ROLE on MuonSignatureVerifier")
			}

			await checkpointedStep(checkpoint, "setup.setSignatureVerifier", "Setting MuonSignatureVerifier on Diamond", async () => {
				await controlFacet.connect(deployer).setSignatureVerifierAddress(deployedContracts.signatureVerifier!)
			})

			const shouldSeedPublicKey = !!config.muonPublicKeyX || !!config.muonPublicKeyParity
			if (shouldSeedPublicKey) {
				requireMuonSetterOnVerifier(deployerIsVerifierSetter)
				if (config.muonPublicKeyX && config.muonPublicKeyParity) {
					const parity = Number(config.muonPublicKeyParity)
					if (parity !== 0 && parity !== 1) {
						throw new Error(`Invalid MUON_PUBLIC_KEY_PARITY: ${config.muonPublicKeyParity}. Expected 0 or 1`)
					}
					await checkpointedStep(checkpoint, "setup.msvPublicKey", "Adding Muon public key on MuonSignatureVerifier", async () => {
						const existingKeys = await signatureVerifier.getAllPublicKeys()
						const exists = existingKeys.some(
							(key: { x: bigint; parity: number }) => key.x.toString() === config.muonPublicKeyX && key.parity === parity,
						)
						if (exists) {
							console.log("  ⏭ Muon public key already present on MuonSignatureVerifier")
							return
						}
						await signatureVerifier.connect(deployer).addPublicKey({
							x: config.muonPublicKeyX,
							parity,
						})
					})
				} else {
					console.log("  ⚠ Skipping addPublicKey: both MUON_PUBLIC_KEY_X and MUON_PUBLIC_KEY_PARITY are required")
				}
			}

			if (config.muonGatewaySigners.length > 0) {
				requireMuonSetterOnVerifier(deployerIsVerifierSetter)
				await checkpointedBatch(
					checkpoint,
					"setup.msvGatewaySigners",
					config.muonGatewaySigners,
					"Adding gateway signers on MuonSignatureVerifier",
					async signer => {
						const existingSigners = (await signatureVerifier.getAllGatewaySigners()).map((s: string) => s.toLowerCase())
						if (existingSigners.includes(signer.toLowerCase())) return
						await signatureVerifier.connect(deployer).addGatewaySigner(signer)
					},
				)
			}
		}
	}

	// Muon runtime configuration on Diamond
	const shouldConfigureMuonIds = !!config.muonAppId
	if (config.muonUpnlValidTime || config.muonPriceValidTime || shouldConfigureMuonIds) {
		if (config.admin.toLowerCase() !== deployerAddress.toLowerCase()) {
			await checkpointedStep(checkpoint, "setup.muonSetterOnDeployer", "Granting MUON_SETTER_ROLE to deployer for setup", async () => {
				await controlFacet.connect(deployer).grantRole(deployerAddress, roleHash("MUON_SETTER_ROLE"))
			})
		}
	}

	if (shouldConfigureMuonIds) {
		await checkpointedStep(checkpoint, "setup.setMuonIds", "Setting Muon app ID on Diamond", async () => {
			await controlFacet.connect(deployer).setMuonIds(config.muonAppId)
		})
	}

	await checkpointedStep(checkpoint, "setup.setMuonConfig", "Setting Muon validity config on Diamond", async () => {
		await controlFacet.connect(deployer).setMuonConfig(config.muonUpnlValidTime, config.muonPriceValidTime)
	})

	// Muon verification via view/read calls
	if (signatureVerifier && deployedContracts.signatureVerifier) {
		await checkpointedStep(checkpoint, "setup.verifyMuonViews", "Verifying Muon configuration via view calls", async () => {
			const configuredVerifier = (await viewFacet.getSignatureVerifier()).toLowerCase()
			const expectedVerifier = deployedContracts.signatureVerifier!.toLowerCase()
			if (configuredVerifier !== expectedVerifier) {
				throw new Error(`Muon verifier mismatch: expected ${expectedVerifier}, got ${configuredVerifier}`)
			}

			if (config.muonAppId) {
				const muonAppId = await viewFacet.getMuonIds()
				if (muonAppId.toString() !== config.muonAppId) {
					throw new Error(`Muon app ID mismatch: expected ${config.muonAppId}, got ${muonAppId.toString()}`)
				}
			}

			{
				const muonConfig = await viewFacet.getMuonConfig()
				const upnlValidTime = muonConfig[0]
				const priceValidTime = muonConfig[1]
				if (upnlValidTime.toString() !== config.muonUpnlValidTime || priceValidTime.toString() !== config.muonPriceValidTime) {
					throw new Error(
						`Muon validity mismatch: expected (${config.muonUpnlValidTime}, ${config.muonPriceValidTime}), got (${upnlValidTime.toString()}, ${priceValidTime.toString()})`,
					)
				}
			}

			if (config.muonPublicKeyX && config.muonPublicKeyParity) {
				const parity = Number(config.muonPublicKeyParity)
				const keys = await signatureVerifier.getAllPublicKeys()
				const found = keys.some((key: { x: bigint; parity: number }) => key.x.toString() === config.muonPublicKeyX && key.parity === parity)
				if (!found) {
					throw new Error("Expected Muon public key is not present on MuonSignatureVerifier")
				}
			}

			if (config.muonGatewaySigners.length > 0) {
				const existingSigners = (await signatureVerifier.getAllGatewaySigners()).map((s: string) => s.toLowerCase())
				for (const signer of config.muonGatewaySigners) {
					if (!existingSigners.includes(signer.toLowerCase())) {
						throw new Error(`Expected Muon gateway signer is missing: ${signer}`)
					}
				}
			}
		})
	}

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
		{
			key: "setup.setDefaultFeeCollector",
			name: "setDefaultFeeCollector",
			action: () => controlFacet.connect(deployer).setDefaultFeeCollector(config.symmioFeeReceiver),
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

	// InstantOpen Template (4 ops)
	await checkpointedStep(checkpoint, "templates.instantOpen", "Adding InstantOpen template", async () => {
		const instantOpenOps = [
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0: addMarginToNextVA
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1: sendQuote
			{ sourceIndices: [1], insertionPoints: [0], sourceOffsets: [0] }, // op 2: lockQuote - quoteId from op 1
			{ sourceIndices: [1], insertionPoints: [0], sourceOffsets: [0] }, // op 3: openPosition - quoteId from op 1
		]
		await instantLayer.connect(deployer).addTemplate("InstantOpen", instantOpenOps)
	})

	// Enable instantOpenMode for InstantOpen (template id=0) — skips wasteful pending balance round-trips
	await checkpointedStep(checkpoint, "templates.instantOpenMode", "Enabling instantOpenMode on InstantOpen template", async () => {
		await instantLayer.connect(deployer).setTemplateInstantOpenMode(0, true)
	})

	// InstantClose Template (2 ops)
	await checkpointedStep(checkpoint, "templates.instantClose", "Adding InstantClose template", async () => {
		const instantCloseOps = [
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0: requestToClosePosition
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1: fillCloseRequest
		]
		await instantLayer.connect(deployer).addTemplate("InstantClose", instantCloseOps)
	})

	// InstantCloseWithAllocation Template (3 ops)
	await checkpointedStep(checkpoint, "templates.instantCloseWithAllocation", "Adding InstantCloseWithAllocation template", async () => {
		const instantCloseWithAllocationOps = [
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 2
		]
		await instantLayer.connect(deployer).addTemplate("InstantCloseWithAllocation", instantCloseWithAllocationOps)
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
			signatureVerifierAddress: config.signatureVerifierAddress,
			muonAppId: config.muonAppId,
			muonUpnlValidTime: config.muonUpnlValidTime,
			muonPriceValidTime: config.muonPriceValidTime,
			muonPublicKeyX: config.muonPublicKeyX,
			muonPublicKeyParity: config.muonPublicKeyParity,
			muonGatewaySigners: config.muonGatewaySigners,
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

function displayReport(report: SystemDeploymentReport, deployedContracts: DeployedContracts, config?: { deployMockVerifier?: boolean }): void {
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
	if (deployedContracts.signatureVerifier)
		console.log(`${config?.deployMockVerifier ? "MockMuonSigVerifier" : "MuonSignatureVerifier"}: ${deployedContracts.signatureVerifier}`)
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
	console.log(`Muon App ID:                 ${report.config.muonAppId || "(not set)"}`)
	console.log(`Muon UPNL Valid Time:        ${report.config.muonUpnlValidTime || "(not set)"}`)
	console.log(`Muon Price Valid Time:       ${report.config.muonPriceValidTime || "(not set)"}`)
	console.log(`Muon Public Key X:           ${report.config.muonPublicKeyX || "(not set)"}`)
	console.log(`Muon Public Key Parity:      ${report.config.muonPublicKeyParity || "(not set)"}`)
	console.log(
		`Muon Gateway Signers:        ${report.config.muonGatewaySigners.length > 0 ? report.config.muonGatewaySigners.join(",") : "(not set)"}`,
	)
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
