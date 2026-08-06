/**
 * Set symbolType for all symbols on the Symmio diamond.
 *
 * Reads symbol IDs and type from the input file produced by fetchSymbolList.ts,
 * then calls setSymbolTypes() on the target diamond. Requires SYMBOL_MANAGER_ROLE
 * (granted to migrationRunner by the Safe batch).
 *
 * Plan (default):
 *   ./node_modules/.bin/hardhat run scripts/upgrade/setSymbolType.ts --network <network>
 *
 * Execute only after reviewing the plan:
 *   EXECUTE=true CONFIRM_CHAIN_ID=<chainId> ./node_modules/.bin/hardhat run scripts/upgrade/setSymbolType.ts --network <network>
 *
 * Config: scripts/upgrade/config/upgrade.json (diamondAddress)
 * Input:  scripts/upgrade/output/{count}-symbol-types-input-{network}.json (from fetchSymbolList.ts)
 * Output: scripts/upgrade/output/set-symbol-types-report-{network}.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import type { SymbolTypesInput } from "./fetchSymbolList.js"
import { exactBooleanEnv, requireExecutionConfirmation } from "./utils/executionGuard.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { setSymbolTypesTxOverrides } from "./utils/txOverrides.js"

const OUTPUT_DIR = "./scripts/upgrade/output"
const SYMBOL_MANAGER_ROLE = ethers.id("SYMBOL_MANAGER_ROLE")

type RoleCheck = {
	address: string
	roleHash: string
	hasRole: boolean
}

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

async function hasSymbolManagerRole(diamondAddress: string, account: string): Promise<boolean> {
	const viewFacet = await ethers.getContractAt(["function hasRole(address user, bytes32 role) view returns (bool)"], diamondAddress)
	return viewFacet.hasRole(account, SYMBOL_MANAGER_ROLE)
}

async function checkSymbolManagerRole(diamondAddress: string, account: string, required: boolean): Promise<RoleCheck> {
	const normalized = ethers.getAddress(account)
	const hasRole = await hasSymbolManagerRole(diamondAddress, normalized)
	log.kv("SYMBOL_MANAGER_ROLE", hasRole ? `yes (${log.addr(normalized)})` : `no (${log.addr(normalized)})`)
	if (!hasRole) {
		const message =
			`${normalized} does not have SYMBOL_MANAGER_ROLE on ${diamondAddress}. ` + "Execute the Safe role-grant batch before setting symbol types."
		if (required) {
			throw new Error(`${message} Set SKIP_SYMBOL_MANAGER_ROLE_CHECK=true only if you are intentionally bypassing this preflight.`)
		}
		log.warn(`${message} Dry run will continue because no transactions are submitted.`)
	}
	return { address: normalized, roleHash: SYMBOL_MANAGER_ROLE, hasRole }
}

function roleCheckSummary(roleCheck: RoleCheck | undefined, skipped: boolean): string | undefined {
	if (roleCheck) return `${roleCheck.hasRole ? "yes" : "no"} (${log.addr(roleCheck.address)})`
	if (skipped) return "skipped"
	return undefined
}

function logRunSummary(
	title: string,
	diamondAddress: string,
	roleCheck: RoleCheck | undefined,
	roleCheckSkipped: boolean,
	totalSet: number,
	dryRun: boolean,
	reportFile: string,
): void {
	const summary: Array<[string, string]> = [["Diamond", diamondAddress]]
	const roleSummary = roleCheckSummary(roleCheck, roleCheckSkipped)
	if (roleSummary) summary.push(["SYMBOL_MANAGER_ROLE", roleSummary])
	summary.push(["Symbols", String(totalSet)], ["Dry run", String(dryRun)], ["Report", reportFile])
	log.success(title, summary)
}

async function main() {
	const networkName = connection.networkName
	const shared = loadUpgradeConfigShared(networkName)

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 100)
	const SKIP_SYMBOL_MANAGER_ROLE_CHECK = exactBooleanEnv("SKIP_SYMBOL_MANAGER_ROLE_CHECK")
	const inputFile = process.env.SYMBOL_TYPES_INPUT_FILE ?? resolveSymbolTypesInputFile(networkName)

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or upgrade.json)")
	}
	if (!fs.existsSync(inputFile)) {
		throw new Error(`Input file not found: ${inputFile}\nRun fetchSymbolList.ts first.`)
	}
	if (!Number.isSafeInteger(CHUNK_SIZE) || CHUNK_SIZE <= 0) throw new Error(`CHUNK_SIZE must be a positive safe integer; received ${CHUNK_SIZE}`)

	const input: SymbolTypesInput = JSON.parse(fs.readFileSync(inputFile, "utf-8"))
	const { symbols, symbolType } = input

	await verifyRpc()
	const chainId = (await ethers.provider.getNetwork()).chainId
	const EXECUTE = requireExecutionConfirmation(chainId)
	const DRY_RUN = !EXECUTE

	const migratorAddress = process.env.MIGRATION_RUNNER ?? shared.migrationRunner
	let signer: Awaited<ReturnType<typeof resolveConfiguredSigner>> | undefined
	let signerAddress: string
	if (DRY_RUN && migratorAddress && ethers.isAddress(migratorAddress)) {
		signerAddress = ethers.getAddress(migratorAddress)
		log.info(`Signer: ${signerAddress} (configured migrationRunner; dry run uses no signer)`)
	} else {
		signer = await resolveConfiguredSigner({
			role: "migrationRunner",
			expectedAddress: migratorAddress,
			envPrefix: "MIGRATION_RUNNER",
			allowDefault: !migratorAddress,
		})
		signerAddress = await signer.getAddress()
		log.info(`Signer: ${signerAddress}`)
	}

	let roleCheck: RoleCheck | undefined
	if (SKIP_SYMBOL_MANAGER_ROLE_CHECK) {
		log.warn("Skipping SYMBOL_MANAGER_ROLE preflight because SKIP_SYMBOL_MANAGER_ROLE_CHECK=true")
	} else {
		roleCheck = await checkSymbolManagerRole(DIAMOND_ADDRESS, signerAddress, !DRY_RUN)
	}

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
		const reportFile = writeReport(DIAMOND_ADDRESS, input, 0, true, networkName, roleCheck)
		logRunSummary(
			"Set symbolType dry run completed successfully",
			DIAMOND_ADDRESS,
			roleCheck,
			SKIP_SYMBOL_MANAGER_ROLE_CHECK,
			symbols.length,
			true,
			reportFile,
		)
		return
	}

	const diamond = await ethers.getContractAt(
		["function setSymbolTypes(uint256[] calldata symbolIds, uint256[] calldata symbolTypes)"],
		DIAMOND_ADDRESS,
		signer,
	)
	const symbolView = await ethers.getContractAt("contracts/core/facets/ViewFacetSymbol/ViewFacetSymbol.sol:ViewFacetSymbol", DIAMOND_ADDRESS)

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
		await diamond.setSymbolTypes.staticCall(chunk.symbolIds, chunk.symbolTypes, setSymbolTypesTxOverrides())
		const tx = await diamond.setSymbolTypes(chunk.symbolIds, chunk.symbolTypes, setSymbolTypesTxOverrides())
		log.info(`  submitted: ${tx.hash} (nonce: ${tx.nonce})`)
		const receipt = await tx.wait()
		if (!receipt?.status) throw new Error(`Chunk ${chunk.index} transaction failed: ${tx.hash}`)
		const verifiedSymbols = await Promise.all(chunk.symbolIds.map(symbolId => symbolView.getSymbolWithType(symbolId)))
		for (let index = 0; index < verifiedSymbols.length; index++) {
			if (BigInt(verifiedSymbols[index].symbolType) !== chunk.symbolTypes[index]) {
				throw new Error(
					`Chunk ${chunk.index} post-state mismatch for symbol ${chunk.symbolIds[index]}: expected type ${chunk.symbolTypes[index]}, got ${verifiedSymbols[index].symbolType}`,
				)
			}
		}
		log.ok(`  chunk ${chunk.index}: tx ${receipt.hash} (gas: ${receipt.gasUsed})`)
	}
	const totalSet = symbols.length

	log.ok(`\nSet symbolType=${symbolType} for ${totalSet} symbols on ${DIAMOND_ADDRESS}`)
	const reportFile = writeReport(DIAMOND_ADDRESS, input, totalSet, false, networkName, roleCheck)
	logRunSummary("Symbol types updated successfully", DIAMOND_ADDRESS, roleCheck, SKIP_SYMBOL_MANAGER_ROLE_CHECK, totalSet, false, reportFile)
}

function writeReport(
	diamondAddress: string,
	input: SymbolTypesInput,
	totalSet: number,
	dryRun: boolean,
	networkName: string,
	roleCheck?: RoleCheck,
): string {
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
				roleChecks: roleCheck
					? {
							symbolManagerRole: roleCheck,
						}
					: undefined,
				totalSet,
				symbols: input.symbols.map(s => ({ symbolId: s.symbolId, name: s.name })),
			},
			null,
			2,
		),
	)
	log.ok(`Report: ${reportFile}`)
	return reportFile
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
