import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { upsertDeploymentRecords } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { SYMBOLMANAGER_DEPLOYMENT_FILE } from "./constants.js"
import { checkpointDeployment, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { assertStandaloneDeploymentTaskAllowed, checksumAddress, getConnection } from "./helpers.js"
import { setHyperEVMBigBlocks } from "./hyperevm.js"
import { logger } from "./logger.js"
import { confirmDeployment, send } from "./tx.js"
import { deployContract, type VanityContext } from "./vanityDeploy.js"

// Role hashes for the Symmio core Diamond that the SymbolManager needs in order
// to proxy symbol CRUD + force-close-gap-ratio calls. Kept here as plain strings
// so they match exactly what LibAccessibility.sol hashes at runtime.
const CORE_ROLE_SYMBOL_MANAGER = "SYMBOL_MANAGER_ROLE"
const CORE_ROLE_FORCE_CLOSE_GAP_RATIO_ADMIN = "FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"

// Operator roles on the SymbolManager contract itself (from SymmioSymbolManager.sol)
const OPERATOR_ROLES_DEFAULT: readonly string[] = ["SYMBOL_ADDER_ROLE", "SYMBOL_REMOVER_ROLE"]

/**
 * These options are declared STRING_WITHOUT_DEFAULT, so omitting one passes `undefined`
 * straight through to checksumAddress(), which fails with an opaque
 * "Cannot read properties of undefined (reading 'toLowerCase')". Fail with the flag name.
 */
function requireArg(value: string | undefined, flag: string): string {
	if (!value) throw new Error(`Missing required option --${flag}`)
	return value
}

type DeploySymbolManagerArgs = {
	/** Present when the owning deployment mines CREATE2 addresses; null for standalone runs. */
	vanity?: VanityContext | null
	symmioAddress: string
	admin?: string
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deploySymbolManager(
	hre: any,
	{ symmioAddress: rawSymmio, admin: rawAdmin, logData = true, checkpoint, vanity }: DeploySymbolManagerArgs,
) {
	const { ethers } = await getConnection(hre)
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.symbolManager")
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
		const [recordedSymmio = symmioAddress, recordedAdmin = admin] = checkpoint.contracts.symbolManager.constructorArgs || []
		logger.reused("SymmioSymbolManager", address)
		if (logData) writeSymbolManagerRecord(address, String(recordedSymmio), String(recordedAdmin))
		return ethers.getContractAt("SymmioSymbolManager", address)
	}

	const factory = await ethers.getContractFactory("SymmioSymbolManager")
	const { address } = await deployContract(vanity || null, {
		key: "peripherals/SymbolManager",
		component: "contracts.symbolManager",
		label: "SymmioSymbolManager",
		factory: factory.connect(deployer),
		constructorArgs: [symmioAddress, admin],
		checkpoint,
	})
	logger.deployed("SymmioSymbolManager", address)

	if (checkpoint) {
		checkpoint.contracts.symbolManager = createDeployedContract(address, [symmioAddress, admin])
		saveCheckpoint(checkpoint)
	}

	if (logData) {
		writeSymbolManagerRecord(address, symmioAddress, admin)
		logger.debug("Deployed addresses written to JSON file")
	}

	return ethers.getContractAt("SymmioSymbolManager", address)
}

function writeSymbolManagerRecord(address: string, symmioAddress: string, admin: string): void {
	upsertDeploymentRecords(SYMBOLMANAGER_DEPLOYMENT_FILE, [{ name: "SymmioSymbolManager", address, constructorArguments: [symmioAddress, admin] }])
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
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:symbolManager")
			const connection = await getConnection(hre)
			const { ethers } = connection
			const chainId = Number((await ethers.provider.getNetwork()).chainId)
			// HyperEVM mainnet=999, testnet=998 — deploys need big blocks to land reliably
			const isSimulatedNetwork = (connection as any).networkConfig?.type === "edr-simulated"
			const isHyperEVM = !isSimulatedNetwork && (chainId === 999 || chainId === 998)

			if (isHyperEVM) {
				logger.info("HyperEVM detected — enabling big blocks for contract deployment...")
				await setHyperEVMBigBlocks(hre, true)
			}

			let deploymentFailed = false
			try {
				return await deploySymbolManager(hre, { symmioAddress: requireArg(symmioAddress, "symmio-address"), admin, logData })
			} catch (error) {
				deploymentFailed = true
				throw error
			} finally {
				if (isHyperEVM) {
					try {
						logger.info("Deployment complete — disabling big blocks...")
						await setHyperEVMBigBlocks(hre, false)
					} catch (err: any) {
						logger.error(`Failed to disable big blocks: ${err.message}`)
						logger.error("Run './node_modules/.bin/hardhat hyperevm:disable-big-blocks --network hyperevm' manually.")
						if (!deploymentFailed) throw err
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
		await send(controlFacet.connect(deployer).grantRole(symbolManagerAddress, roleHash(role)), `grant ${role} to SymbolManager`)
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
		default: async ({ symmioAddress, symbolManagerAddress }, hre) =>
			grantSymbolManagerDiamondRoles(hre, {
				symmioAddress: requireArg(symmioAddress, "symmio-address"),
				symbolManagerAddress: requireArg(symbolManagerAddress, "symbol-manager-address"),
			}),
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
	const roleStates = await Promise.all(
		roles.map(async role => ({
			role,
			already: await sm.hasRole(roleHash(role), operator),
		})),
	)
	const missingRoles = roleStates.filter(state => !state.already).map(state => state.role)
	if (missingRoles.length === 0) {
		for (const { role } of roleStates) logger.info(`  ⏭ ${role} already granted to ${operator}`)
		logger.info(`  Operator roles: 0 granted, ${roles.length} already had`)
		return { granted: 0, skipped: roles.length, deferred: 0, missingRoles: [] as string[] }
	}

	// SymmioSymbolManager's constructor grants DEFAULT_ADMIN_ROLE to `admin` only — the
	// deployer gets nothing. Whenever ADMIN_PUBLIC_KEY differs from the deployer (i.e. any
	// real deployment, where admin is a multisig) these grants revert. Detect that up front
	// and hand the operator an exact command instead of failing the whole deployment at the
	// last step with a raw AccessControl revert.
	const deployerIsAdmin = await sm.hasRole(await sm.DEFAULT_ADMIN_ROLE(), deployer.address)
	if (!deployerIsAdmin) {
		logger.info("")
		logger.info(`  ⚠ Deployer ${deployer.address} does not hold DEFAULT_ADMIN_ROLE on the SymbolManager,`)
		logger.info(`    so it cannot grant operator roles. The admin must run this themselves:`)
		logger.info("")
		logger.info(`      ./node_modules/.bin/hardhat symbolManager:grantOperatorRoles \\`)
		logger.info(`        --symbol-manager-address ${symbolManagerAddress} \\`)
		logger.info(`        --operator ${operator} --network <network>`)
		logger.info("")
		logger.info(`    Roles still to grant: ${missingRoles.join(", ")}`)
		return { granted: 0, skipped: roles.length - missingRoles.length, deferred: missingRoles.length, missingRoles }
	}

	let granted = 0
	let skipped = 0
	for (const { role, already } of roleStates) {
		if (already) {
			logger.info(`  ⏭ ${role} already granted to ${operator}`)
			skipped++
			continue
		}
		logger.info(`  Granting ${role} to ${operator} on SymbolManager...`)
		await send(sm.connect(deployer).grantRole(roleHash(role), operator), `grant ${role} to ${operator}`)
		granted++
	}

	logger.info(`  Operator roles: ${granted} granted, ${skipped} already had`)
	return { granted, skipped, deferred: 0, missingRoles: [] as string[] }
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
		default: async ({ symbolManagerAddress, operator }, hre) =>
			grantSymbolManagerOperatorRoles(hre, {
				symbolManagerAddress: requireArg(symbolManagerAddress, "symbol-manager-address"),
				operator: requireArg(operator, "operator"),
			}),
	}))
	.build()
