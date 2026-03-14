import { ethers } from "../../../test/helpers/hardhat-connection.js"

/**
 * Verifies the RPC connection is healthy before running any script.
 * Checks connectivity, chain ID, and latest block freshness.
 */
export async function verifyRpc(expectedChainId?: number): Promise<void> {
	console.log("Verifying RPC connection...")

	let network
	try {
		network = await ethers.provider.getNetwork()
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		throw new Error(`RPC connection failed. Check your RPC endpoint and network connectivity.\n  ${msg}`)
	}

	const chainId = Number(network.chainId)
	if (expectedChainId && chainId !== expectedChainId) {
		throw new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${chainId}`)
	}

	let block
	try {
		block = await ethers.provider.getBlock("latest")
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		throw new Error(`RPC connected but failed to fetch latest block.\n  ${msg}`)
	}

	if (!block) {
		throw new Error("RPC returned null for latest block")
	}

	const blockAge = Math.floor(Date.now() / 1000) - block.timestamp
	const maxAge = 120 // 2 minutes
	if (blockAge > maxAge) {
		console.warn(`  WARNING: Latest block is ${blockAge}s old (block ${block.number}). RPC may be stale.`)
	}

	console.log(`  Chain ID: ${chainId}`)
	console.log(`  Block:    ${block.number} (${blockAge}s ago)`)
	console.log(`  RPC OK`)
	console.log()
}
