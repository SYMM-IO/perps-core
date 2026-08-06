/**
 * Send one explicitly authorized zero-value self-transfer and report latency.
 *
 * Usage:
 *   EXECUTE_TEST_TX=true EXPECTED_CHAIN_ID=<chain-id> \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/testDelay.ts --network <network>
 */
import { ethers } from "../../test/helpers/hardhat-connection.js"
import { writeTxOverrides } from "./utils/txOverrides.js"

function requiredExpectedChainId(): bigint {
	const value = process.env.EXPECTED_CHAIN_ID
	if (!value || !/^[1-9]\d*$/.test(value)) {
		throw new Error("EXPECTED_CHAIN_ID must be an explicit positive integer")
	}
	return BigInt(value)
}

async function main(): Promise<void> {
	if (process.env.EXECUTE_TEST_TX !== "true") {
		throw new Error("Refusing to send a test transaction. Set EXECUTE_TEST_TX=true explicitly.")
	}

	const expectedChainId = requiredExpectedChainId()
	const network = await ethers.provider.getNetwork()
	if (network.chainId !== expectedChainId) {
		throw new Error(`Chain mismatch: connected to ${network.chainId}, expected ${expectedChainId}`)
	}

	const [signer] = await ethers.getSigners()
	if (!signer) throw new Error("No signer is configured for this network")
	const signerAddress = await signer.getAddress()

	console.log("Transaction latency probe")
	console.log(`  Chain:  ${network.chainId}`)
	console.log(`  Signer: ${signerAddress}`)
	console.log("  Type:   zero-value self-transfer")

	const t0 = performance.now()
	const tx = await signer.sendTransaction({ to: signerAddress, value: 0n, ...writeTxOverrides() })
	const tSent = performance.now()
	console.log(`  Hash:   ${tx.hash}`)
	console.log(`  Submit: ${(tSent - t0).toFixed(0)} ms`)

	const receipt = await tx.wait()
	const tMined = performance.now()
	if (!receipt || receipt.status !== 1) throw new Error(`Test transaction failed: ${tx.hash}`)

	console.log(`  Block:  ${receipt.blockNumber}`)
	console.log(`  Gas:    ${receipt.gasUsed}`)
	console.log(`  Mined:  ${(tMined - tSent).toFixed(0)} ms`)
	console.log(`  Total:  ${(tMined - t0).toFixed(0)} ms`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
