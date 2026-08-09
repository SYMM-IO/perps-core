import { ethers } from "../../test/helpers/hardhat-connection.js"

// Required: DIAMOND_ADDRESS, QUOTE_ID, EXPECTED_CHAIN_ID.

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

function requiredAddress(name: string): string {
	const value = process.env[name]
	if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be an explicit non-zero address`)
	return ethers.getAddress(value)
}

async function main(): Promise<void> {
	const diamond = requiredAddress("DIAMOND_ADDRESS")
	const quoteIdRaw = process.env.QUOTE_ID
	if (!quoteIdRaw || !/^\d+$/.test(quoteIdRaw)) throw new Error("QUOTE_ID must be an explicit non-negative integer")
	const expectedChainIdRaw = process.env.EXPECTED_CHAIN_ID
	if (!expectedChainIdRaw || !/^\d+$/.test(expectedChainIdRaw) || BigInt(expectedChainIdRaw) <= 0n) {
		throw new Error("EXPECTED_CHAIN_ID must be an explicit positive integer")
	}
	const network = await ethers.provider.getNetwork()
	if (network.chainId !== BigInt(expectedChainIdRaw))
		throw new Error(`Chain mismatch: connected to ${network.chainId}, expected ${expectedChainIdRaw}`)
	if ((await ethers.provider.getCode(diamond)) === "0x") throw new Error(`No diamond code at ${diamond}`)

	const quoteId = BigInt(quoteIdRaw)
	const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", diamond)
	const quote = await viewFacetQuote.getQuote(quoteId)
	const migrationFacet = await ethers.getContractAt("contracts/core/facets/Migration/MigrationFacet.sol:MigrationFacet", diamond)
	const isMigrated = await migrationFacet.isQuoteMigrated(quoteId)
	console.log(`Diamond:  ${diamond}`)
	console.log(`Chain:    ${network.chainId}`)
	console.log(`Quote ${quoteId}:`)
	console.log(`  status:   ${quote.quoteStatus} (${STATUS_NAMES[Number(quote.quoteStatus)] ?? "UNKNOWN"})`)
	console.log(`  partyA:   ${quote.partyA}`)
	console.log(`  partyB:   ${quote.partyB}`)
	console.log(`  symbolId: ${quote.symbolId}`)
	console.log(`  migrated: ${isMigrated}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
