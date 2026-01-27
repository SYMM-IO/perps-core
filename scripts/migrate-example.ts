/**
 * Example migration script for SYMMIO v0.8.4 -> v0.8.5 upgrade
 *
 * Usage:
 *   npx ts-node scripts/migrate-example.ts
 *
 * Environment variables:
 *   RPC_URL          - JSON-RPC endpoint
 *   PRIVATE_KEY      - Migration executor private key (must have MIGRATION_ROLE)
 *   DIAMOND_ADDRESS  - SYMMIO diamond contract address
 */

import { ethers } from "ethers"
import { MigrationFacet__factory } from "../src/types/index.js"
import { migrate, MigrationInput, MigrationConfig } from "./migrate.js"

// =============================================================================
// Configuration
// =============================================================================

const RPC_URL = process.env.RPC_URL!
const PRIVATE_KEY = process.env.PRIVATE_KEY!
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS!

const MIGRATION_CONFIG: MigrationConfig = {
	chunkSize: 50,
	maxRetries: 3,
	retryDelayMs: 2000,
	confirmations: 1,
	progressFile: "./migration-progress.json",
	strict: false,
	dryRun: process.env.DRY_RUN === "true",
}

// =============================================================================
// Data Collection Functions
// =============================================================================

/**
 * Collect all open quote IDs from your indexer or events
 * These are quotes with status: OPENED, CLOSE_PENDING, CANCEL_CLOSE_PENDING
 */
async function collectQuoteIds(): Promise<bigint[]> {
	// TODO: Replace with your indexer/subgraph query
	// Example:
	// const quotes = await indexer.getQuotes({
	//   status: ['OPENED', 'CLOSE_PENDING', 'CANCEL_CLOSE_PENDING']
	// })
	// return quotes.map(q => BigInt(q.id))

	console.log("Collecting quote IDs from indexer...")

	// Placeholder - replace with actual data
	return []
}

/**
 * Collect all partyB addresses and their associated partyAs
 */
async function collectPartyBTasks(): Promise<{ partyB: string; partyAs: string[] }[]> {
	// TODO: Replace with your indexer/subgraph query
	// Example:
	// const partyBs = await indexer.getPartyBs()
	// return Promise.all(partyBs.map(async (partyB) => {
	//   const quotes = await indexer.getQuotes({ partyB, status: ['OPENED', ...] })
	//   const partyAs = [...new Set(quotes.map(q => q.partyA))]
	//   return { partyB, partyAs }
	// }))

	console.log("Collecting partyB tasks from indexer...")

	// Placeholder - replace with actual data
	return []
}

// =============================================================================
// Main
// =============================================================================

async function main() {
	// Validate environment
	if (!RPC_URL || !PRIVATE_KEY || !DIAMOND_ADDRESS) {
		console.error("Missing required environment variables:")
		console.error("  RPC_URL, PRIVATE_KEY, DIAMOND_ADDRESS")
		process.exit(1)
	}

	// Setup provider and signer
	const provider = new ethers.JsonRpcProvider(RPC_URL)
	const signer = new ethers.Wallet(PRIVATE_KEY, provider)

	console.log(`Executor: ${signer.address}`)
	console.log(`Diamond:  ${DIAMOND_ADDRESS}`)
	console.log(`Network:  ${(await provider.getNetwork()).chainId}`)
	console.log("")

	// Connect to MigrationFacet
	const migrationFacet = MigrationFacet__factory.connect(DIAMOND_ADDRESS, signer)

	// Collect migration data
	const quoteIds = await collectQuoteIds()
	const partyBTasks = await collectPartyBTasks()

	if (quoteIds.length === 0 && partyBTasks.length === 0) {
		console.log("No data to migrate. Exiting.")
		return
	}

	const input: MigrationInput = {
		quoteIds,
		partyBTasks,
	}

	// Confirm before proceeding
	console.log("\nMigration will process:")
	console.log(`  - ${quoteIds.length} quotes`)
	console.log(`  - ${partyBTasks.length} partyBs`)
	console.log("")

	if (!MIGRATION_CONFIG.dryRun) {
		console.log("Press Ctrl+C to cancel, or wait 5 seconds to continue...")
		await new Promise(resolve => setTimeout(resolve, 5000))
	}

	// Execute migration
	const report = await migrate(migrationFacet, input, MIGRATION_CONFIG)

	// Exit with appropriate code
	if (report.status === "failed") {
		process.exit(1)
	} else if (report.status === "partial_failure") {
		process.exit(2)
	}
}

main().catch(error => {
	console.error("Migration failed:", error)
	process.exit(1)
})
