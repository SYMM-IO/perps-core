import { ethers } from "../../test/helpers/hardhat-connection.js"

// Required: INSTANT_LAYER_ADDRESS, ACCOUNT_ADDRESS, EXPECTED_CHAIN_ID.

function requiredAddress(name: string): string {
	const value = process.env[name]
	if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be an explicit non-zero address`)
	return ethers.getAddress(value)
}

async function main(): Promise<void> {
	const instantLayerAddress = requiredAddress("INSTANT_LAYER_ADDRESS")
	const accountAddress = requiredAddress("ACCOUNT_ADDRESS")
	const expectedChainIdRaw = process.env.EXPECTED_CHAIN_ID
	if (!expectedChainIdRaw || !/^\d+$/.test(expectedChainIdRaw) || BigInt(expectedChainIdRaw) <= 0n) {
		throw new Error("EXPECTED_CHAIN_ID must be an explicit positive integer")
	}
	const network = await ethers.provider.getNetwork()
	if (network.chainId !== BigInt(expectedChainIdRaw))
		throw new Error(`Chain mismatch: connected to ${network.chainId}, expected ${expectedChainIdRaw}`)
	if ((await ethers.provider.getCode(instantLayerAddress)) === "0x") throw new Error(`No InstantLayer code at ${instantLayerAddress}`)

	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress)
	const setterRole = await instantLayer.SETTER_ROLE()
	const defaultAdminRole = await instantLayer.DEFAULT_ADMIN_ROLE()
	const hasSetterRole = await instantLayer.hasRole(setterRole, accountAddress)
	const hasAdminRole = await instantLayer.hasRole(defaultAdminRole, accountAddress)
	console.log(`InstantLayer:                  ${instantLayerAddress}`)
	console.log(`Chain:                         ${network.chainId}`)
	console.log(`Account:                       ${accountAddress}`)
	console.log(`SETTER_ROLE hash:              ${setterRole}`)
	console.log(`Account has SETTER_ROLE:       ${hasSetterRole}`)
	console.log(`Account has DEFAULT_ADMIN_ROLE:${hasAdminRole}`)
	if (!hasSetterRole) throw new Error(`${accountAddress} is missing SETTER_ROLE on ${instantLayerAddress}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
