import { ethers } from "../../test/helpers/hardhat-connection.js"

const STATUS_NAMES: Record<number, string> = {
	0: "PENDING",
	1: "LOCKED",
	2: "CANCEL_PENDING",
	3: "CANCELED",
	4: "OPENED",
	5: "CLOSE_PENDING",
	6: "CANCEL_CLOSE_PENDING",
	7: "CLOSED",
	8: "LIQUIDATED",
	9: "EXPIRED",
	10: "LIQUIDATED_PENDING",
}

const diamond = "0x2Ecc7da3Cc98d341F987C85c3D9FC198570838B5"

async function main() {
	const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", diamond)
	const quote = await viewFacetQuote.getQuote(6438)
	console.log(`Quote 6438:`)
	console.log(`  status: ${quote.quoteStatus} (${STATUS_NAMES[Number(quote.quoteStatus)] ?? "UNKNOWN"})`)
	console.log(`  partyA: ${quote.partyA}`)
	console.log(`  partyB: ${quote.partyB}`)
	console.log(`  symbolId: ${quote.symbolId}`)

	const migrationFacet = await ethers.getContractAt("contracts/core/facets/Migration/MigrationFacet.sol:MigrationFacet", diamond)
	const isMigrated = await migrationFacet.isQuoteMigrated(6438)
	console.log(`  migrated: ${isMigrated}`)
}

main().catch(console.error)
