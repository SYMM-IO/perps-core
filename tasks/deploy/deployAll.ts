import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { writeData } from "../utils/fs.js"
import { deployAccountHub } from "./accountHub.js"
import { deployAffiliateHub } from "./affiliateHub.js"
import { deployDiamond } from "./diamond.js"
import { getConnection } from "./helpers.js"
import { deployInstantLayer } from "./instantLayer.js"
import { deploySymmioPartyB } from "./partyB.js"
import { deployStablecoin } from "./stablecoin.js"

interface DeploymentResult {
	contract: string
	address: string
	status: "success" | "failed"
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
	}
	summary: {
		totalContracts: number
		successfulDeployments: number
		failedDeployments: number
	}
	timestamp: string
}

interface DeployedContracts {
	collateral?: string
	diamond?: string
	affiliateHub?: string
	accountHub?: string
	accountHubLens?: string
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

	return {
		admin,
		symmioFeeReceiver,
		collateralAddress,
		deployPartyB,
		registerDummyAffiliate,
	}
}

export const deployAllTask = task("deploy:system", "Deploys all system contracts and sets up the complete environment")
	.addOption({ name: "verify", description: "Verify contracts after deployment", type: ArgumentType.BOOLEAN, defaultValue: false })
	.addOption({ name: "logData", description: "Write deployment addresses to data files", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ verify, logData }, hre) => {
			const { ethers } = await getConnection(hre)
			const [deployer] = await ethers.getSigners()
			const config = await getEnvConfig(hre)

			console.log("=".repeat(80))
			console.log("SYSTEM DEPLOYMENT STARTED")
			console.log("=".repeat(80))
			console.log(`Deployer: ${deployer.address}`)
			console.log(`Admin: ${config.admin}`)
			console.log(`Symmio Fee Receiver: ${config.symmioFeeReceiver}`)
			console.log(`Collateral Address: ${config.collateralAddress || "(will deploy FakeStablecoin)"}`)
			console.log(`Deploy PartyB: ${config.deployPartyB}`)
			console.log(`Register Dummy Affiliate: ${config.registerDummyAffiliate}`)
			console.log("=".repeat(80))
			console.log()

			const deploymentResults: DeploymentResult[] = []
			const deployedContracts: DeployedContracts = {}

			// Step 1: Deploy or use existing Collateral
			console.log("Step 1: Setting up Collateral...")
			if (config.collateralAddress) {
				console.log(`Using existing collateral at: ${config.collateralAddress}`)
				deployedContracts.collateral = config.collateralAddress
				deploymentResults.push({
					contract: "Collateral (existing)",
					address: config.collateralAddress,
					status: "success",
					timestamp: new Date().toISOString(),
				})
			} else {
				try {
					console.log("Deploying FakeStablecoin...")
					const stablecoin = await deployStablecoin(hre, { logData })
					deployedContracts.collateral = await stablecoin.getAddress()
					console.log(`FakeStablecoin deployed at: ${deployedContracts.collateral}`)
					deploymentResults.push({
						contract: "FakeStablecoin",
						address: deployedContracts.collateral,
						status: "success",
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

			// Step 2: Deploy Diamond
			console.log("Step 2: Deploying Diamond...")
			try {
				const diamond = await deployDiamond(hre, { logData, genABI: false, reportGas: false })
				deployedContracts.diamond = await diamond.getAddress()
				console.log(`Diamond deployed at: ${deployedContracts.diamond}`)
				deploymentResults.push({
					contract: "Diamond",
					address: deployedContracts.diamond,
					status: "success",
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

			// Step 3: Deploy AffiliateHub
			console.log("Step 3: Deploying AffiliateHub...")
			try {
				const affiliateHub = await deployAffiliateHub(hre, {
					admin: config.admin,
					symmiofeereceiver: config.symmioFeeReceiver,
					logData,
				})
				deployedContracts.affiliateHub = await affiliateHub.getAddress()
				console.log(`AffiliateHub deployed at: ${deployedContracts.affiliateHub}`)
				deploymentResults.push({
					contract: "AffiliateHub",
					address: deployedContracts.affiliateHub,
					status: "success",
					timestamp: new Date().toISOString(),
				})
			} catch (err: any) {
				console.error(`Failed to deploy AffiliateHub: ${err.message}`)
				deploymentResults.push({
					contract: "AffiliateHub",
					address: "N/A",
					status: "failed",
					error: err.message,
					timestamp: new Date().toISOString(),
				})
				throw err
			}
			console.log()

			// Step 4: Deploy AccountHub
			console.log("Step 4: Deploying AccountHub...")
			try {
				const accountHub = await deployAccountHub(hre, {
					admin: config.admin,
					affiliatehubaddress: deployedContracts.affiliateHub!,
					logData,
				})
				deployedContracts.accountHub = await accountHub.getAddress()
				console.log(`AccountHub deployed at: ${deployedContracts.accountHub}`)
				deploymentResults.push({
					contract: "AccountHub",
					address: deployedContracts.accountHub,
					status: "success",
					timestamp: new Date().toISOString(),
				})
			} catch (err: any) {
				console.error(`Failed to deploy AccountHub: ${err.message}`)
				deploymentResults.push({
					contract: "AccountHub",
					address: "N/A",
					status: "failed",
					error: err.message,
					timestamp: new Date().toISOString(),
				})
				throw err
			}
			console.log()

			// Step 5: Deploy AccountHubLens
			console.log("Step 5: Deploying AccountHubLens...")
			try {
				const AccountHubLensFactory = await ethers.getContractFactory("AccountHubLens")
				const accountHubLens = await AccountHubLensFactory.deploy(deployedContracts.accountHub!)
				await accountHubLens.waitForDeployment()
				deployedContracts.accountHubLens = await accountHubLens.getAddress()
				console.log(`AccountHubLens deployed at: ${deployedContracts.accountHubLens}`)
				deploymentResults.push({
					contract: "AccountHubLens",
					address: deployedContracts.accountHubLens,
					status: "success",
					timestamp: new Date().toISOString(),
				})
			} catch (err: any) {
				console.error(`Failed to deploy AccountHubLens: ${err.message}`)
				deploymentResults.push({
					contract: "AccountHubLens",
					address: "N/A",
					status: "failed",
					error: err.message,
					timestamp: new Date().toISOString(),
				})
				throw err
			}
			console.log()

			// Step 6: Deploy InstantLayer
			console.log("Step 6: Deploying InstantLayer...")
			try {
				const instantLayer = await deployInstantLayer(hre, {
					symmioaddress: deployedContracts.diamond!,
					admin: config.admin,
					logData,
				})
				deployedContracts.instantLayer = await instantLayer.getAddress()
				console.log(`InstantLayer deployed at: ${deployedContracts.instantLayer}`)
				deploymentResults.push({
					contract: "InstantLayer",
					address: deployedContracts.instantLayer,
					status: "success",
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

			// Step 7: Optionally Deploy SymmioPartyB
			if (config.deployPartyB) {
				console.log("Step 7: Deploying SymmioPartyB...")
				try {
					const symmioPartyB = await deploySymmioPartyB(hre, {
						symmioAddress: deployedContracts.diamond!,
						admin: config.admin,
						logData,
					})
					deployedContracts.symmioPartyB = await symmioPartyB.getAddress()
					console.log(`SymmioPartyB deployed at: ${deployedContracts.symmioPartyB}`)
					deploymentResults.push({
						contract: "SymmioPartyB",
						address: deployedContracts.symmioPartyB,
						status: "success",
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
			}

			// Step 8: Setup system - roles and connections
			console.log("Step 8: Setting up system roles and connections...")
			await setupSystem(hre, deployedContracts, config)
			console.log()

			// Step 9: Optionally register dummy affiliate
			if (config.registerDummyAffiliate) {
				console.log("Step 9: Registering dummy affiliate...")
				const accountManagerAddress = await registerDummyAffiliate(hre, deployedContracts, config)
				if (accountManagerAddress) {
					deployedContracts.accountManager = accountManagerAddress
					deploymentResults.push({
						contract: "AccountManager (Dummy Affiliate)",
						address: accountManagerAddress,
						status: "success",
						timestamp: new Date().toISOString(),
					})
				}
				console.log()
			}

			// Generate and display report
			console.log()
			console.log("=".repeat(80))
			console.log("DEPLOYMENT REPORT")
			console.log("=".repeat(80))
			console.log()

			const report = generateReport(deploymentResults, config)
			displayReport(report, deployedContracts)
			saveReport(report, deployedContracts)

			return {
				deployments: deployedContracts,
				report,
			}
		},
	}))
	.build()

async function setupSystem(hre: any, deployedContracts: DeployedContracts, config: ReturnType<typeof getEnvConfig>) {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()

	const controlFacet = await ethers.getContractAt("ControlFacet", deployedContracts.diamond!)
	const accountHub = await ethers.getContractAt("AccountHub", deployedContracts.accountHub!)
	const affiliateHub = await ethers.getContractAt("AffiliateHub", deployedContracts.affiliateHub!)
	const instantLayer = await ethers.getContractAt("InstantLayer", deployedContracts.instantLayer!)

	// Helper to get role hash
	const roleHash = (role: string) => ethers.keccak256(ethers.toUtf8Bytes(role))

	// Set admin on diamond
	console.log("  Setting admin on Diamond...")
	await controlFacet.connect(deployer).setAdmin(config.admin)

	// Grant roles to admin on Diamond
	console.log("  Granting roles to admin on Diamond...")
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

	for (const role of diamondRoles) {
		await controlFacet.connect(deployer).grantRole(config.admin, roleHash(role))
	}

	// Grant SIGNER_ADMIN_ROLE and AFFILIATE_MANAGER_ROLE to AffiliateHub
	console.log("  Granting roles to AffiliateHub on Diamond...")
	await controlFacet.connect(deployer).grantRole(deployedContracts.affiliateHub!, roleHash("SIGNER_ADMIN_ROLE"))
	await controlFacet.connect(deployer).grantRole(deployedContracts.affiliateHub!, roleHash("AFFILIATE_MANAGER_ROLE"))

	// Grant SIGNER_ADMIN_ROLE and INTERNAL_TRANSFER_TO_BALANCE_ROLE to AccountHub
	console.log("  Granting roles to AccountHub on Diamond...")
	await controlFacet.connect(deployer).grantRole(deployedContracts.accountHub!, roleHash("SIGNER_ADMIN_ROLE"))
	await controlFacet.connect(deployer).grantRole(deployedContracts.accountHub!, roleHash("INTERNAL_TRANSFER_TO_BALANCE_ROLE"))

	// Grant INSTANT_LAYER_ROLE to InstantLayer on Diamond
	console.log("  Granting INSTANT_LAYER_ROLE to InstantLayer on Diamond...")
	await controlFacet.connect(deployer).grantRole(deployedContracts.instantLayer!, roleHash("INSTANT_LAYER_ROLE"))

	// Setup AffiliateHub
	console.log("  Setting up AffiliateHub...")
	await affiliateHub.connect(deployer).grantRole(roleHash("SETTER_ROLE"), config.admin)
	await affiliateHub.connect(deployer).grantRole(roleHash("APPROVER_ROLE"), config.admin)
	await affiliateHub.connect(deployer).setAccountHub(deployedContracts.accountHub!)
	await affiliateHub.connect(deployer).setWhitelistedSymmioCore(deployedContracts.diamond!, true)

	// Setup AccountHub
	console.log("  Setting up AccountHub...")
	await accountHub.connect(deployer).grantRole(roleHash("SETTER_ROLE"), config.admin)
	await accountHub.connect(deployer).grantRole(roleHash("PAUSER_ROLE"), config.admin)
	await accountHub.connect(deployer).grantRole(roleHash("UNPAUSER_ROLE"), config.admin)
	await accountHub.connect(deployer).grantRole(roleHash("DEPLOYER_ROLE"), deployedContracts.affiliateHub!)
	await accountHub.connect(deployer).grantRole(roleHash("INSTANT_LAYER_ROLE"), deployedContracts.instantLayer!)
	await accountHub.connect(deployer).setAccountHubLens(deployedContracts.accountHubLens!)

	// Setup InstantLayer
	console.log("  Setting up InstantLayer...")
	await instantLayer.connect(deployer).setAccountHub(deployedContracts.accountHub!)

	// Configure Diamond system parameters (like in tests)
	console.log("  Configuring Diamond system parameters...")
	await controlFacet.connect(deployer).setCollateral(deployedContracts.collateral!)
	await controlFacet.connect(deployer).setBalanceLimitPerUser(ethers.parseEther("10000"))
	await controlFacet.connect(deployer).setDeallocateCooldown(120)
	await controlFacet.connect(deployer).setSettlementCooldown(300)
	await controlFacet.connect(deployer).setDeallocateDebounceTime(120)
	await controlFacet.connect(deployer).setLiquidatorShare(ethers.parseEther("0.1"))
	await controlFacet.connect(deployer).setLiquidationTimeout(100)
	await controlFacet.connect(deployer).setForceCloseCooldowns(300, 120)
	await controlFacet.connect(deployer).setForceCancelCooldown(300)
	await controlFacet.connect(deployer).setForceCancelCloseCooldown(300)
	await controlFacet.connect(deployer).setPendingQuotesValidLength(10)
	await controlFacet.connect(deployer).setMaxPartyAConnectionLimit(5)
	await controlFacet.connect(deployer).setInvalidBridgedAmountsPool(config.admin)

	// Register and setup PartyB if deployed
	if (deployedContracts.symmioPartyB) {
		console.log("  Registering SymmioPartyB in Diamond...")
		await controlFacet.connect(deployer).registerPartyB(deployedContracts.symmioPartyB)

		console.log("  Granting TRUSTED_ROLE to InstantLayer in SymmioPartyB...")
		const symmioPartyB = await ethers.getContractAt("SymmioPartyB", deployedContracts.symmioPartyB)
		await symmioPartyB.connect(deployer).grantRole(roleHash("TRUSTED_ROLE"), deployedContracts.instantLayer!)
	}

	console.log("  System setup complete!")
}

async function registerDummyAffiliate(
	hre: any,
	deployedContracts: DeployedContracts,
	config: ReturnType<typeof getEnvConfig>,
): Promise<string | null> {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()

	const affiliateHub = await ethers.getContractAt("AffiliateHub", deployedContracts.affiliateHub!)

	console.log("  Registering dummy affiliate...")

	const affiliateData = {
		name: "Test Affiliate",
		brandColor: "d69d00",
		admin: config.admin,
		stakeholders: [
			{
				receiver: config.admin,
				share: ethers.parseEther("0.9"),
			},
		],
		symmioShare: ethers.parseEther("0.1"),
		metadata: "0x",
		legacyMultiAccounts: [],
		symmioCores: [deployedContracts.diamond!],
	}

	// Get predicted account manager address
	const accountManagerAddress = await affiliateHub.connect(deployer).requestToRegisterAffiliate.staticCall(affiliateData)

	// Actually register
	await affiliateHub.connect(deployer).requestToRegisterAffiliate(affiliateData)

	console.log("  Approving affiliate...")
	await affiliateHub.connect(deployer).approveAffiliate(accountManagerAddress)

	console.log(`  Dummy affiliate registered! AccountManager: ${accountManagerAddress}`)

	return accountManagerAddress
}

function generateReport(deployments: DeploymentResult[], config: ReturnType<typeof getEnvConfig>): SystemDeploymentReport {
	const successfulDeployments = deployments.filter(d => d.status === "success").length
	const failedDeployments = deployments.filter(d => d.status === "failed").length

	return {
		deployments,
		config: {
			admin: config.admin,
			symmioFeeReceiver: config.symmioFeeReceiver,
			collateralAddress: config.collateralAddress,
			deployPartyB: config.deployPartyB,
			registerDummyAffiliate: config.registerDummyAffiliate,
		},
		summary: {
			totalContracts: deployments.length,
			successfulDeployments,
			failedDeployments,
		},
		timestamp: new Date().toISOString(),
	}
}

function displayReport(report: SystemDeploymentReport, deployedContracts: DeployedContracts): void {
	console.log("DEPLOYMENT SUMMARY")
	console.log("-".repeat(80))
	console.log(`Total Contracts: ${report.summary.totalContracts}`)
	console.log(`Successful: ${report.summary.successfulDeployments}`)
	console.log(`Failed: ${report.summary.failedDeployments}`)
	console.log()

	console.log("DEPLOYED ADDRESSES")
	console.log("-".repeat(80))
	if (deployedContracts.collateral) console.log(`Collateral:       ${deployedContracts.collateral}`)
	if (deployedContracts.diamond) console.log(`Diamond:          ${deployedContracts.diamond}`)
	if (deployedContracts.affiliateHub) console.log(`AffiliateHub:     ${deployedContracts.affiliateHub}`)
	if (deployedContracts.accountHub) console.log(`AccountHub:       ${deployedContracts.accountHub}`)
	if (deployedContracts.accountHubLens) console.log(`AccountHubLens:   ${deployedContracts.accountHubLens}`)
	if (deployedContracts.instantLayer) console.log(`InstantLayer:     ${deployedContracts.instantLayer}`)
	if (deployedContracts.symmioPartyB) console.log(`SymmioPartyB:     ${deployedContracts.symmioPartyB}`)
	if (deployedContracts.accountManager) console.log(`AccountManager:   ${deployedContracts.accountManager}`)
	console.log()

	console.log("CONFIGURATION")
	console.log("-".repeat(80))
	console.log(`Admin:                    ${report.config.admin}`)
	console.log(`Symmio Fee Receiver:      ${report.config.symmioFeeReceiver}`)
	console.log(`Deploy PartyB:            ${report.config.deployPartyB}`)
	console.log(`Register Dummy Affiliate: ${report.config.registerDummyAffiliate}`)
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
