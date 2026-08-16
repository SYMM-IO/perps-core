/**
 * Recreate the four settleUpnl InstantLayer templates by copying the deployed
 * source templates exactly. The default mode is read-only planning.
 *
 * Plan:
 *   INSTANT_LAYER_ADDRESS=0x... \
 *     npx hardhat run --no-compile scripts/recreateInstantLayerSettlementTemplates.ts --network arbitrum
 *
 * Execute with an authorized SETTER_ROLE signer:
 *   INSTANT_LAYER_ADDRESS=0x... EXECUTE=true CONFIRM_CHAIN_ID=42161 \
 *     npx hardhat run --no-compile scripts/recreateInstantLayerSettlementTemplates.ts --network arbitrum
 *
 * REPAIR_PLAN_OUTPUT may be set to write exact Safe-compatible actions without broadcasting.
 */
import fs from "node:fs"
import path from "node:path"

import { exactBooleanEnv, requireExecutionConfirmation } from "../tasks/deploy/executionGuard.js"
import {
	SETTLEMENT_CURRENT_PRICE_OFFSET,
	SETTLEMENT_QUOTE_ID_OFFSET,
	assertSettlementTemplateRecreationComplete,
	buildSettlementTransactionOverrides,
	buildSettlementTemplateRecreationPlan,
	readInstantLayerTemplates,
	type SettlementTemplateRecreationAction,
} from "../tasks/deploy/instantLayerSettlementTemplates.js"
import { send } from "../tasks/deploy/tx.js"
import { ethers } from "../test/helpers/hardhat-connection.js"

const PLAN_API_VERSION = "operations.symm.io/instant-layer-settlement-template-recreation-v2"

function requiredAddress(name: string): string {
	const value = process.env[name]
	if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
		throw new Error(`${name} is required and must be a non-zero address`)
	}
	return ethers.getAddress(value)
}

function optionalAddress(name: string): string | undefined {
	const value = process.env[name]
	if (!value) return undefined
	if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address when provided`)
	return ethers.getAddress(value)
}

function atomicWriteJson(file: string, value: unknown): void {
	const resolved = path.resolve(file)
	fs.mkdirSync(path.dirname(resolved), { recursive: true })
	const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry), 2)}\n`, {
			mode: 0o600,
		})
		fs.renameSync(temporary, resolved)
	} catch (error) {
		try {
			fs.unlinkSync(temporary)
		} catch {}
		throw error
	}
}

function actionCalldata(instantLayer: any, action: SettlementTemplateRecreationAction): string {
	if (action.kind === "addTemplate") {
		return instantLayer.interface.encodeFunctionData("addTemplate", [action.name, action.operations])
	}
	if (action.kind === "setTemplateInstantOpenMode") {
		return instantLayer.interface.encodeFunctionData("setTemplateInstantOpenMode", [action.templateId, action.mode])
	}
	return instantLayer.interface.encodeFunctionData("setTemplateActive", [action.templateId, action.active])
}

async function authorityForMode(execute: boolean): Promise<{ address?: string; signer?: any }> {
	const safeAddress = optionalAddress("SYMMIO_SAFE_ADDRESS")
	if (safeAddress) return { address: safeAddress }
	const expectedAddress = optionalAddress("SYMMIO_EXPECTED_SIGNER")
	const signers = await ethers.getSigners()
	let signer: (typeof signers)[number] | undefined = signers[0]
	if (expectedAddress) {
		signer = undefined
		for (const candidate of signers) {
			if (ethers.getAddress(await candidate.getAddress()) === expectedAddress) {
				signer = candidate
				break
			}
		}
		if (!signer) throw new Error(`Expected signer ${expectedAddress} is not available from the selected signer mode`)
	}
	if (!signer) {
		if (execute || process.env.SYMMIO_SIGNER_MODE) throw new Error("The selected signer mode did not provide an executable signer")
		return {}
	}
	return { address: ethers.getAddress(await signer.getAddress()), signer }
}

async function assertSetterRole(instantLayer: any, authority: string | undefined, required: boolean): Promise<void> {
	if (!authority) {
		if (required) throw new Error("No SETTER_ROLE authority was provided")
		return
	}
	const setterRole = await instantLayer.SETTER_ROLE()
	if (!(await instantLayer.hasRole(setterRole, authority))) {
		throw new Error(`Authority ${authority} does not have SETTER_ROLE on InstantLayer ${await instantLayer.getAddress()}`)
	}
}

async function executeAction(instantLayer: any, action: SettlementTemplateRecreationAction): Promise<void> {
	let estimatedGas: bigint
	if (action.kind === "addTemplate") estimatedGas = await instantLayer.addTemplate.estimateGas(action.name, action.operations)
	else if (action.kind === "setTemplateInstantOpenMode") {
		estimatedGas = await instantLayer.setTemplateInstantOpenMode.estimateGas(action.templateId, action.mode)
	} else estimatedGas = await instantLayer.setTemplateActive.estimateGas(action.templateId, action.active)
	const overrides = buildSettlementTransactionOverrides(estimatedGas, await ethers.provider.getFeeData())
	console.log(`    Transaction fields ready — estimated gas ${estimatedGas}, limit ${overrides.gasLimit}`)

	if (action.kind === "addTemplate") {
		await instantLayer.addTemplate.staticCall(action.name, action.operations)
		await send(instantLayer.addTemplate(action.name, action.operations, overrides), action.description)
		return
	}
	if (action.kind === "setTemplateInstantOpenMode") {
		await instantLayer.setTemplateInstantOpenMode.staticCall(action.templateId, action.mode)
		await send(instantLayer.setTemplateInstantOpenMode(action.templateId, action.mode, overrides), action.description)
		return
	}
	await instantLayer.setTemplateActive.staticCall(action.templateId, action.active)
	await send(instantLayer.setTemplateActive(action.templateId, action.active, overrides), action.description)
}

