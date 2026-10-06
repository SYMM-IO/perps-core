import { ethers } from "../test/helpers/hardhat-connection.js"

const DIAMOND_ADDRESS = "0x8F06459f184553e5d04F07F868720BDaCAB39395"
const TARGET_SYMBOL_TYPE = 1n
const BATCH_SIZE = 100

const signers = await ethers.getSigners()
const signer = signers[1] // TEAM_MIGRATOR (index 1 in hardhat accounts array)
if (!signer) throw new Error("TEAM_MIGRATOR signer not available — ensure USE_KEYSTORE=true or TEAM_MIGRATOR env var is set")
console.log("Signer:", signer.address)

const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacetSymbol/ViewFacetSymbol.sol:ViewFacetSymbol", DIAMOND_ADDRESS, signer)
const symbolControlFacet = await ethers.getContractAt(
	"contracts/core/facets/SymbolControl/SymbolControlFacet.sol:SymbolControlFacet",
	DIAMOND_ADDRESS,
	signer,
)

// Fetch all symbols and filter those not already type 1
let symbolsToUpdate: { id: bigint; name: string; currentType: bigint }[] = []
let offset = 0

while (true) {
	const symbols = await viewFacet.getSymbolsWithType(offset, BATCH_SIZE)
	if (symbols.length === 0) break

	for (const s of symbols) {
		if (s.symbolType !== TARGET_SYMBOL_TYPE) {
			symbolsToUpdate.push({ id: s.symbolId, name: s.name, currentType: s.symbolType })
		}
	}

	console.log(`Fetched ${offset + symbols.length} symbols so far...`)
	if (symbols.length < BATCH_SIZE) break
	offset += BATCH_SIZE
}

console.log(`\nTotal symbols: ${offset + (symbolsToUpdate.length > 0 ? symbolsToUpdate.length : 0)}`)
console.log(`Symbols needing update (type != 1): ${symbolsToUpdate.length}`)

if (symbolsToUpdate.length === 0) {
	console.log("All symbols already have type 1. Nothing to do.")
	process.exit(0)
}

// Print symbols that will be updated
console.log("\nSymbols to update:")
for (const s of symbolsToUpdate) {
	console.log(`  #${s.id} ${s.name} (current type: ${s.currentType})`)
}

// Send setSymbolTypes in batches
for (let i = 0; i < symbolsToUpdate.length; i += BATCH_SIZE) {
	const batch = symbolsToUpdate.slice(i, i + BATCH_SIZE)
	const ids = batch.map(s => s.id)
	const types = batch.map(() => TARGET_SYMBOL_TYPE)

	console.log(`\nSetting type=1 for symbols ${ids[0]}..${ids[ids.length - 1]} (${ids.length} symbols)`)

	const tx = await symbolControlFacet.setSymbolTypes(ids, types)
	console.log("tx:", tx.hash)
	await tx.wait()
	console.log("Confirmed")
}

console.log("\nDone! All symbols set to type 1.")
