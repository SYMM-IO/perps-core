import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { SYMBOLMANAGER_DEPLOYMENT_FILE } from "./constants.js"
import { checksumAddress, getConnection } from "./helpers.js"
import { setHyperEVMBigBlocks } from "./hyperevm.js"
import { logger } from "./logger.js"

// Role hashes for the Symmio core Diamond that the SymbolManager needs in order
// to proxy symbol CRUD + force-close-gap-ratio calls. Kept here as plain strings
// so they match exactly what LibAccessibility.sol hashes at runtime.
const CORE_ROLE_SYMBOL_MANAGER = "SYMBOL_MANAGER_ROLE"
const CORE_ROLE_FORCE_CLOSE_GAP_RATIO_ADMIN = "FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"

// Operator roles on the SymbolManager contract itself (from SymmioSymbolManager.sol)
const OPERATOR_ROLES_DEFAULT: readonly string[] = ["SYMBOL_ADDER_ROLE", "SYMBOL_REMOVER_ROLE"]

type DeploySymbolManagerArgs = {
	symmioAddress: string
	admin?: string
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deploySymbolManager(
	hre: any,
	{ symmioAddress: rawSymmio, admin: rawAdmin, logData = true, checkpoint }: DeploySymbolManagerArgs,
) {
	const { ethers } = await getConnection(hre)
	logger.section("SymmioSymbolManager Deployment")

	const [deployer] = await ethers.getSigners()
	const symmioAddress = checksumAddress(rawSymmio)
	const admin = checksumAddress(rawAdmin || deployer.address)

	logger.debug("Deploying SymmioSymbolManager with account:", deployer.address)
	logger.debug("Symmio:", symmioAddress)
	logger.debug("Admin:", admin)

	// Resume from checkpoint if we already deployed in a previous run
	if (checkpoint?.contracts.symbolManager) {
		const address = checkpoint.contracts.symbolManager.address
		logger.info(`  ⏭ SymmioSymbolManager already deployed at ${address}`)
		return ethers.getContractAt("SymmioSymbolManager", address)
	}

	const factory = await ethers.getContractFactory("SymmioSymbolManager")
	const contract = await factory.connect(deployer).deploy(symmioAddress, admin)
	await contract.waitForDeployment()
	await contract.deploymentTransaction()!.wait()

	const address = await contract.getAddress()
	logger.deployed("SymmioSymbolManager", address)

	if (checkpoint) {
		checkpoint.contracts.symbolManager = createDeployedContract(address, [symmioAddress, admin])
		saveCheckpoint(checkpoint)
	}

	if (logData) {
		let deployedData: any[] = []
		try {
			deployedData = readData(SYMBOLMANAGER_DEPLOYMENT_FILE)
		} catch (err) {
			logger.debug(`Could not read existing JSON file: ${err}`)
		}

		deployedData.push({
			name: "SymmioSymbolManager",
			address,
			constructorArguments: [symmioAddress, admin],
		})

		writeData(SYMBOLMANAGER_DEPLOYMENT_FILE, deployedData)
		logger.debug("Deployed addresses written to JSON file")
	}

	return contract
}

export const symbolManagerTask = task("deploy:symbolManager", "Deploys the SymmioSymbolManager")
	.addOption({
		name: "symmioAddress",
		description: "The address of the Symmio core Diamond",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "admin",
		description: "The admin address (defaults to deployer)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "logData", description: "Write the deployed address to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ symmioAddress, admin, logData }, hre) => {
			const { ethers } = await getConnection(hre)
			const chainId = Number((await ethers.provider.getNetwork()).chainId)
			// HyperEVM mainnet=999, testnet=998 — deploys need big blocks to land reliably
			const isHyperEVM = chainId === 999 || chainId === 998

			if (isHyperEVM) {
				logger.info("HyperEVM detected — enabling big blocks for contract deployment...")
				await setHyperEVMBigBlocks(hre, true)
			}

			try {
				return await deploySymbolManager(hre, { symmioAddress, admin, logData })
			} finally {
				if (isHyperEVM) {
					try {
						logger.info("Deployment complete — disabling big blocks...")
						await setHyperEVMBigBlocks(hre, false)
					} catch (err: any) {
						logger.error(`Failed to disable big blocks: ${err.message}`)
						logger.error("Run 'npx hardhat hyperevm:disable-big-blocks --network hyperevm' manually.")
					}
				}
			}
		},
	}))
	.build()