async function main(): Promise<void> {
	const instantLayerAddress = requiredAddress("INSTANT_LAYER_ADDRESS")
	const expectedSymmio = optionalAddress("SYMMIO_ADDRESS")
	const chainId = (await ethers.provider.getNetwork()).chainId
	const execute = requireExecutionConfirmation(chainId)
	const deactivateOriginals = exactBooleanEnv("DEACTIVATE_ORIGINAL_TEMPLATES", true)
	if ((await ethers.provider.getCode(instantLayerAddress)) === "0x") throw new Error(`No contract code at ${instantLayerAddress}`)

	const authority = await authorityForMode(execute)
	const readOnlyInstantLayer: any = await ethers.getContractAt("InstantLayer", instantLayerAddress)
	const instantLayer: any = authority.signer ? readOnlyInstantLayer.connect(authority.signer) : readOnlyInstantLayer
	const configuredSymmio = ethers.getAddress(await readOnlyInstantLayer.symmio())
	if (expectedSymmio && configuredSymmio !== expectedSymmio) {
		throw new Error(`InstantLayer ${instantLayerAddress} points to ${configuredSymmio}, not expected Core ${expectedSymmio}`)
	}

	const templates = await readInstantLayerTemplates(readOnlyInstantLayer)
	const plan = buildSettlementTemplateRecreationPlan(templates, { deactivateOriginals })
	const nextTemplateId = BigInt(await readOnlyInstantLayer.getNextTemplateId())
	const actions = plan.actions.map(action => ({
		to: instantLayerAddress,
		value: "0",
		data: actionCalldata(readOnlyInstantLayer, action),
		description: action.description,
	}))
	const output = {
		apiVersion: PLAN_API_VERSION,
		createdAt: new Date().toISOString(),
		chainId: chainId.toString(),
		instantLayer: instantLayerAddress,
		symmio: configuredSymmio,
		authority: authority.address,
		nextTemplateId: nextTemplateId.toString(),
		quoteIdOffset: SETTLEMENT_QUOTE_ID_OFFSET.toString(),
		currentPriceOffset: SETTLEMENT_CURRENT_PRICE_OFFSET.toString(),
		deactivateOriginals,
		recreated: plan.recreated,
		templates: plan.templates,
		actions,
	}

	console.log("InstantLayer settlement-template recreation")
	console.log(`  Chain:          ${chainId}`)
	console.log(`  InstantLayer:   ${instantLayerAddress}`)
	console.log(`  Core:           ${configuredSymmio}`)
	console.log(`  Authority:      ${authority.address ?? "not supplied (read-only plan)"}`)
	console.log(`  Next template:  ${nextTemplateId}`)
	console.log(`  Quote-ID slot:  ${SETTLEMENT_QUOTE_ID_OFFSET} (currentPrice is ${SETTLEMENT_CURRENT_PRICE_OFFSET}; it is never overwritten)`)
	console.log(`  Mode:           ${execute ? "EXECUTE" : "PLAN ONLY"}`)
	for (const template of plan.templates) {
		console.log(
			`  ${template.name}: source ${template.sourceId} (${template.sourceActive ? "active" : "inactive"}), replacements [${template.replacementIds.join(", ")}] active [${template.activeReplacementIds.join(", ")}], unsafe-480 [${template.unsafeCurrentPriceOffsetIds.join(", ")}] instant-open ${template.instantOpenMode}`,
		)
	}
	if (actions.length === 0) console.log("  Actions:        none; recreation is already complete")
	else actions.forEach((action, index) => console.log(`  Action ${index + 1}:      ${action.description}`))

	if (process.env.REPAIR_PLAN_OUTPUT) {
		atomicWriteJson(process.env.REPAIR_PLAN_OUTPUT, output)
		console.log(`  Plan artifact:  ${path.resolve(process.env.REPAIR_PLAN_OUTPUT)}`)
	}

	await assertSetterRole(readOnlyInstantLayer, authority.address, execute || Boolean(process.env.SYMMIO_SIGNER_MODE))
	if (!execute) {
		console.log(`\nPlan complete. Review it, then rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId}.`)
		return
	}
	if (!authority.signer) throw new Error("Safe action mode cannot broadcast directly; export or propose the generated actions through the SYMMIO CLI")

	for (const action of plan.actions) await executeAction(instantLayer, action)

	const finalTemplates = await readInstantLayerTemplates(readOnlyInstantLayer)
	if (deactivateOriginals) assertSettlementTemplateRecreationComplete(finalTemplates)
	else {
		const remaining = buildSettlementTemplateRecreationPlan(finalTemplates, { deactivateOriginals: false })
		if (!remaining.recreated) throw new Error(`Exact settlement-template replacements are incomplete; ${remaining.actions.length} action(s) remain`)
	}
	console.log(
		"\nSettlement templates verified: every exact offset-448 replacement is active and the requested original-template policy is satisfied.",
	)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
