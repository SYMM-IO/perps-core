import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { ACCOUNTHUB_DEPLOYMENT_LOG_FILE, AFFILIATEHUB_DEPLOYMENT_FILE, DEPLOYMENT_LOG_FILE, INSTANTLAYER_DEPLOYMENT_FILE } from "./constants.js"
import { getConnection } from "./helpers.js"

const DEPLOYMENT_FILES = {
	DIAMOND: DEPLOYMENT_LOG_FILE,
	ACCOUNT_HUB: ACCOUNTHUB_DEPLOYMENT_LOG_FILE,
	AFFILIATE_HUB: AFFILIATEHUB_DEPLOYMENT_FILE,
	INSTANT_LAYER: INSTANTLAYER_DEPLOYMENT_FILE,
} as const

// Contract names for reporting
const CONTRACT_NAMES = {
	DIAMOND: "Diamond",
	INSTANT_LAYER: "InstantLayer",
	AFFILIATE_HUB: "AffiliateHub",
	ACCOUNT_HUB: "AccountHub",
} as const

interface DeploymentResult {
	contract: string
	address: string
	status: "success" | "failed"
	error?: string
	timestamp: string
}

interface VerificationResult {
	contract: string
	address: string
	status: "success" | "failed" | "already_verified" | "skipped"
	error?: string
}

interface SystemDeploymentReport {
	deployments: DeploymentResult[]
	verifications: VerificationResult[]
	summary: {
		totalContracts: number
		successfulDeployments: number
		failedDeployments: number
		successfulVerifications: number
		failedVerifications: number
	}
	timestamp: string
}

