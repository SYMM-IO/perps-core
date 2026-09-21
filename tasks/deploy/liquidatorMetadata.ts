import { getAddress, id, type Signer } from "ethers"

import { send } from "./tx.js"

export const LIQUIDATOR_METADATA = Object.freeze({ name: "Protocol Liquidator V2", brandColor: "#327bba", metadata: "" })

export async function requireLiquidatorMetadataAuthority(coreView: any, signer: Signer): Promise<void> {
	const caller = await signer.getAddress()
	if (!(await coreView.hasRole(caller, id("AFFILIATE_MANAGER_ROLE")))) {
		throw new Error(`Signer ${caller} must hold AFFILIATE_MANAGER_ROLE on the connected Core to set liquidator metadata`)
	}
}

export async function verifyLiquidatorMetadata(coreView: any, proxyAddress: string): Promise<void> {
	const stored = await coreView.getEntityMetadata(proxyAddress)
	for (const field of ["name", "brandColor", "metadata"] as const) {
		if (stored[field] !== LIQUIDATOR_METADATA[field]) {
			throw new Error(
				`Liquidator metadata post-check failed for ${proxyAddress}: ${field} expected ${JSON.stringify(LIQUIDATOR_METADATA[field])}, got ${JSON.stringify(stored[field])}`,
			)
		}
	}
}

/** Uses the affiliate-authorized setter only; it does not register an affiliate. */
export async function ensureLiquidatorMetadata(ethers: any, liquidator: any, coreAddress: string, signer: Signer): Promise<void> {
	const proxyAddress = getAddress(await liquidator.getAddress())
	if (getAddress(await liquidator.symmioAddress()) !== getAddress(coreAddress)) {
		throw new Error(`SymmioLiquidator ${proxyAddress} points to a different Symmio core`)
	}
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", coreAddress)
	const stored = await view.getEntityMetadata(proxyAddress)
	if (Object.entries(LIQUIDATOR_METADATA).some(([field, expected]) => stored[field] !== expected)) {
		await requireLiquidatorMetadataAuthority(view, signer)
		const control = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", coreAddress, signer)
		await control.setAffiliateMetadata.staticCall(proxyAddress, LIQUIDATOR_METADATA)
		await send(control.setAffiliateMetadata(proxyAddress, LIQUIDATOR_METADATA), `setAffiliateMetadata for SymmioLiquidator ${proxyAddress}`)
	}
	await verifyLiquidatorMetadata(view, proxyAddress)
}
