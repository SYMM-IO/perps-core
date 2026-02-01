import { BigNumberish, ZeroAddress } from "ethers"

import { RunContext } from "../models/RunContext.js"
import { Hedger } from "../models/Hedger.js"

/**
 * Enable cross partyB mode for a partyB in tests.
 *
 * In v8.5, locked/pending values are automatically maintained in the cross bucket.
 * This function enables cross mode directly without going through the migration process,
 * which avoids double-counting locked values that would occur if we used migrateCrossLockedValues.
 *
 * For allocated balances, partyB must manually allocate to address(0) after cross mode is enabled.
 * This is intentional - in production, partyBs on v8.5 should allocate directly to address(0).
 */
export async function migratePartyBToCross(
	context: RunContext,
	hedger: Hedger,
	quoteIds: BigNumberish[],
) {
	const partyB = await hedger.getAddress()

	// Enable cross partyB feature globally
	await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(true)

	// Collect unique partyAs and sum their allocated balances
	const partyAs: string[] = []
	const seen: Record<string, boolean> = {}
	let totalAllocated = 0n
	for (const id of quoteIds) {
		const quote = await context.viewFacetQuote.getQuote(id)
		const partyA = quote.partyA
		if (!seen[partyA]) {
			seen[partyA] = true
			partyAs.push(partyA)
			totalAllocated += await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA)
		}
	}

	// Enable cross mode directly (no migration process)
	// In v8.5, locked/pending values are already in cross bucket from position operations
	await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)

	// Migrate allocated balances to cross bucket
	// PartyB needs to allocate to address(0) for solvency checks in cross mode
	if (totalAllocated > 0n) {
		// Deposit and allocate to cross bucket
		await hedger.setBalances(totalAllocated, totalAllocated, 0n)
		await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(totalAllocated, ZeroAddress)
	}
}
