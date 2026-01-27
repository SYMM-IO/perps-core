import { BigNumberish } from "ethers"

import { RunContext } from "../models/RunContext.js"
import { Hedger } from "../models/Hedger.js"

export async function migratePartyBToMaster(
	context: RunContext,
	hedger: Hedger,
	quoteIds: BigNumberish[],
) {
	const partyB = await hedger.getAddress()

	// Enable master account feature globally
	await context.controlFacet.connect(context.signers.admin).setMasterAccountEnabled(true)

	// Collect unique partyAs from quotes
	const partyAs: string[] = []
	const seen: Record<string, boolean> = {}
	for (const id of quoteIds) {
		const quote = await context.viewFacetQuote.getQuote(id)
		const partyA = quote.partyA
		if (!seen[partyA]) {
			seen[partyA] = true
			partyAs.push(partyA)
		}
	}

	// Step 1: Begin migration (pause partyB)
	await context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)

	// Step 2: Migrate allocated balances to master bucket
	// Note: Using migrateAllocatedBalances instead of migrateMasterAccountLockedValues
	// because in v8.5 mode, locked/pending values are already in master bucket
	await context.migrationFacet.connect(context.signers.admin).migrateAllocatedBalances(partyB, partyAs)

	// Step 3: Finalize migration (enable master mode and unpause)
	await context.migrationFacet.connect(context.signers.admin).finalizeMigration(partyB, true)
}
