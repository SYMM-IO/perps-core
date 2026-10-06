import { ethers } from "../test/helpers/hardhat-connection.js"

const DIAMOND_ADDRESS = "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB"
const TARGET_SYMBOL_TYPE = 2n
const BATCH_SIZE = 100 // symbols per tx to avoid gas limits

const [signer] = await ethers.getSigners()
console.log("Signer:", signer.address)

const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacetSymbol/ViewFacetSymbol.sol:ViewFacetSymbol", DIAMOND_ADDRESS, signer)
const symbolControlFacet = await ethers.getContractAt(
	"contracts/core/facets/SymbolControl/SymbolControlFacet.sol:SymbolControlFacet",
	DIAMOND_ADDRESS,
	signer,
)

// Fetch all symbols to find total count and filter those not already type 2
let allSymbolIds: bigint[] = []
let offset = 0

while (true) {
	const symbols = await viewFacet.getSymbolsWithType(offset, BATCH_SIZE)
	if (symbols.length === 0) break

	for (const s of symbols) {
		if (s.symbolType !== TARGET_SYMBOL_TYPE) {
			allSymbolIds.push(s.symbolId)
		}
	}

	console.log(`Fetched ${offset + symbols.length} symbols so far...`)
	if (symbols.length < BATCH_SIZE) break
	offset += BATCH_SIZE
}

console.log(`\nTotal symbols needing update: ${allSymbolIds.length}`)

if (allSymbolIds.length === 0) {
	console.log("All symbols already have type 2. Nothing to do.")
	process.exit(0)
}

// Send setSymbolTypes in batches
for (let i = 0; i < allSymbolIds.length; i += BATCH_SIZE) {
	const batch = allSymbolIds.slice(i, i + BATCH_SIZE)
	const types = batch.map(() => TARGET_SYMBOL_TYPE)

	console.log(`\nSetting type for symbols ${batch[0]}..${batch[batch.length - 1]} (${batch.length} symbols)`)

	const tx = await symbolControlFacet.setSymbolTypes(batch, types)
	console.log("tx:", tx.hash)
	await tx.wait()
	console.log("Confirmed")
}

console.log("\nDone! All symbols set to type 2.")
