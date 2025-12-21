import { BigNumberish } from "ethers"

import { RunContext } from "../models/RunContext"
import { Hedger } from "../models/Hedger"

export async function migratePartyBToMaster(
	context: RunContext,
	hedger: Hedger,
	quoteIds: BigNumberish[],
) {
	await context.controlFacet.connect(context.signers.admin).setMasterAccountEnabled(true)
	await context.masterAccountMigrationFacet.beginMasterAccountMigration(await hedger.getAddress(), true)
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

	await context.masterAccountMigrationFacet.migrateMasterAccountQuotes(await hedger.getAddress(), partyAs)
	await context.masterAccountMigrationFacet.finalizeMasterAccountMigration(await hedger.getAddress())
}
