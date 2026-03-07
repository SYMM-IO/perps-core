import { ethers, networkHelpers } from "../../test/helpers/hardhat-connection.js"

/**
 * Reads the diamond owner from ViewFacet.owner().
 */
export async function resolveOwner(diamondAddress: string): Promise<string> {
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamondAddress)
	const owner = await viewFacet.owner()
	if (!owner || owner === ethers.ZeroAddress) {
		throw new Error(`Diamond at ${diamondAddress} returned zero owner`)
	}
	return owner
}

/**
 * Impersonates an address and funds it with ETH using hardhat network helpers.
 */
export async function impersonateAndFund(address: string, ethAmount: bigint = ethers.parseEther("100")): Promise<any> {
	await networkHelpers.impersonateAccount(address)
	await networkHelpers.setBalance(address, ethAmount)
	return await ethers.getSigner(address)
}

/**
 * Resolves the diamond owner (or uses an override), impersonates and funds it.
 * Returns the impersonated signer ready to call owner-only functions.
 */
export async function getImpersonatedAdmin(diamondAddress: string, adminOverride?: string): Promise<any> {
	const admin = adminOverride || (await resolveOwner(diamondAddress))
	console.log(`Admin resolved: ${admin}${adminOverride ? " (override)" : " (from ViewFacet.owner())"}`)
	const signer = await impersonateAndFund(admin)
	console.log(`Admin impersonated and funded with 100 ETH`)
	return signer
}
