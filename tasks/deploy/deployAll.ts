import type { ContractTransactionResponse } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { ControlFacet } from "../../src/types/index.js"
import { setDataScope, writeData } from "../utils/fs.js"
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
import { setHyperEVMBigBlocks } from "./hyperevm.js"
import { deployInstantLayer } from "./instantLayer.js"
import { deploySymmioPartyB } from "./partyB.js"
import { ProtocolConfig, loadProtocolConfig } from "./protocolConfig.js"
import { assertMainnetSafe } from "./safety.js"
import { deploySignatureVerifier } from "./signatureVerifier.js"
import { deployStablecoin } from "./stablecoin.js"
import { deploySymbolManager, grantSymbolManagerDiamondRoles, grantSymbolManagerOperatorRoles } from "./symbolManager.js"
import { send } from "./tx.js"

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
		setAdlEnabled: boolean
		deploySymbolManager: boolean
		symbolManagerOperator: string
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
	symbolManager?: string
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
	// Enable ADL for the deployed SymmioPartyB (only applied when DEPLOY_PARTYB is true). Default: false.
	const setAdlEnabled = process.env.SET_ADL_ENABLED === "true"
	const deploySymbolManagerFlag = process.env.DEPLOY_SYMBOL_MANAGER !== "false"
	const registerDummyAffiliate = process.env.REGISTER_DUMMY_AFFILIATE !== "false"
	// Optional signer address for SymmioPartyB (ERC-1271 signature verification)
	const partyBSigner = process.env.PARTYB_SIGNER || ""
	// Optional operator address that will receive SYMBOL_ADDER_ROLE + SYMBOL_REMOVER_ROLE on the SymbolManager
	const symbolManagerOperator = process.env.SYMBOL_MANAGER_OPERATOR || ""
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
	const muonPublicKeyParity = process.env.MUON_PUBLIC_KEY_PARITY ?? ""
	const muonGatewaySigners = (process.env.MUON_GATEWAY_SIGNERS || "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean)

	return {
		admin,
		symmioFeeReceiver,
		collateralAddress,
		deployPartyB,
		setAdlEnabled,
		deploySymbolManager: deploySymbolManagerFlag,
		symbolManagerOperator,
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
		name: "setAdlEnabled",
		description: "Enable ADL for the deployed SymmioPartyB (overrides SET_ADL_ENABLED env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "deploySymbolManager",
		description: "Deploy SymmioSymbolManager (overrides DEPLOY_SYMBOL_MANAGER env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "symbolManagerOperator",
		description: "Address to grant SYMBOL_ADDER_ROLE + SYMBOL_REMOVER_ROLE on SymbolManager (overrides SYMBOL_MANAGER_OPERATOR env)",
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
	.addOption({
		name: "allowUnsafeMainnet",
		description:
			"Proceed on a mainnet chain even when unsafe settings (mock verifier, fake collateral, dummy affiliate, public deployer key) are active",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.setAction(async () => ({
		default: async (
			{
				verify,
				logData,
				fresh,
				deployFakeStablecoin,
				deployPartyb,
				setAdlEnabled: setAdlEnabledFlag,
				deploySymbolManager: deploySymbolManagerFlag,
				symbolManagerOperator: symbolManagerOperatorFlag,
				deployMockVerifier,
				registerDummyAffiliate: registerDummyAffiliateFlag,
				setupInstantLayerTemplates: setupIlTemplatesFlag,
				allowUnsafeMainnet,
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
			if (setAdlEnabledFlag !== undefined) config.setAdlEnabled = setAdlEnabledFlag === "true"
			if (deploySymbolManagerFlag !== undefined) config.deploySymbolManager = deploySymbolManagerFlag === "true"
			if (symbolManagerOperatorFlag !== undefined) config.symbolManagerOperator = symbolManagerOperatorFlag
			if (deployMockVerifier !== undefined) config.deployMockVerifier = deployMockVerifier === "true"
			if (registerDummyAffiliateFlag !== undefined) config.registerDummyAffiliate = registerDummyAffiliateFlag === "true"
			if (setupIlTemplatesFlag !== undefined) config.setupInstantLayerTemplates = setupIlTemplatesFlag === "true"
			const network = connection.networkName || "unknown"
			const chainId = (await ethers.provider.getNetwork()).chainId
			// Scope deployment records to this chain so a localhost run cannot pollute the
			// Arbitrum records that verify:all later reads.
			setDataScope(chainId)

			// Check for existing checkpoint (using chainId as primary identifier)
			let checkpoint: DeploymentCheckpoint | null = null
			if (!fresh) {
				checkpoint = loadCheckpoint(Number(chainId))
				if (checkpoint) {
					displayCheckpointStatus(checkpoint)
					console.log("Resuming deployment from checkpoint...")
					console.log("Use --fresh=true flag to start a new deployment.\n")
				}
			} else {
				// --fresh used to silently overwrite the existing checkpoint on the next
				// save, destroying the record of contracts already deployed on this chain.
				// Archive it into checkpoints/completed/ instead.
				if (loadCheckpoint(Number(chainId))) {
					console.log("--fresh: archiving the existing checkpoint before starting over...")
					clearCheckpoint(Number(chainId), network)
					console.log()
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
			console.log(`Set ADL Enabled: ${config.setAdlEnabled}`)
			console.log(`PartyB Signer: ${config.partyBSigner || "(not set)"}`)
			console.log(`Deploy SymbolManager: ${config.deploySymbolManager}`)
			console.log(`SymbolManager Operator: ${config.symbolManagerOperator || "(not set)"}`)
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

			// Protocol parameters and InstantLayer templates come from
			// tasks/config/protocol-<chainId>.json, falling back to built-in defaults.
			// Loaded up front so a malformed config fails before anything is deployed.
			const protocolConfig = loadProtocolConfig(chainId)

			// Refuse to deploy a testing-shaped configuration onto a real chain.
			// Runs before any on-chain action so nothing is spent or half-created.
			assertMainnetSafe(
				chainId,
				deployerAddress,
				{
					deployMockVerifier: config.deployMockVerifier,
					collateralAddress: config.collateralAddress,
					registerDummyAffiliate: config.registerDummyAffiliate,
				},
				allowUnsafeMainnet,
			)

			const deploymentResults: DeploymentResult[] = []
			const deployedContracts: DeployedContracts = {}

			// HyperEVM (chainId 999 mainnet, 998 testnet) requires big blocks for facet deployment
			const isHyperEVM = Number(chainId) === 999 || Number(chainId) === 998
			if (isHyperEVM) {
				console.log("HyperEVM detected — enabling big blocks for contract deployment...")
				await setHyperEVMBigBlocks(hre, true)
				console.log()
			}

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
							address: deployedContracts.diamond!,
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
								checkpoint.contracts.signatureVerifier = createDeployedContract(deployedContracts.signatureVerifier!)
								saveCheckpoint(checkpoint)
							}
							console.log(`MockMuonSignatureVerifier deployed at: ${deployedContracts.signatureVerifier}`)
							deploymentResults.push({
								contract: "MockMuonSignatureVerifier",
								address: deployedContracts.signatureVerifier!,
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
								address: deployedContracts.signatureVerifier!,
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
							address: deployedContracts.instantLayer!,
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
								address: deployedContracts.symmioPartyB!,
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

			if (config.deploySymbolManager) {
				await runDeploymentStep(checkpoint, {
					id: "symbolManager",
					title: "Deploying SymmioSymbolManager",
					order: 7,
					run: async () => {
						try {
							const wasAlreadyDeployed = !!checkpoint.contracts.symbolManager
							const symbolManager = await deploySymbolManager(hre, {
								symmioAddress: deployedContracts.diamond!,
								admin: config.admin,
								logData,
								checkpoint,
							})
							deployedContracts.symbolManager = await symbolManager.getAddress()
							console.log(`SymmioSymbolManager deployed at: ${deployedContracts.symbolManager}`)
							deploymentResults.push({
								contract: "SymmioSymbolManager",
								address: deployedContracts.symbolManager!,
								status: wasAlreadyDeployed ? "skipped" : "success",
								timestamp: new Date().toISOString(),
							})
						} catch (err: any) {
							console.error(`Failed to deploy SymmioSymbolManager: ${err.message}`)
							deploymentResults.push({
								contract: "SymmioSymbolManager",
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

			// All contracts are deployed — switch back to fast blocks for setup/config calls
			if (isHyperEVM) {
				console.log("Contract deployment complete — disabling big blocks for setup phase...")
				try {
					await setHyperEVMBigBlocks(hre, false)
				} catch (err: any) {
					console.warn(`  ⚠ Failed to disable big blocks: ${err.message}`)
					console.warn("  ⚠ Run 'npx hardhat hyperevm:disable-big-blocks --network hyperevm' manually after deployment.")
				}
				console.log()
			}

			await runDeploymentStep(checkpoint, {
				id: "systemSetup",
				title: "Setting up system roles and connections",
				order: 7,
				run: async () => {
					if (!checkpoint.setupComplete?.systemRoles) {
						await setupSystem(hre, deployedContracts, config, checkpoint, protocolConfig)
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
							await setupInstantLayerTemplates(hre, deployedContracts, checkpoint, protocolConfig)
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
						await send(controlFacet.connect(deployer).transferOwnership(config.admin), "transferOwnership")
					})
					if (config.admin.toLowerCase() === deployer.address.toLowerCase()) {
						await checkpointedStep(checkpoint, "setup.acceptOwnership", "Accepting ownership transfer (admin = deployer)", async () => {
							await send(controlFacet.connect(deployer).acceptOwnership(), "acceptOwnership")
						})
					} else {
						console.log(`  ⏭ Admin must call acceptOwnership() to finalize: ${config.admin}`)
					}
					console.log()
				},
			})

			await runDeploymentStep(checkpoint, {
				id: "revokeDeployerPrivileges",
				title: "Revoking deployer privileges",
				order: 11,
				run: async () => {
					await revokeDeployerPrivileges(hre, deployedContracts, config, checkpoint, deployerAddress)
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

			// --verify used to be declared and destructured but never acted on, so an
			// operator passing it shipped an entirely unverified deployment while the
			// summary still looked green. Run the real verification task.
			if (verify) {
				console.log()
				console.log("Running block-explorer verification (--verify)...")
				try {
					await hre.tasks.getTask("verify:all").run({ skip: 0, retryFailed: false })
				} catch (err) {
					console.error()
					console.error("=".repeat(80))
					console.error("DEPLOYMENT SUCCEEDED, BUT BLOCK-EXPLORER VERIFICATION FAILED")
					console.error("=".repeat(80))
					console.error(err instanceof Error ? err.message : String(err))
					console.error(`Retry with: npx hardhat verify:all --retry-failed --network ${network}`)
					throw err
				}
			}

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
	config: Awaited<ReturnType<typeof getEnvConfig>>,
	checkpoint: DeploymentCheckpoint,
	protocolConfig: ProtocolConfig,
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
		await send(controlFacet.connect(deployer).setAdmin(deployerAddress), "setAdmin")
	})

	await checkpointedStep(checkpoint, "setup.setAdmin", "Setting admin on Diamond", async () => {
		await send(controlFacet.connect(deployer).setAdmin(config.admin), "setAdmin")
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
		await send(controlFacet.connect(deployer).grantRole(config.admin, roleHash(role)), "grantRole")
	})

	// AccountLayerDiamond roles on Diamond
	await checkpointedStep(checkpoint, "setup.alRolesOnDiamond", "Granting roles to AccountLayerDiamond on Diamond", async () => {
		await send(controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("SIGNER_ADMIN_ROLE")), "grantRole")
		await send(controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("AFFILIATE_MANAGER_ROLE")), "grantRole")
		await send(controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("BALANCE_SETTLER_ROLE")), "grantRole")
	})

	// Register AccountLayer as system hook on Diamond
	await checkpointedStep(checkpoint, "setup.registerHook", "Registering AccountLayer as system hook on Diamond", async () => {
		await send(controlFacet.connect(deployer).registerHook(ethers.ZeroAddress, deployedContracts.accountLayerDiamond!), "registerHook")
	})

	// InstantLayer role on Diamond
	await checkpointedStep(checkpoint, "setup.ilRoleOnDiamond", "Granting INSTANT_LAYER_ROLE to InstantLayer on Diamond", async () => {
		await send(controlFacet.connect(deployer).grantRole(deployedContracts.instantLayer!, roleHash("INSTANT_LAYER_ROLE")), "grantRole")
	})

	// AccountLayerDiamond admin roles
	await checkpointedStep(checkpoint, "setup.alDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on AccountLayerDiamond to admin", async () => {
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("DEFAULT_ADMIN_ROLE")), "grantRole")
	})

	await checkpointedStep(checkpoint, "setup.alAdminRoles", "Setting up AccountLayerDiamond admin roles", async () => {
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("SETTER_ROLE")), "grantRole")
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("APPROVER_ROLE")), "grantRole")
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("PAUSER_ROLE")), "grantRole")
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("UNPAUSER_ROLE")), "grantRole")
	})

	// The AccountLayer is initialised with the deployer as symmioFeeReceiver, because the
	// deployer must hold admin during setup. That left SYMMIO_FEE_RECEIVER silently ignored
	// and protocol fees accruing to the deploy wallet. Correct it here.
	// onlyRole() checks the exact role — DEFAULT_ADMIN_ROLE does not imply SETTER_ROLE — so
	// the deployer needs SETTER_ROLE temporarily, and gives it straight back up.
	if (config.symmioFeeReceiver && config.symmioFeeReceiver.toLowerCase() !== deployerAddress.toLowerCase()) {
		const alViewFacet = await ethers.getContractAt(
			"contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
			deployedContracts.accountLayerDiamond!,
		)
		const currentReceiver = (await alViewFacet.symmioFeeReceiver()).toLowerCase()

		if (currentReceiver !== config.symmioFeeReceiver.toLowerCase()) {
			await checkpointedStep(checkpoint, "setup.alFeeReceiver", `Setting AccountLayer symmioFeeReceiver to ${config.symmioFeeReceiver}`, async () => {
				await send(alControlFacet.connect(deployer).grantRole(deployerAddress, roleHash("SETTER_ROLE")), "grantRole(deployer SETTER_ROLE)")
				await send(alControlFacet.connect(deployer).setSymmioFeeReceiver(config.symmioFeeReceiver), "setSymmioFeeReceiver")
				await send(alControlFacet.connect(deployer).revokeRole(deployerAddress, roleHash("SETTER_ROLE")), "revokeRole(deployer SETTER_ROLE)")
			})

			const updated = (await alViewFacet.symmioFeeReceiver()).toLowerCase()
			if (updated !== config.symmioFeeReceiver.toLowerCase()) {
				throw new Error(`AccountLayer symmioFeeReceiver is ${updated}, expected ${config.symmioFeeReceiver.toLowerCase()}`)
			}
		}
	}

	// InstantLayer SIGNER_SETTER_ROLE on AccountLayerDiamond (allows InstantLayer to call setSigner)
	await checkpointedStep(checkpoint, "setup.ilRoleOnAL", "Granting SIGNER_SETTER_ROLE on AccountLayerDiamond", async () => {
		await send(alControlFacet.connect(deployer).grantRole(deployedContracts.instantLayer!, roleHash("SIGNER_SETTER_ROLE")), "grantRole")
	})

	// Whitelist Symmio Core
	await checkpointedStep(checkpoint, "setup.alWhitelistSymmio", "Whitelisting Symmio Core on AccountLayerDiamond", async () => {
		await send(alControlFacet.connect(deployer).setWhitelistedSymmioCore(deployedContracts.diamond!, true), "setWhitelistedSymmioCore")
	})

	// InstantLayer AccountLayer
	await checkpointedStep(checkpoint, "setup.ilSetAccountLayer", "Setting AccountLayer on InstantLayer", async () => {
		await send(instantLayer.connect(deployer).setAccountLayer(deployedContracts.accountLayerDiamond!), "setAccountLayer")
	})

	// MuonSignatureVerifier setup
	if (signatureVerifier) {
		if (isMockVerifier) {
			// MockMuonSignatureVerifier has no AccessControl roles - just set the address on Diamond
			console.log("  Using MockMuonSignatureVerifier (no role grants needed)")

			await checkpointedStep(checkpoint, "setup.setSignatureVerifier", "Setting MockMuonSignatureVerifier on Diamond", async () => {
				await send(controlFacet.connect(deployer).setSignatureVerifierAddress(deployedContracts.signatureVerifier!), "setSignatureVerifierAddress")
			})
		} else {
			const signatureVerifierDefaultAdminRole = await signatureVerifier.DEFAULT_ADMIN_ROLE()
			const signatureVerifierSetterRole = await signatureVerifier.SETTER_ROLE()
			const deployerIsVerifierAdmin = await signatureVerifier.hasRole(signatureVerifierDefaultAdminRole, deployerAddress)
			const deployerIsVerifierSetter = await signatureVerifier.hasRole(signatureVerifierSetterRole, deployerAddress)

			if (deployerIsVerifierAdmin) {
				await checkpointedStep(checkpoint, "setup.msvDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on MuonSignatureVerifier to admin", async () => {
					await send(signatureVerifier.connect(deployer).grantRole(signatureVerifierDefaultAdminRole, config.admin), "grantRole")
				})

				await checkpointedStep(checkpoint, "setup.msvSetterRole", "Granting SETTER_ROLE on MuonSignatureVerifier to admin", async () => {
					await send(signatureVerifier.connect(deployer).grantRole(signatureVerifierSetterRole, config.admin), "grantRole")
				})
			} else {
				console.log("  ⚠ Skipping verifier role grants: deployer is not DEFAULT_ADMIN_ROLE on MuonSignatureVerifier")
			}

			await checkpointedStep(checkpoint, "setup.setSignatureVerifier", "Setting MuonSignatureVerifier on Diamond", async () => {
				await send(controlFacet.connect(deployer).setSignatureVerifierAddress(deployedContracts.signatureVerifier!), "setSignatureVerifierAddress")
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
							(key: { x: bigint; parity: bigint | number }) => key.x.toString() === config.muonPublicKeyX && Number(key.parity) === parity,
						)
						if (exists) {
							console.log("  ⏭ Muon public key already present on MuonSignatureVerifier")
							return
						}
						await send(
							signatureVerifier.connect(deployer).addPublicKey({
								x: config.muonPublicKeyX,
								parity,
							}),
							"addPublicKey",
						)
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
						await send(signatureVerifier.connect(deployer).addGatewaySigner(signer), "addGatewaySigner")
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
				await send(controlFacet.connect(deployer).grantRole(deployerAddress, roleHash("MUON_SETTER_ROLE")), "grantRole")
			})
		}
	}

	if (shouldConfigureMuonIds) {
		await checkpointedStep(checkpoint, "setup.setMuonIds", "Setting Muon app ID on Diamond", async () => {
			await send(controlFacet.connect(deployer).setMuonIds(config.muonAppId), "setMuonIds")
		})
	}

	await checkpointedStep(checkpoint, "setup.setMuonConfig", "Setting Muon validity config on Diamond", async () => {
		await send(controlFacet.connect(deployer).setMuonConfig(config.muonUpnlValidTime, config.muonPriceValidTime), "setMuonConfig")
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
				const found = keys.some(
					(key: { x: bigint; parity: bigint | number }) => key.x.toString() === config.muonPublicKeyX && Number(key.parity) === parity,
				)
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
	const params = protocolConfig.parameters
	const parameterSetters: Array<{ key: string; name: string; action: () => Promise<ContractTransactionResponse> }> = [
		{ key: "setup.setCollateral", name: "setCollateral", action: () => controlFacet.connect(deployer).setCollateral(deployedContracts.collateral!) },
		{
			key: "setup.setBalanceLimitPerUser",
			name: "setBalanceLimitPerUser",
			action: () => controlFacet.connect(deployer).setBalanceLimitPerUser(BigInt(params.balanceLimitPerUser)),
		},
		{
			key: "setup.setMaxWithdrawParts",
			name: "setMaxWithdrawParts",
			action: () => controlFacet.connect(deployer).setMaxWithdrawParts(params.maxWithdrawParts),
		},
		{
			key: "setup.setDeallocateCooldown",
			name: "setDeallocateCooldown",
			action: () => controlFacet.connect(deployer).setDeallocateCooldown(params.deallocateCooldown),
		},
		{
			key: "setup.setSettlementCooldown",
			name: "setSettlementCooldown",
			action: () => controlFacet.connect(deployer).setSettlementCooldown(params.settlementCooldown),
		},
		{
			key: "setup.setDeallocateDebounceTime",
			name: "setDeallocateDebounceTime",
			action: () => controlFacet.connect(deployer).setDeallocateDebounceTime(params.deallocateDebounceTime),
		},
		{
			key: "setup.setLiquidatorShare",
			name: "setLiquidatorShare",
			action: () => controlFacet.connect(deployer).setLiquidatorShare(BigInt(params.liquidatorShare)),
		},
		{
			key: "setup.setLiquidationTimeout",
			name: "setLiquidationTimeout",
			action: () => controlFacet.connect(deployer).setLiquidationTimeout(params.liquidationTimeout),
		},
		{
			key: "setup.setForceCloseCooldowns",
			name: "setForceCloseCooldowns",
			action: () => controlFacet.connect(deployer).setForceCloseCooldowns(params.forceCloseCooldowns[0], params.forceCloseCooldowns[1]),
		},
		{
			key: "setup.setForceCancelCooldown",
			name: "setForceCancelCooldown",
			action: () => controlFacet.connect(deployer).setForceCancelCooldown(params.forceCancelCooldown),
		},
		{
			key: "setup.setForceCancelCloseCooldown",
			name: "setForceCancelCloseCooldown",
			action: () => controlFacet.connect(deployer).setForceCancelCloseCooldown(params.forceCancelCloseCooldown),
		},
		{
			key: "setup.setPendingQuotesValidLength",
			name: "setPendingQuotesValidLength",
			action: () => controlFacet.connect(deployer).setPendingQuotesValidLength(params.pendingQuotesValidLength),
		},
		{
			key: "setup.setMaxPartyAConnectionLimit",
			name: "setMaxPartyAConnectionLimit",
			action: () => controlFacet.connect(deployer).setMaxPartyAConnectionLimit(params.maxPartyAConnectionLimit),
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
		// send() awaits the receipt, so the checkpoint only records the step once the
		// parameter is actually set on-chain — and it logs the hash and gas itself.
		await checkpointedStep(checkpoint, key, name, () => send(action(), name).then(() => undefined), { indent: "    ", skipLog: true })
	}

	// InstantLayer roles and whitelist
	await checkpointedStep(checkpoint, "setup.ilDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on InstantLayer to admin", async () => {
		await send(instantLayer.connect(deployer).grantRole(instantLayerDefaultAdminRole, config.admin), "grantRole")
	})

	await checkpointedStep(checkpoint, "setup.ilGrantSetterRole", "Granting SETTER_ROLE on InstantLayer to admin", async () => {
		await send(instantLayer.connect(deployer).grantRole(roleHash("SETTER_ROLE"), config.admin), "grantRole")
	})

	await checkpointedStep(checkpoint, "setup.ilWhitelistDiamond", "Whitelisting Symmio (Diamond) on InstantLayer", async () => {
		await send(instantLayer.connect(deployer).setTargetWhitelist(deployedContracts.diamond!, true), "setTargetWhitelist")
	})

	await checkpointedStep(checkpoint, "setup.ilWhitelistAL", "Whitelisting AccountLayerDiamond on InstantLayer", async () => {
		await send(instantLayer.connect(deployer).setTargetWhitelist(deployedContracts.accountLayerDiamond!, true), "setTargetWhitelist")
	})

	// PartyB setup (if deployed)
	if (deployedContracts.symmioPartyB) {
		await checkpointedStep(checkpoint, "setup.registerPartyB", "Registering SymmioPartyB in Diamond", async () => {
			await send(controlFacet.connect(deployer).registerPartyB(deployedContracts.symmioPartyB!), "registerPartyB")
		})

		if (config.setAdlEnabled) {
			await checkpointedStep(checkpoint, "setup.setAdlEnabled", "Enabling ADL for SymmioPartyB on Diamond", async () => {
				await send(controlFacet.connect(deployer).setADLEnabled(deployedContracts.symmioPartyB!, true), "setADLEnabled")
			})
		}

		const symmioPartyB = await ethers.getContractAt("SymmioPartyB", deployedContracts.symmioPartyB)
		const partyBDefaultAdminRole = await symmioPartyB.DEFAULT_ADMIN_ROLE()

		await checkpointedStep(checkpoint, "setup.pbDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(partyBDefaultAdminRole, config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbTrustedRole", "Granting TRUSTED_ROLE to InstantLayer on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("TRUSTED_ROLE"), deployedContracts.instantLayer!), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbManagerRole", "Granting MANAGER_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("MANAGER_ROLE"), config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbSetterRole", "Granting SETTER_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("SETTER_ROLE"), config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbMulticastWhitelist", "Setting multicastWhitelist for InstantLayer on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).setMulticastWhitelist(deployedContracts.instantLayer!, true), "setMulticastWhitelist")
		})

		if (config.partyBSigner) {
			await checkpointedStep(checkpoint, "setup.pbSetSigner", "Setting signer on SymmioPartyB", async () => {
				await send(symmioPartyB.connect(deployer).setSigner(config.partyBSigner), "setSigner")
			})
		}

		await checkpointedStep(checkpoint, "setup.ilRegisterPartyB", "Registering SymmioPartyB on InstantLayer (also grants OPERATOR_ROLE)", async () => {
			await send(instantLayer.connect(deployer).registerPartyBs([deployedContracts.symmioPartyB!]), "registerPartyBs")
		})
	}

	// SymbolManager setup (if deployed)
	if (deployedContracts.symbolManager) {
		await checkpointedStep(checkpoint, "setup.smGrantSymbolManagerRole", "Granting SYMBOL_MANAGER_ROLE to SymbolManager on Diamond", async () => {
			await send(controlFacet.connect(deployer).grantRole(deployedContracts.symbolManager!, roleHash("SYMBOL_MANAGER_ROLE")), "grantRole")
		})

		await checkpointedStep(
			checkpoint,
			"setup.smGrantForceCloseGapRatioRole",
			"Granting FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE to SymbolManager on Diamond",
			async () => {
				await send(
					controlFacet.connect(deployer).grantRole(deployedContracts.symbolManager!, roleHash("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE")),
					"grantRole",
				)
			},
		)

		if (config.symbolManagerOperator) {
			const operatorAddress = ethers.getAddress(config.symbolManagerOperator.toLowerCase())
			const symbolManager = await ethers.getContractAt("SymmioSymbolManager", deployedContracts.symbolManager!)

			await checkpointedStep(checkpoint, "setup.smGrantAdderRole", "Granting SYMBOL_ADDER_ROLE on SymbolManager to operator", async () => {
				await send(symbolManager.connect(deployer).grantRole(roleHash("SYMBOL_ADDER_ROLE"), operatorAddress), "grantRole")
			})

			await checkpointedStep(checkpoint, "setup.smGrantRemoverRole", "Granting SYMBOL_REMOVER_ROLE on SymbolManager to operator", async () => {
				await send(symbolManager.connect(deployer).grantRole(roleHash("SYMBOL_REMOVER_ROLE"), operatorAddress), "grantRole")
			})
		}
	}

	console.log("  System setup complete!")
}

async function registerDummyAffiliate(
	hre: any,
	deployedContracts: DeployedContracts,
	config: Awaited<ReturnType<typeof getEnvConfig>>,
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
		await send(alAffiliateFacet.connect(deployer).requestToRegisterAffiliate(affiliateData), "requestToRegisterAffiliate")
		// Save the predicted address so we can use it on resume
		checkpoint.contracts.accountManager = createDeployedContract(accountManagerAddress!)
		saveCheckpoint(checkpoint)
	})

	// Approve affiliate
	await checkpointedStep(checkpoint, "affiliate.approve", "Approving affiliate", async () => {
		await send(alAffiliateFacet.connect(deployer).approveAffiliate(accountManagerAddress!), "approveAffiliate")
	})

	console.log(`  Dummy affiliate registered! AccountManager: ${accountManagerAddress}`)

	return accountManagerAddress!
}

/**
 * Sets up InstantLayer templates for standard and custom-VA open/close flows.
 */
async function setupInstantLayerTemplates(
	hre: any,
	deployedContracts: DeployedContracts,
	checkpoint: DeploymentCheckpoint,
	protocolConfig: ProtocolConfig,
): Promise<void> {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()
	const instantLayer = await ethers.getContractAt("InstantLayer", deployedContracts.instantLayer!)

	const templates = protocolConfig.instantLayerTemplates
	console.log(`  Setting up ${templates.length} InstantLayer template(s)...`)

	// Template ids are assigned in creation order and hedgers address templates BY ID, so
	// the array order in the config is part of the contract with off-chain services.
	for (const [templateId, template] of templates.entries()) {
		await checkpointedStep(checkpoint, `templates.add.${templateId}`, `Adding template ${templateId}: ${template.name}`, async () => {
			await send(instantLayer.connect(deployer).addTemplate(template.name, template.operations), `addTemplate(${template.name})`)
		})

		if (template.instantOpenMode) {
			await checkpointedStep(
				checkpoint,
				`templates.instantOpenMode.${templateId}`,
				`Enabling instantOpenMode on template ${templateId}`,
				async () => {
					await send(instantLayer.connect(deployer).setTemplateInstantOpenMode(templateId, true), "setTemplateInstantOpenMode")
				},
			)
		}
	}

	// Assert the on-chain result matches the config — a template at the wrong id silently
	// breaks every hedger that references it.
	const onChain = await instantLayer.getTemplates(0, templates.length + 10)
	if (onChain.length !== templates.length) {
		throw new Error(`InstantLayer has ${onChain.length} templates, expected ${templates.length}`)
	}
	for (const [templateId, template] of templates.entries()) {
		if (onChain[templateId].name !== template.name) {
			throw new Error(`Template id ${templateId} is "${onChain[templateId].name}" on-chain, expected "${template.name}"`)
		}
		if (onChain[templateId].operations.length !== template.operations.length) {
			throw new Error(
				`Template ${template.name} (id ${templateId}) has ${onChain[templateId].operations.length} operations on-chain, expected ${template.operations.length}`,
			)
		}
	}

	console.log(`  InstantLayer templates setup complete — ${templates.length} verified on-chain.`)
}

/** Minimal OpenZeppelin AccessControl surface, used for the peripheral contracts. */
const ACCESS_CONTROL_ABI = [
	"function hasRole(bytes32 role, address account) view returns (bool)",
	"function renounceRole(bytes32 role, address callerConfirmation)",
]

/**
 * Hand every administrative privilege to config.admin and strip the deployer's.
 *
 * ControlFacet.setAdmin is purely additive — it sets hasRole[user][DEFAULT_ADMIN_ROLE]
 * and revokes nothing — and LibAccessibility.isRoleAdmin treats ANY DEFAULT_ADMIN_ROLE
 * holder as admin of every role. Without this step the deploy hot wallet keeps full
 * control of the protocol indefinitely: it could grant itself LIQUIDATOR_ROLE, change the
 * collateral, or add its own Muon public key and forge attestations. The same applies to
 * the OpenZeppelin peripherals, where the deployer is the initial admin.
 *
 * Safety rule enforced throughout: never revoke a deployer role without first confirming
 * on-chain that config.admin holds the equivalent role. Getting that backwards would
 * leave the contract with no administrator at all.
 */
async function revokeDeployerPrivileges(
	hre: any,
	deployedContracts: DeployedContracts,
	config: Awaited<ReturnType<typeof getEnvConfig>>,
	checkpoint: DeploymentCheckpoint,
	deployerAddress: string,
): Promise<void> {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()
	const roleHash = (role: string) => ethers.keccak256(ethers.toUtf8Bytes(role))

	if (config.admin.toLowerCase() === deployerAddress.toLowerCase()) {
		console.log("  ⏭ ADMIN_PUBLIC_KEY is the deployer — no handover to perform.")
		console.log("     ⚠ The deploy wallet remains protocol admin. For a production system, set")
		console.log("       ADMIN_PUBLIC_KEY to your multisig and re-run so privileges are handed over.")
		return
	}

	console.log(`  Handing administrative control to ${config.admin} and revoking the deployer's.`)

	// ---- Core Diamond (custom role storage) --------------------------------------
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", deployedContracts.diamond!)
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", deployedContracts.diamond!)

	if (!(await viewFacet.hasRole(config.admin, roleHash("DEFAULT_ADMIN_ROLE")))) {
		throw new Error(
			`Refusing to revoke the deployer's DEFAULT_ADMIN_ROLE: ${config.admin} does not hold it on the Diamond. ` +
				`Revoking now would leave the protocol with no administrator.`,
		)
	}

	// Narrower roles first — DEFAULT_ADMIN_ROLE is what authorises these revocations,
	// so it has to be the last thing the deployer gives up.
	for (const role of ["MUON_SETTER_ROLE", "DEFAULT_ADMIN_ROLE"]) {
		const hash = roleHash(role)
		if (!(await viewFacet.hasRole(deployerAddress, hash))) {
			console.log(`    ⏭ Deployer does not hold ${role} on the Diamond`)
			continue
		}
		await checkpointedStep(checkpoint, `revoke.core.${role}`, `Revoking ${role} from deployer on Diamond`, async () => {
			await send(controlFacet.connect(deployer).revokeRole(deployerAddress, hash), `revokeRole(${role})`)
		})
		if (await viewFacet.hasRole(deployerAddress, hash)) {
			throw new Error(`${role} is still held by the deployer on the Diamond after revocation`)
		}
	}

	// ---- AccountLayer Diamond (same custom role storage) --------------------------
	if (deployedContracts.accountLayerDiamond) {
		const alControl = await ethers.getContractAt(
			"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
			deployedContracts.accountLayerDiamond,
		)
		const alView = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", deployedContracts.accountLayerDiamond)
		const hash = roleHash("DEFAULT_ADMIN_ROLE")

		if (!(await alView.hasRole(config.admin, hash))) {
			throw new Error(`Refusing to revoke deployer admin on the AccountLayer: ${config.admin} does not hold DEFAULT_ADMIN_ROLE there.`)
		}
		if (await alView.hasRole(deployerAddress, hash)) {
			await checkpointedStep(
				checkpoint,
				"revoke.accountLayer.DEFAULT_ADMIN_ROLE",
				"Revoking DEFAULT_ADMIN_ROLE from deployer on AccountLayer",
				async () => {
					await send(alControl.connect(deployer).revokeRole(deployerAddress, hash), "revokeRole(AccountLayer DEFAULT_ADMIN_ROLE)")
				},
			)
			if (await alView.hasRole(deployerAddress, hash)) {
				throw new Error("DEFAULT_ADMIN_ROLE is still held by the deployer on the AccountLayer after revocation")
			}
		} else {
			console.log("    ⏭ Deployer does not hold DEFAULT_ADMIN_ROLE on the AccountLayer")
		}
	}

	// ---- OpenZeppelin AccessControl peripherals -----------------------------------
	// The mock verifier has no roles at all, so it is skipped.
	const ozTargets: Array<{ label: string; address?: string }> = [
		{ label: "MuonSignatureVerifier", address: config.deployMockVerifier ? undefined : deployedContracts.signatureVerifier },
		{ label: "InstantLayer", address: deployedContracts.instantLayer },
		{ label: "SymmioPartyB", address: deployedContracts.symmioPartyB },
	]

	for (const target of ozTargets) {
		if (!target.address) continue
		const contract = new ethers.Contract(target.address, ACCESS_CONTROL_ABI, deployer)

		for (const role of ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE"]) {
			// OZ's DEFAULT_ADMIN_ROLE is bytes32(0); the named roles are keccak hashes.
			const hash = role === "DEFAULT_ADMIN_ROLE" ? ethers.ZeroHash : roleHash(role)

			let deployerHas: boolean
			let adminHas: boolean
			try {
				deployerHas = await contract.hasRole(hash, deployerAddress)
				adminHas = await contract.hasRole(hash, config.admin)
			} catch {
				// Contract does not implement this role — nothing to do.
				continue
			}

			if (!deployerHas) continue
			if (!adminHas) {
				throw new Error(
					`Refusing to renounce ${role} on ${target.label}: ${config.admin} does not hold it, which would leave the contract unmanaged.`,
				)
			}

			await checkpointedStep(checkpoint, `revoke.${target.label}.${role}`, `Renouncing ${role} on ${target.label}`, async () => {
				await send(contract.renounceRole(hash, deployerAddress), `renounceRole(${target.label}.${role})`)
			})
			if (await contract.hasRole(hash, deployerAddress)) {
				throw new Error(`${role} is still held by the deployer on ${target.label} after renouncing`)
			}
		}
	}

	console.log(`  ✓ Deployer privileges revoked; ${config.admin} is now the sole administrator.`)
}

function generateReport(deployments: DeploymentResult[], config: Awaited<ReturnType<typeof getEnvConfig>>): SystemDeploymentReport {
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
			setAdlEnabled: config.setAdlEnabled,
			deploySymbolManager: config.deploySymbolManager,
			symbolManagerOperator: config.symbolManagerOperator,
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
	if (deployedContracts.symbolManager) console.log(`SymbolManager:        ${deployedContracts.symbolManager}`)
	if (deployedContracts.accountManager) console.log(`AccountManager:       ${deployedContracts.accountManager}`)
	console.log()

	console.log("CONFIGURATION")
	console.log("-".repeat(80))
	console.log(`Admin:                       ${report.config.admin}`)
	console.log(`Symmio Fee Receiver:         ${report.config.symmioFeeReceiver}`)
	console.log(`Deploy PartyB:               ${report.config.deployPartyB}`)
	console.log(`Set ADL Enabled:             ${report.config.setAdlEnabled}`)
	console.log(`Deploy SymbolManager:        ${report.config.deploySymbolManager}`)
	console.log(`SymbolManager Operator:      ${report.config.symbolManagerOperator || "(not set)"}`)
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