export const deployAllTask = task("deploy:system", "Deploys all system contracts, verifies them, and generates a report")
	.addOption({ name: "admin", description: "The admin address for contracts", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({
		name: "symmiofeereceiver",
		description: "The address of the symmio fee receiver",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "verify", description: "Verify contracts after deployment", type: ArgumentType.BOOLEAN, defaultValue: false })
	.addOption({ name: "logData", description: "Write deployment addresses to data files", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({ name: "setup", description: "Run post-deployment system setup", type: ArgumentType.BOOLEAN, defaultValue: false })
	.setAction(async () => ({
		default: async ({ admin, symmiofeereceiver, verify, logData, setup }, hre) => {
			const run = (taskName: string, params: Record<string, unknown> = {}) => hre.tasks.getTask(taskName).run(params)
			console.log("=".repeat(80))
			console.log("SYSTEM DEPLOYMENT STARTED")
			console.log("=".repeat(80))
			console.log(`Admin Address: ${admin}`)
			console.log(`Verify Contracts: ${verify}`)
			console.log(`Run Setup: ${setup}`)
			console.log("=".repeat(80))
			console.log()

			const deploymentResults: DeploymentResult[] = []
			const deployedContracts: { [key: string]: string } = {}

			// Step 1: Deploy Diamond
			console.log("Step 1/4: Deploying Diamond...")
			const diamondResult = await deployContract(run, "deploy:diamond", {}, CONTRACT_NAMES.DIAMOND, logData)
			deploymentResults.push(diamondResult)
			if (diamondResult.status === "success") {
				deployedContracts.diamond = diamondResult.address
			}
			console.log()

			// Step 2: Deploy AffiliateHub
			console.log("Step 2/4: Deploying AffiliateHub...")
			const affiliateHubResult = await deployContract(
				run,
				"deploy:affiliateHub",
				{
					admin,
					symmiofeereceiver,
					logData,
				},
				CONTRACT_NAMES.AFFILIATE_HUB,
				logData,
			)
			deploymentResults.push(affiliateHubResult)
			if (affiliateHubResult.status === "success") {
				deployedContracts.affiliateHub = affiliateHubResult.address
			}
			console.log()

			// Step 3: Deploy AccountHub (requires AffiliateHub)
			console.log("Step 3/4: Deploying AccountHub...")
			if (deployedContracts.affiliateHub) {
				const accountHubResult = await deployContract(
					run,
					"deploy:accountHub",
					{
						admin,
						affiliatehubaddress: deployedContracts.affiliateHub,
						logData,
					},
					CONTRACT_NAMES.ACCOUNT_HUB,
					logData,
				)
				deploymentResults.push(accountHubResult)
				if (accountHubResult.status === "success") {
					deployedContracts.accountHub = accountHubResult.address
				}
			} else {
				console.error("⚠️  Skipping AccountHub deployment - AffiliateHub deployment failed")
				deploymentResults.push({
					contract: CONTRACT_NAMES.ACCOUNT_HUB,
					address: "N/A",
					status: "failed",
					error: "Dependency failed: AffiliateHub",
					timestamp: new Date().toISOString(),
				})
			}
			console.log()

			// Step 4: Deploy InstantLayer
			console.log("Step 4/4: Deploying InstantLayer...")
			const instantLayerResult = await deployContract(
				run,
				"deploy:InstantLayer",
				{
					symmioaddress: deployedContracts.diamond,
					admin,
					logData,
				},
				CONTRACT_NAMES.INSTANT_LAYER,
				logData,
			)
			deploymentResults.push(instantLayerResult)
			if (instantLayerResult.status === "success") {
				deployedContracts.instantLayer = instantLayerResult.address
			}
			console.log()

			// Post-deployment setup (optional)
			if (setup) {
				console.log("Running post-deployment setup...")
				await setupSystem(hre, deployedContracts)
				console.log()
			}

			// Step 5: Verify all contracts
			let verificationResults: VerificationResult[] = []
			if (verify) {
				console.log("=".repeat(80))
				console.log("VERIFICATION STARTED")
				console.log("=".repeat(80))
				console.log()
				verifyAllContracts(run)
			}

			// Step 6: Generate and display report
			console.log()
			console.log("=".repeat(80))
			console.log("DEPLOYMENT REPORT")
			console.log("=".repeat(80))
			console.log()

			const report = generateReport(deploymentResults, verificationResults)
			displayReport(report)

			// Save report to file
			saveReport(report)

			return {
				deployments: deployedContracts,
				report,
			}
		},
	}))
	.build()
/**
 * Deploys a single contract
 */
async function deployContract(run: any, taskName: string, params: any, contractName: string, logData: boolean): Promise<DeploymentResult> {
	try {
		console.log(`🚀 Deploying ${contractName}...`)
		const contract = await run(taskName, params)
		const address = await contract.getAddress()

		console.log(`✅ ${contractName} deployed successfully at: ${address}`)

		return {
			contract: contractName,
			address,
			status: "success",
			timestamp: new Date().toISOString(),
		}
	} catch (err: any) {
		console.error(`❌ ${contractName} deployment failed:`, err.message)

		return {
			contract: contractName,
			address: "N/A",
			status: "failed",
			error: err.message,
			timestamp: new Date().toISOString(),
		}
	}
}

/**
 * Verifies all deployed contracts
 */
async function verifyAllContracts(run: any) {
	await run("verify:deployment")
	await run("verify:accountHub")
	await run("verify:affiliateHub")
	await run("verify:instantLayer")
}

async function setupSystem(hre: any, deployedContracts: { [key: string]: string }) {
	console.log("🛠️  Setting up system...")
	const coreAddress = deployedContracts.diamond
	const affiliateHubAddress = deployedContracts.affiliateHub
	const accountHubAddress = deployedContracts.accountHub

	if (!coreAddress || !affiliateHubAddress || !accountHubAddress) {
		throw new Error("Missing deployment addresses required for setup")
	}

	console.log("🔗 Connecting contracts...")
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()
	const accountHub = await ethers.getContractAt("AccountHub", accountHubAddress)
	const affiliateHub = await ethers.getContractAt("AffiliateHub", affiliateHubAddress)
	const controlFacet = await ethers.getContractAt("ControlFacet", coreAddress)

	console.log("🔐 Granting roles...")
	await accountHub.connect(deployer).grantRole(ethers.keccak256(ethers.toUtf8Bytes("DEPLOYER_ROLE")), affiliateHubAddress)
	await affiliateHub.connect(deployer).grantRole(ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE")), await deployer.getAddress())
	await affiliateHub.connect(deployer).grantRole(ethers.keccak256(ethers.toUtf8Bytes("APPROVER_ROLE")), await deployer.getAddress())
	console.log("⚙️  Linking hubs and whitelisting core...")
	await affiliateHub.connect(deployer).setAccountHub(accountHubAddress)
	await affiliateHub.connect(deployer).setWhitelistedSymmioCore(coreAddress, true)

	console.log("🧾 Requesting affiliate registration (static call)...")
	const accountManagerAddress = await affiliateHub.connect(deployer).requestToRegisterAffiliate.staticCall({
		name: "test affiliate",
		brandColor: "d69d00",
		admin: await deployer.getAddress(),
		stakeholders: [
			{
				receiver: await deployer.getAddress(),
				share: ethers.parseEther("0"),
			},
		],
		symmioShare: ethers.parseEther("1"),
		metadata: "0x",
		legacyMultiAccounts: [],
		symmioCores: [coreAddress],
	})

	console.log("🧾 Requesting affiliate registration (tx)...")
	await affiliateHub.connect(deployer).requestToRegisterAffiliate({
		name: "test affiliate",
		brandColor: "d69d00",
		admin: await deployer.getAddress(),
		stakeholders: [
			{
				receiver: await deployer.getAddress(),
				share: ethers.parseEther("0"),
			},
		],
		symmioShare: ethers.parseEther("1"),
		metadata: "0x",
		legacyMultiAccounts: [],
		symmioCores: [coreAddress],
	})

	console.log("🔐 Granting signer admin roles...")
	await controlFacet.connect(deployer).grantRole(affiliateHubAddress, ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ADMIN_ROLE")))
	await controlFacet.connect(deployer).grantRole(accountHubAddress, ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ADMIN_ROLE")))

	console.log("✅ Approving affiliate...")
	await affiliateHub.connect(deployer).approveAffiliate(accountManagerAddress)
	console.log("✅ System setup complete.")
}

/**
 * Generates a comprehensive deployment report
 */
function generateReport(deployments: DeploymentResult[], verifications: VerificationResult[]): SystemDeploymentReport {
	const successfulDeployments = deployments.filter(d => d.status === "success").length
	const failedDeployments = deployments.filter(d => d.status === "failed").length

	const successfulVerifications = verifications.filter(v => v.status === "success" || v.status === "already_verified").length
	const failedVerifications = verifications.filter(v => v.status === "failed").length

	return {
		deployments,
		verifications,
		summary: {
			totalContracts: deployments.length,
			successfulDeployments,
			failedDeployments,
			successfulVerifications,
			failedVerifications,
		},
		timestamp: new Date().toISOString(),
	}
}

/**
 * Displays the deployment report in console
 */
function displayReport(report: SystemDeploymentReport): void {
	// Deployment Summary
	console.log("📊 DEPLOYMENT SUMMARY")
	console.log("-".repeat(80))
	console.log(`Total Contracts: ${report.summary.totalContracts}`)
	console.log(`Successful Deployments: ${report.summary.successfulDeployments} ✅`)
	console.log(`Failed Deployments: ${report.summary.failedDeployments} ❌`)
	console.log()

	// Deployment Details
	console.log("📋 DEPLOYMENT DETAILS")
	console.log("-".repeat(80))
	for (const deployment of report.deployments) {
		const icon = deployment.status === "success" ? "✅" : "❌"
		console.log(`${icon} ${deployment.contract}`)
		console.log(`   Address: ${deployment.address}`)
		console.log(`   Status: ${deployment.status}`)
		if (deployment.error) {
			console.log(`   Error: ${deployment.error}`)
		}
		console.log(`   Timestamp: ${deployment.timestamp}`)
		console.log()
	}

	// Verification Summary
	if (report.verifications.length > 0) {
		console.log("🔍 VERIFICATION SUMMARY")
		console.log("-".repeat(80))
		console.log(`Successful Verifications: ${report.summary.successfulVerifications} ✅`)
		console.log(`Failed Verifications: ${report.summary.failedVerifications} ❌`)
		console.log()

		// Verification Details
		console.log("📋 VERIFICATION DETAILS")
		console.log("-".repeat(80))
		for (const verification of report.verifications) {
			let icon = "⏭️"
			if (verification.status === "success" || verification.status === "already_verified") {
				icon = "✅"
			} else if (verification.status === "failed") {
				icon = "❌"
			}

			console.log(`${icon} ${verification.contract}`)
			console.log(`   Address: ${verification.address}`)
			console.log(`   Status: ${verification.status}`)
			if (verification.error) {
				console.log(`   Error: ${verification.error}`)
			}
			console.log()
		}
	}

	console.log("=".repeat(80))
	console.log(`Report generated at: ${report.timestamp}`)
	console.log("=".repeat(80))
}

/**
 * Saves the report to a JSON file
 */
function saveReport(report: SystemDeploymentReport): void {
	try {
		const filename = `deployment-report-${Date.now()}.json`

		writeData(filename, report)

		console.log()
		console.log(`📁 Full report saved to: ${filename}`)
	} catch (err: any) {
		console.error(`Failed to save report: ${err.message}`)
	}
}