// ============================================================================
// Grant core-Diamond roles TO the SymbolManager
// ============================================================================

type GrantDiamondRolesArgs = {
	symmioAddress: string
	symbolManagerAddress: string
}

/**
 * Grants the Symmio-core roles that let SymmioSymbolManager perform symbol CRUD
 * and force-close-gap-ratio updates. Idempotent — skips roles already granted.
 */
export async function grantSymbolManagerDiamondRoles(hre: any, { symmioAddress: rawSymmio, symbolManagerAddress: rawSm }: GrantDiamondRolesArgs) {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()

	const symmioAddress = checksumAddress(rawSymmio)
	const symbolManagerAddress = checksumAddress(rawSm)

	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", symmioAddress)
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", symmioAddress)
	const roleHash = (role: string) => ethers.keccak256(ethers.toUtf8Bytes(role))

	const rolesToGrant = [CORE_ROLE_SYMBOL_MANAGER, CORE_ROLE_FORCE_CLOSE_GAP_RATIO_ADMIN]

	let granted = 0
	let skipped = 0
	for (const role of rolesToGrant) {
		const already = await viewFacet.hasRole(symbolManagerAddress, roleHash(role))
		if (already) {
			logger.info(`  ⏭ ${role} already granted to SymbolManager`)
			skipped++
			continue
		}
		logger.info(`  Granting ${role} to SymbolManager on Symmio core...`)
		const tx = await controlFacet.connect(deployer).grantRole(symbolManagerAddress, roleHash(role))
		await tx.wait()
		granted++
	}

	logger.info(`  Diamond roles: ${granted} granted, ${skipped} already had`)
	return { granted, skipped }
}

export const grantSymbolManagerDiamondRolesTask = task(
	"symbolManager:grantDiamondRoles",
	"Grants SYMBOL_MANAGER_ROLE and FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE on the Symmio Diamond to the SymbolManager",
)
	.addOption({
		name: "symmioAddress",
		description: "The address of the Symmio core Diamond",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "symbolManagerAddress",
		description: "The address of the deployed SymmioSymbolManager",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async ({ symmioAddress, symbolManagerAddress }, hre) => grantSymbolManagerDiamondRoles(hre, { symmioAddress, symbolManagerAddress }),
	}))
	.build()

// ============================================================================
// Grant operator roles ON the SymbolManager (to an off-chain bot / operator)
// ============================================================================

type GrantOperatorRolesArgs = {
	symbolManagerAddress: string
	operator: string
	roles?: readonly string[]
}

/**
 * Grants operator roles (default SYMBOL_ADDER_ROLE + SYMBOL_REMOVER_ROLE) on the
 * SymbolManager to an off-chain operator account so it can call the batch
 * mutators. Idempotent — skips roles already granted.
 */
export async function grantSymbolManagerOperatorRoles(
	hre: any,
	{ symbolManagerAddress: rawSm, operator: rawOperator, roles = OPERATOR_ROLES_DEFAULT }: GrantOperatorRolesArgs,
) {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()

	const symbolManagerAddress = checksumAddress(rawSm)
	const operator = checksumAddress(rawOperator)

	const sm = await ethers.getContractAt("SymmioSymbolManager", symbolManagerAddress)
	const roleHash = (role: string) => ethers.keccak256(ethers.toUtf8Bytes(role))

	let granted = 0
	let skipped = 0
	for (const role of roles) {
		const already = await sm.hasRole(roleHash(role), operator)
		if (already) {
			logger.info(`  ⏭ ${role} already granted to ${operator}`)
			skipped++
			continue
		}
		logger.info(`  Granting ${role} to ${operator} on SymbolManager...`)
		const tx = await sm.connect(deployer).grantRole(roleHash(role), operator)
		await tx.wait()
		granted++
	}

	logger.info(`  Operator roles: ${granted} granted, ${skipped} already had`)
	return { granted, skipped }
}

export const grantSymbolManagerOperatorRolesTask = task(
	"symbolManager:grantOperatorRoles",
	"Grants SYMBOL_ADDER_ROLE and SYMBOL_REMOVER_ROLE on the SymbolManager to an operator",
)
	.addOption({
		name: "symbolManagerAddress",
		description: "The address of the deployed SymmioSymbolManager",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "operator",
		description: "Operator address to receive the roles",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async ({ symbolManagerAddress, operator }, hre) => grantSymbolManagerOperatorRoles(hre, { symbolManagerAddress, operator }),
	}))
	.build()
