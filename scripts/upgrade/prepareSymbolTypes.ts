/**
 * Fetch symbols from the subgraph and prepare the input file for setSymbolTypes.ts.
 *
 * Run before setSymbolTypes.ts — can be done outside the pause window.
 *
 * Run:
 *   npx hardhat run scripts/upgrade/prepareSymbolTypes.ts --network <network>
 *
 * Config: scripts/upgrade/config/upgrade.json
 *   subgraphEndpoint, newV085Parameters.symbolType
 *
 * Output: scripts/upgrade/output/symbol-types-input.json
 */
import fs from "fs"
import path from "path"

import { log } from "./utils/log.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { fetchSymbols } from "./utils/subgraphHelpers.js"

const DEFAULT_SUBGRAPH_ENDPOINT = "https://api.goldsky.com/api/public/project_cm1hfr4527p0f01u85mz499u8/subgraphs/arbitrum_analytics/stage/gn"
const OUTPUT_DIR = "./scripts/upgrade/output"

export type SymbolTypesInput = {
	generatedAt: string
	subgraphEndpoint: string
	symbolType: number
	symbols: { symbolId: string; name: string }[]
}

async function main() {
	const shared = loadUpgradeConfigShared()

	const SUBGRAPH_ENDPOINT = process.env.SUBGRAPH_ENDPOINT ?? shared.subgraphEndpoint ?? DEFAULT_SUBGRAPH_ENDPOINT
	const SYMBOL_TYPE = process.env.SYMBOL_TYPE !== undefined ? Number(process.env.SYMBOL_TYPE) : shared.newV085Parameters?.symbolType
	const outputFile = process.env.SYMBOL_TYPES_INPUT_FILE ?? path.join(OUTPUT_DIR, "symbol-types-input.json")

	if (SYMBOL_TYPE === undefined) {
		throw new Error("symbolType is required — set newV085Parameters.symbolType in upgrade.json or SYMBOL_TYPE env var")
	}

	log.info(`Subgraph:    ${SUBGRAPH_ENDPOINT}`)
	log.info(`Symbol type: ${SYMBOL_TYPE}`)
	log.info("")

	log.info("Fetching symbols from subgraph...")
	const symbols = await fetchSymbols(SUBGRAPH_ENDPOINT)

	if (symbols.length === 0) {
		throw new Error("No symbols found in subgraph")
	}

	log.ok(`Fetched ${symbols.length} symbols`)
	for (const s of symbols) log.info(`  [${s.symbolId}] ${s.name}`)

	const input: SymbolTypesInput = {
		generatedAt: new Date().toISOString(),
		subgraphEndpoint: SUBGRAPH_ENDPOINT,
		symbolType: SYMBOL_TYPE,
		symbols: symbols.map(s => ({ symbolId: s.symbolId, name: s.name })),
	}

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	fs.writeFileSync(outputFile, JSON.stringify(input, null, 2))
	log.ok(`\nOutput: ${outputFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
