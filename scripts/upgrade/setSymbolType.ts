/**
 * Set symbolType for all symbols on the Symmio diamond.
 *
 * Reads symbol IDs and type from the input file produced by fetchSymbolList.ts,
 * then calls setSymbolTypes() on the target diamond. Requires SYMBOL_MANAGER_ROLE
 * (granted to migrationRunner by the Safe batch).
 *
 * Run:
 *   npx hardhat run scripts/upgrade/setSymbolType.ts --network <network>
 *
 *   # Dry run (log without submitting)
 *   DRY_RUN=true npx hardhat run scripts/upgrade/setSymbolType.ts --network <network>
 *
 * Config: scripts/upgrade/config/upgrade.json (diamondAddress)
 * Input:  scripts/upgrade/output/{count}-symbol-types-input-{network}.json (from fetchSymbolList.ts)
 * Output: scripts/upgrade/output/set-symbol-types-report-{network}.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import type { SymbolTypesInput } from "./fetchSymbolList.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"

const OUTPUT_DIR = "./scripts/upgrade/output"

function resolveSymbolTypesInputFile(networkName: string): string {
	const suffix = `-symbol-types-input-${networkName}.json`
	if (!fs.existsSync(OUTPUT_DIR)) {
		throw new Error(`Output dir not found: ${OUTPUT_DIR}. Run fetchSymbolList.ts first.`)
	}
	const matches = fs
		.readdirSync(OUTPUT_DIR)
		.filter(f => f.endsWith(suffix) && /^\d+-symbol-types-input-/.test(f))
		.map(f => ({ name: f, mtime: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
	if (matches.length === 0) {
		throw new Error(`No input file matching *${suffix} in ${OUTPUT_DIR}. Run fetchSymbolList.ts first.`)
	}
	if (matches.length > 1) {
		log.warn(`Multiple input files for ${networkName} — picking newest: ${matches[0].name}`)
		for (const m of matches.slice(1)) log.warn(`  skipped: ${m.name}`)
	}
	return path.join(OUTPUT_DIR, matches[0].name)
}

async function main() {
	const networkName = connection.networkName
	const shared = loadUpgradeConfigShared(networkName)

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 100)
	const DRY_RUN = process.env.DRY_RUN === "true"
	const inputFile = process.env.SYMBOL_TYPES_INPUT_FILE ?? resolveSymbolTypesInputFile(networkName)

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or upgrade.json)")
	}
	if (!fs.existsSync(inputFile)) {
		throw new Error(`Input file not found: ${inputFile}\nRun fetchSymbolList.ts first.`)
	}

	const input: SymbolTypesInput = JSON.parse(fs.readFileSync(inputFile, "utf-8"))
	const { symbols, symbolType } = input

	log.info(`Diamond:     ${DIAMOND_ADDRESS}`)
	log.info(`Symbol type: ${symbolType}`)
	log.info(`Symbols:     ${symbols.length}`)
	log.info(`Chunk size:  ${CHUNK_SIZE}`)
	log.info(`Dry run:     ${DRY_RUN}`)
	log.info(`Input:       ${inputFile}`)
	log.info("")

	for (const s of symbols) log.info(`  [${s.symbolId}] ${s.name}`)
	log.info("")

	if (DRY_RUN) {
		log.warn("DRY RUN — no transactions submitted")
		writeReport(DIAMOND_ADDRESS, input, 0, true, networkName)
		return
	}

	await verifyRpc()

	const migratorAddress = shared.migrationRunner
	const signer = await resolveConfiguredSigner({
		role: "migrationRunner",
		expectedAddress: migratorAddress,
		envPrefix: "MIGRATION_RUNNER",
		allowDefault: !migratorAddress,
	})
	log.info(`Signer: ${await signer.getAddress()}`)

	const diamond = await ethers.getContractAt(
		["function setSymbolTypes(uint256[] calldata symbolIds, uint256[] calldata symbolTypes)"],
		DIAMOND_ADDRESS,
		signer,
	)

	const chunks: { index: number; symbolIds: bigint[]; symbolTypes: bigint[] }[] = []
	for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
		const chunk = symbols.slice(i, i + CHUNK_SIZE)
		chunks.push({
			index: Math.floor(i / CHUNK_SIZE) + 1,
			symbolIds: chunk.map(s => BigInt(s.symbolId)),
			symbolTypes: chunk.map(() => BigInt(symbolType)),
		})
	}

	log.info(`Sending ${chunks.length} chunk transactions sequentially...`)
	for (const chunk of chunks) {
		log.info(`Submitting chunk ${chunk.index} (${chunk.symbolIds.length} symbols)...`)
		const tx = await diamond.setSymbolTypes(chunk.symbolIds, chunk.symbolTypes)
		const receipt = await tx.wait()
		log.ok(`  chunk ${chunk.index}: tx ${receipt.hash} (gas: ${receipt.gasUsed})`)
	}
	const totalSet = symbols.length

	log.ok(`\nSet symbolType=${symbolType} for ${totalSet} symbols on ${DIAMOND_ADDRESS}`)
	writeReport(DIAMOND_ADDRESS, input, totalSet, false, networkName)
}

function writeReport(diamondAddress: string, input: SymbolTypesInput, totalSet: number, dryRun: boolean, networkName: string) {
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const reportFile = path.join(OUTPUT_DIR, `set-symbol-types-report-${networkName}.json`)
	fs.writeFileSync(
		reportFile,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				diamondAddress,
				symbolType: input.symbolType,
				dryRun,
				totalSet,
				symbols: input.symbols.map(s => ({ symbolId: s.symbolId, name: s.name })),
			},
			null,
			2,
		),
	)
	log.ok(`Report: ${reportFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
