import fs from "fs"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { getDataDir, setDataScope } from "../utils/fs.js"
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js"
import { componentCheckpointScope, componentReportRelativePath, type DeploymentComponentName } from "./deploymentRecipe.js"
import { persistSubmittedTransaction } from "./deploymentRecovery.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { requireActiveDeploymentRecipe } from "./recipeRuntime.js"
import { bindDeploymentTransactionWriteAhead, clearDeploymentTransactionWriteAhead, resetDeploymentTransactionJournal, send } from "./tx.js"

const OPERATOR_ROLES = ["SYMBOL_ADDER_ROLE", "SYMBOL_REMOVER_ROLE"] as const

function requireAddress(ethers: any, value: unknown, label: string): string {
	if (typeof value !== "string" || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
		throw new Error(`${label} must be a valid non-zero address`)
	}
	return ethers.getAddress(value)
}

/**
 * Complete the externally-owned-account handover used by the persistent localhost
 * rehearsal. This is deliberately unavailable on forks and live networks: Safe and
 * governance execution remains an external, evidenced boundary there.
 */
export async function completeLocalHandover(hre: any, recipePath?: string): Promise<{ transactions: number }> {
	const active = requireActiveDeploymentRecipe(recipePath)
	if (active.recipe.network.mode !== "local" || active.recipe.network.chainId !== 31337) {
		throw new Error("Local handover automation is restricted to a recipe targeting persistent localhost chain 31337")
	}

	const { ethers } = await getConnection(hre)
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	if (chainId !== 31337) throw new Error(`Local handover connected to unexpected chainId ${chainId}`)
	setDataScope(chainId, { simulated: false })
	const admin = requireAddress(ethers, active.recipe.governance.admin, "governance admin")
	const unlocked: string[] = (await ethers.provider.send("eth_accounts", [])).map((value: string) => ethers.getAddress(value))
	if (!unlocked.some(value => value === admin)) {
		throw new Error(`The local governance admin ${admin} is not exposed as an unlocked account by the persistent Hardhat node`)
	}
	const adminSigner = await ethers.getSigner(admin)

	if (active.recipe.core.mode !== "deploy") {
		const components = (["partyB", "symbolManager", "expressProvider"] as const).filter(component => active.recipe[component].mode !== "skip")
		if (active.recipe.core.mode !== "reuse" || components.length !== 1) {
			throw new Error("Local component handover requires core.mode=reuse and exactly one selected component")
		}
		const component = components[0] as DeploymentComponentName
		const reportPath = `${getDataDir()}/${componentReportRelativePath(active.recipe.name, component)}`
		if (!fs.existsSync(reportPath)) throw new Error(`Local component report is missing: ${reportPath}`)
		const report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
		if (report?.recipe?.digest !== active.digest || report?.recipe?.name !== active.recipe.name || report?.component !== component) {
			throw new Error("Local component report is not bound to the active reviewed recipe and component")
		}
		if (requireAddress(ethers, report.config?.admin, "component admin") !== admin) {
			throw new Error(`Local component report admin does not match the reviewed governance admin ${admin}`)
		}
		if (!Array.isArray(report.manualActions)) throw new Error("Local component report manualActions must be an array")
		const checkpoint = loadCheckpoint(chainId, componentCheckpointScope(active.recipe.name, component))
		if (!checkpoint || checkpoint.deploymentId !== report.deploymentId) {
			throw new Error("Local component handover requires the matching incomplete deployment checkpoint")
		}

		let transactions = 0
		resetDeploymentTransactionJournal()
		bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint, record))
		try {
			for (const [index, action] of report.manualActions.entries()) {
				const to = requireAddress(ethers, action?.to, `manualActions[${index}].to`)
				if (typeof action?.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(action.data)) {
					throw new Error(`manualActions[${index}].data must be even-length hex calldata`)
				}
				let value: bigint
				try {
					value = BigInt(action.value)
				} catch {
					throw new Error(`manualActions[${index}].value must be an unsigned integer`)
				}
				if (value < 0n) throw new Error(`manualActions[${index}].value must be an unsigned integer`)
				const alreadyConfirmed = (checkpoint.transactions || []).some(
					record =>
						(record.status === "confirmed" || record.status === "replaced") &&
						record.to?.toLowerCase() === to.toLowerCase() &&
						record.data?.toLowerCase() === action.data.toLowerCase() &&
						BigInt(record.value || "0") === value,
				)
				if (alreadyConfirmed) {
					logger.info(`  ⏭ ${action.description || `local component action ${index + 1}`} already confirmed`)
					continue
				}
				await send(adminSigner.sendTransaction({ to, data: action.data, value }), action.description || `execute local component action ${index + 1}`)
				transactions++
			}
		} finally {
			clearDeploymentTransactionWriteAhead()
			saveCheckpoint(checkpoint)
		}
		return { transactions }
	}

	const reportPath = `${getDataDir()}/deployment-report.json`
	if (!fs.existsSync(reportPath)) throw new Error(`Local deployment report is missing: ${reportPath}`)
	const report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
	if (report?.recipe?.digest !== active.digest || report?.recipe?.name !== active.recipe.name) {
		throw new Error("Local deployment report is not bound to the active reviewed recipe")
	}
	const checkpoint = loadCheckpoint(chainId)
	if (!checkpoint || checkpoint.deploymentId !== report.deploymentId) {
		throw new Error("Local handover requires the matching incomplete deployment checkpoint")
	}

	const core = requireAddress(ethers, report.addresses?.diamond, "Core Diamond")
	const accountLayer = requireAddress(ethers, report.addresses?.accountLayerDiamond, "AccountLayer Diamond")
	const expressProvider =
		active.recipe.expressProvider.mode === "skip" ? undefined : requireAddress(ethers, report.addresses?.expressProvider, "ExpressProvider")
	const symbolManager =
		active.recipe.symbolManager.mode === "skip" ? undefined : requireAddress(ethers, report.addresses?.symbolManager, "SymbolManager")
	const symbolOperator =
		active.recipe.symbolManager.mode === "skip" ? undefined : requireAddress(ethers, active.recipe.symbolManager.operator, "SymbolManager operator")
	let transactions = 0

	resetDeploymentTransactionJournal()
	bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint, record))
	try {
		const ownershipTargets = [
			{
				label: "Core Diamond",
				contract: await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", core),
				reader: await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core),
			},
			{
				label: "AccountLayer Diamond",
				contract: await ethers.getContractAt("contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet", accountLayer),
				reader: await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", accountLayer),
			},
		]
		if (expressProvider) {
			ownershipTargets.push({
				label: "ExpressProvider",
				contract: await ethers.getContractAt("contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet", expressProvider),
				reader: await ethers.getContractAt("contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet", expressProvider),
			})
		}
		for (const target of ownershipTargets) {
			const [owner, pendingOwner] = await Promise.all([
				target.label === "ExpressProvider" ? target.reader.owner() : target.reader.getOwner(),
				target.reader.pendingOwner(),
			])
			if (ethers.getAddress(owner) === admin) {
				logger.info(`  ⏭ ${target.label} ownership already accepted by local admin`)
				continue
			}
			if (ethers.getAddress(pendingOwner) !== admin) {
				throw new Error(`${target.label} pending owner is ${pendingOwner}; expected local admin ${admin}`)
			}
			await send(target.contract.connect(adminSigner).acceptOwnership(), `accept ${target.label} ownership`)
			transactions++
		}

		const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
		if (expressProvider && !(await coreView.isExpressProviderRegistered(expressProvider))) {
			const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", core)
			await send(coreControl.connect(adminSigner).registerExpressProvider(expressProvider), "register ExpressProvider on Core as local admin")
			transactions++
		}

		if (symbolManager && symbolOperator) {
			const manager = await ethers.getContractAt("SymmioSymbolManager", symbolManager)
			for (const role of OPERATOR_ROLES) {
				const roleHash = ethers.keccak256(ethers.toUtf8Bytes(role))
				if (await manager.hasRole(roleHash, symbolOperator)) continue
				await send(manager.connect(adminSigner).grantRole(roleHash, symbolOperator), `grant ${role} to local SymbolManager operator`)
				transactions++
			}
		}
	} finally {
		clearDeploymentTransactionWriteAhead()
		saveCheckpoint(checkpoint)
	}

	return { transactions }
}

export const completeLocalHandoverTask = task(
	"internal:complete-local-handover",
	"Internal adapter for completing a persistent-localhost deployment handover with unlocked accounts",
)
	.addOption({
		name: "recipe",
		description: "Exact reviewed local deployment recipe",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async ({ recipe }, hre) => completeLocalHandover(hre, recipe),
	}))
	.build()
