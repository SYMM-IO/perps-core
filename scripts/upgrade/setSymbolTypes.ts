/**
 * Set symbolType for all symbols on the Symmio diamond.
 *
 * Reads symbol IDs and type from the input file produced by prepareSymbolTypes.ts,
 * then calls setSymbolTypes() on the target diamond. Requires SYMBOL_MANAGER_ROLE
 * (granted to migrationRunner by the Safe batch).
 *
 * Run:
 *   npx hardhat run scripts/upgrade/setSymbolTypes.ts --network <network>
 *
 *   # Dry run (log without submitting)
 *   DRY_RUN=true npx hardhat run scripts/upgrade/setSymbolTypes.ts --network <network>
 *
 * Config: scripts/upgrade/config/upgrade.json (diamondAddress)
 * Input:  scripts/upgrade/output/symbol-types-input.json (from prepareSymbolTypes.ts)
 * Output: scripts/upgrade/output/set-symbol-types-report.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import type { SymbolTypesInput } from "./prepareSymbolTypes.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"

const OUTPUT_DIR = "./scripts/upgrade/output"

async function main() {
	const networkName = connection.networkName
	const shared = loadUpgradeConfigShared(networkName)

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 100)
	const DRY_RUN = process.env.DRY_RUN === "true"
	const inputFile = process.env.SYMBOL_TYPES_INPUT_FILE ?? path.join(OUTPUT_DIR, "symbol-types-input.json")

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or upgrade.json)")
	}
	if (!fs.existsSync(inputFile)) {
		throw new Error(`Input file not found: ${inputFile}\nRun prepareSymbolTypes.ts first.`)
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
		writeReport(DIAMOND_ADDRESS, input, 0, true)
		return
	}

	await verifyRpc()

	const migratorAddress = shared.migrationRunner
	let signer
	if (migratorAddress) {
		const signers = await ethers.getSigners()
		for (const s of signers) {
			if ((await s.getAddress()).toLowerCase() === migratorAddress.toLowerCase()) {
				signer = s
				break
			}
		}
		if (!signer) throw new Error(`No signer found for migrationRunner ${migratorAddress}. Add TEAM_MIGRATOR to the Hardhat keystore.`)
	} else {
		signer = await ethers.provider.getSigner()
	}
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

	log.info(`Sending ${chunks.length} chunk transactions in parallel...`)
	const baseNonce = await signer.getNonce()

	const txPromises = chunks.map((chunk, i) => {
		log.info(`Submitting chunk ${chunk.index} (${chunk.symbolIds.length} symbols, nonce ${baseNonce + i})...`)
		return diamond.setSymbolTypes(chunk.symbolIds, chunk.symbolTypes, { nonce: baseNonce + i })
	})
	const txResponses = await Promise.all(txPromises)

	log.info("Waiting for confirmations...")
	const receipts = await Promise.all(txResponses.map(tx => tx.wait()))
	for (let i = 0; i < receipts.length; i++) {
		log.ok(`  chunk ${chunks[i].index}: tx ${receipts[i].hash} (gas: ${receipts[i].gasUsed})`)
	}
	const totalSet = symbols.length

	log.ok(`\nSet symbolType=${symbolType} for ${totalSet} symbols on ${DIAMOND_ADDRESS}`)
	writeReport(DIAMOND_ADDRESS, input, totalSet, false)
}

function writeReport(diamondAddress: string, input: SymbolTypesInput, totalSet: number, dryRun: boolean) {
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const reportFile = path.join(OUTPUT_DIR, "set-symbol-types-report.json")
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
