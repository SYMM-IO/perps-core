/**
 * Fetch symbols from the subgraph and write the input file for setSymbolType.ts.
 *
 * In the EOA/operator upgrade path, run after pause and use the generated file
 * when setSymbolType.ts backfills symbolType.
 *
 * Run:
 *   ./node_modules/.bin/hardhat run scripts/upgrade/fetchSymbolList.ts --network <network>
 *
 *   # Dry run (fetch and print without writing output)
 *   DRY_RUN=true ./node_modules/.bin/hardhat run scripts/upgrade/fetchSymbolList.ts --network <network>
 *
 * Config: scripts/upgrade/config/upgrade.json
 *   A chain-specific subgraphEndpoint and newV085Parameters.symbolType
 *
 * Output: scripts/upgrade/output/{count}-symbol-types-input-{network}.json
 */
import fs from "fs"
import path from "path"

import connection from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { fetchSymbols } from "./utils/subgraphHelpers.js"

const OUTPUT_DIR = "./scripts/upgrade/output"

export type SymbolTypesInput = {
	generatedAt: string
	subgraphEndpoint: string
	symbolType: number
	symbols: { symbolId: string; name: string }[]
}

function requireSubgraphEndpoint(endpoint: string | undefined, networkName: string | undefined): string {
	if (!endpoint) {
		throw new Error(
			`No subgraph endpoint configured for network ${networkName ?? "unknown"}. ` +
				"Set SUBGRAPH_ENDPOINT or configure subgraphEndpoint in the chain-specific upgrade file.",
		)
	}

	let url: URL
	try {
		url = new URL(endpoint)
	} catch {
		throw new Error(`Invalid subgraph endpoint URL: ${endpoint}`)
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Subgraph endpoint must use http or https: ${endpoint}`)
	}
	return endpoint
}

async function main() {
	const networkName = connection.networkName
	const networkSuffix = baseNetworkName(networkName)
	const shared = loadUpgradeConfigShared(networkSuffix)

	const SUBGRAPH_ENDPOINT = requireSubgraphEndpoint(process.env.SUBGRAPH_ENDPOINT ?? shared.subgraphEndpoint, networkSuffix)
	const SYMBOL_TYPE = process.env.SYMBOL_TYPE !== undefined ? Number(process.env.SYMBOL_TYPE) : shared.newV085Parameters?.symbolType
	const DRY_RUN = process.env.DRY_RUN === "true"

	if (SYMBOL_TYPE === undefined) {
		throw new Error("symbolType is required — set newV085Parameters.symbolType in upgrade.json or SYMBOL_TYPE env var")
	}

	await verifyRpc()

	log.info(`Network:     ${networkName}`)
	log.info(`Subgraph:    ${SUBGRAPH_ENDPOINT}`)
	log.info(`Symbol type: ${SYMBOL_TYPE}`)
	log.info(`Dry run:     ${DRY_RUN}`)
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

	const outputFile = process.env.SYMBOL_TYPES_INPUT_FILE ?? path.join(OUTPUT_DIR, `${symbols.length}-symbol-types-input-${networkName}.json`)

	if (DRY_RUN) {
		log.warn(`DRY RUN — no output written. Planned output: ${outputFile}`)
		return
	}

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	fs.writeFileSync(outputFile, JSON.stringify(input, null, 2))
	log.ok(`\nOutput: ${outputFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
