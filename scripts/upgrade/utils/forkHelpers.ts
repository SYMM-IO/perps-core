import { ethers, networkHelpers } from "../../../test/helpers/hardhat-connection.js"

/**
 * Reads the diamond owner from LibDiamond storage.
 * Works on both v0.8.4 and v0.8.5 (doesn't depend on a view function).
 *
 * LibDiamond storage layout at keccak256("diamond.standard.diamond.storage"):
 *   slot+0: mapping(bytes4 => FacetAddressAndSelectorPosition)
 *   slot+1: bytes4[] selectors
 *   slot+2: mapping(bytes4 => bool) supportedInterfaces
 *   slot+3: address contractOwner
 *   slot+4: address pendingOwner
 */
export async function resolveOwner(diamondAddress: string): Promise<string> {
	const baseSlot = BigInt(ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.diamond.storage")))
	const ownerSlot = "0x" + (baseSlot + 3n).toString(16).padStart(64, "0")
	const raw = await ethers.provider.getStorage(diamondAddress, ownerSlot)
	const owner = ethers.getAddress("0x" + raw.slice(26)) // last 20 bytes of the 32-byte slot
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
	console.log(`Admin resolved: ${admin}${adminOverride ? " (override)" : " (from LibDiamond storage)"}`)
	const signer = await impersonateAndFund(admin)
	console.log(`Admin impersonated and funded with 100 ETH`)
	return signer
}
