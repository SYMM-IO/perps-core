/**
 * Verify all facets for a diamond address.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... npx hardhat run scripts/verify-diamond-facets.ts --network <network>
 *   npx hardhat run scripts/verify-diamond-facets.ts --network <network> -- 0x...
 */
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import hre from "hardhat"

function getDiamondAddress(): string | undefined {
	if (process.env.DIAMOND_ADDRESS) return process.env.DIAMOND_ADDRESS
	return process.argv.find(arg => /^0x[a-fA-F0-9]{40}$/.test(arg))
}

function isAlreadyVerifiedError(message: string): boolean {
	return message.includes("Already Verified") || message.includes("already verified")
}

async function main() {
	const { ethers } = await hre.network.connect()
	const diamondAddress = getDiamondAddress()

	if (!diamondAddress) throw new Error("Missing diamond address. Set DIAMOND_ADDRESS or pass a 0x... argument after --")
	if (!/^0x[a-fA-F0-9]{40}$/.test(diamondAddress)) throw new Error(`Invalid diamond address: ${diamondAddress}`)

	const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
	const rawFacetAddresses: string[] = await loupe.facetAddresses()
	const facetAddresses = [...new Map(rawFacetAddresses.map(address => [address.toLowerCase(), address])).values()]

	console.log(`Diamond: ${diamondAddress}`)
	console.log(`Found ${facetAddresses.length} unique facet(s). Starting verification...\n`)

	let verified = 0
	let alreadyVerified = 0
	const failures: Array<{ address: string; error: string }> = []

	for (let index = 0; index < facetAddresses.length; index++) {
		const facetAddress = facetAddresses[index]
		process.stdout.write(`[${index + 1}/${facetAddresses.length}] ${facetAddress} ... `)

		try {
			await verifyContract(
				{
					address: facetAddress,
					constructorArgs: [],
					force: true,
				},
				hre,
			)
			verified++
			console.log("OK")
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error)
			if (isAlreadyVerifiedError(message)) {
				alreadyVerified++
				console.log("SKIP (already verified)")
				continue
			}

			failures.push({ address: facetAddress, error: message.slice(0, 240) })
			console.log("FAIL")
		}
	}

	console.log("\n---")
	console.log(`Verified: ${verified}`)
	console.log(`Already verified: ${alreadyVerified}`)
	console.log(`Failed: ${failures.length}`)

	if (failures.length > 0) {
		console.log("\nFailed addresses:")
		for (const failure of failures) console.log(`- ${failure.address}: ${failure.error}`)
		process.exitCode = 1
	}
}

main().catch(error => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(message)
	process.exitCode = 1
})
