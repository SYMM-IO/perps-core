/**
 * Calculates exact quote-level aggregate funding at one globally-paused block and either
 * prints governance calldata (default) or submits the checked repair with MIGRATION_ROLE.
 *
 * GROUPS_FILE=./groups.json SYMMIO=0x... \
 *   npx hardhat run --no-compile scripts/resyncAggregateFunding.ts --network <network>
 *
 * Add EXECUTE=true CONFIRM_CHAIN_ID=<id> to send transactions. The default is read-only.
 */
import fs from "node:fs"
import path from "node:path"

import { MigrationFacet__factory } from "../src/types/factories/core/facets/Migration/MigrationFacet__factory.js"
import { ViewFacet__factory } from "../src/types/factories/core/facets/ViewFacet/ViewFacet__factory.js"
import { ViewFacetAggregate__factory } from "../src/types/factories/core/facets/ViewFacetAggregate/ViewFacetAggregate__factory.js"
import { ViewFacetQuote__factory } from "../src/types/factories/core/facets/ViewFacetQuote/ViewFacetQuote__factory.js"
import type { IMigrationFacet, ViewFacetAggregate, ViewFacetQuote } from "../src/types/index.js"
import { ethers } from "../test/helpers/hardhat-connection.js"
import { accumulateGroupFunding, addFunding, requireInt256, subtractFunding } from "./utils/aggregateFundingResync.js"

interface RawGroup {
	partyA?: unknown
	partyB?: unknown
	symbolId?: unknown
	positionType?: unknown
}

interface FundingGroup {
	partyA: string
	partyB: string
	symbolId: bigint
	positionType: 0 | 1
}

interface PreparedRepair extends FundingGroup {
	expectedPartyAFunding: bigint
	expectedPartyBFunding: bigint
	newFunding: bigint
	oldGlobalFunding: bigint
	quoteCount: bigint
}

const DEFAULT_PAGE_SIZE = 100
const DEFAULT_GROUP_BATCH_SIZE = 20
const MIGRATION_ROLE = ethers.id("MIGRATION_ROLE")

function requiredEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Set ${name}`)
	return value
}

function parsePositiveInteger(name: string, raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === "") return fallback
	if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
	return value
}

function parseUint256(name: string, raw: unknown): bigint {
	if (typeof raw !== "string" && typeof raw !== "number") throw new Error(`${name} must be a decimal string or safe integer`)
	if (typeof raw === "number" && (!Number.isSafeInteger(raw) || raw < 0)) throw new Error(`${name} number must be a non-negative safe integer`)
	const text = String(raw)
	if (!/^\d+$/.test(text)) throw new Error(`${name} must be an unsigned decimal integer`)
	const value = BigInt(text)
	if (value >= 1n << 256n) throw new Error(`${name} is outside uint256`)
	return value
}

function parsePositionType(raw: unknown): FundingGroup["positionType"] {
	if (raw === "LONG" || raw === 0 || raw === "0") return 0
	if (raw === "SHORT" || raw === 1 || raw === "1") return 1
	throw new Error(`positionType must be LONG, SHORT, 0, or 1; received ${JSON.stringify(raw)}`)
}

function positionTypeName(positionType: FundingGroup["positionType"]) {
	return positionType === 0 ? "LONG" : "SHORT"
}

function globalFundingKey(group: FundingGroup): string {
	return `${group.partyB.toLowerCase()}:${group.symbolId}:${group.positionType}`
}

function parseAddress(name: string, raw: unknown): string {
	if (typeof raw !== "string") throw new Error(`${name} must be an address string`)
	try {
		return ethers.getAddress(raw)
	} catch {
		throw new Error(`${name} is not a valid address: ${raw}`)
	}
}

function loadGroups(file: string): FundingGroup[] {
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("GROUPS_FILE must contain a non-empty JSON array")
	const seen = new Set<string>()
	return parsed.map((raw, index) => {
		if (!raw || typeof raw !== "object") throw new Error(`groups[${index}] must be an object`)
		const item = raw as RawGroup
		const group = {
			partyA: parseAddress(`groups[${index}].partyA`, item.partyA),
			partyB: parseAddress(`groups[${index}].partyB`, item.partyB),
			symbolId: parseUint256(`groups[${index}].symbolId`, item.symbolId),
			positionType: parsePositionType(item.positionType),
		}
		const key = `${group.partyA.toLowerCase()}:${globalFundingKey(group)}`
		if (seen.has(key)) throw new Error(`groups[${index}] duplicates an earlier funding group`)
		seen.add(key)
		return group
	})
}

function jsonRepair(repair: PreparedRepair) {
	return {
		partyA: repair.partyA,
		partyB: repair.partyB,
		symbolId: repair.symbolId.toString(),
		positionType: positionTypeName(repair.positionType),
		expectedPartyAFunding: repair.expectedPartyAFunding.toString(),
		expectedPartyBFunding: repair.expectedPartyBFunding.toString(),
		newFunding: repair.newFunding.toString(),
		oldGlobalFunding: repair.oldGlobalFunding.toString(),
		quoteCount: repair.quoteCount.toString(),
	}
}

function contractRepair(repair: PreparedRepair): IMigrationFacet.AggregateFundingGroupStruct {
	return {
		partyA: repair.partyA,
		partyB: repair.partyB,
		symbolId: repair.symbolId,
		positionType: repair.positionType,
		expectedPartyAFunding: repair.expectedPartyAFunding,
		expectedPartyBFunding: repair.expectedPartyBFunding,
		newFunding: repair.newFunding,
	}
}

async function prepareRepair(
	group: FundingGroup,
	viewQuote: ViewFacetQuote,
	viewAggregate: ViewFacetAggregate,
	blockTag: number,
	pageSize: number,
): Promise<PreparedRepair> {
	const reportedQuoteCount = BigInt(await viewQuote.partyBPositionsCount(group.partyB, group.partyA, { blockTag }))
	let quoteCount = 0n
	let newFunding = 0n

	while (true) {
		const quotes = await viewQuote.getPartyBOpenPositions(group.partyB, group.partyA, quoteCount, pageSize, { blockTag })
		if (quotes.length === 0) break
		if (quotes.length > pageSize) throw new Error(`Quote page at index ${quoteCount} exceeded PAGE_SIZE=${pageSize}`)

		for (const quote of quotes) {
			if (ethers.getAddress(quote.partyA) !== group.partyA || ethers.getAddress(quote.partyB) !== group.partyB) {
				throw new Error(`Quote ${quote.id} does not belong to the requested PartyA/PartyB pair`)
			}
		}
		newFunding = accumulateGroupFunding(newFunding, quotes, group.symbolId, group.positionType)
		quoteCount += BigInt(quotes.length)
		if (quotes.length < pageSize) break
	}
	if (quoteCount !== reportedQuoteCount) {
		throw new Error(`Open-position array length ${quoteCount} does not match partyBPositionsCount ${reportedQuoteCount}`)
	}

	const [expectedPartyAFunding, expectedPartyBFunding, oldGlobalFunding] = await Promise.all([
		viewAggregate.getPartyAAggregatedFundingPerPartyB(group.partyA, group.partyB, group.symbolId, group.positionType, { blockTag }),
		viewAggregate.getPartyBAggregatedFundingPerPartyA(group.partyB, group.partyA, group.symbolId, group.positionType, { blockTag }),
		viewAggregate.getPartyBAggregatedFunding(group.partyB, group.symbolId, group.positionType, { blockTag }),
	])

	return {
		...group,
		expectedPartyAFunding: requireInt256(BigInt(expectedPartyAFunding), "expected PartyA funding"),
		expectedPartyBFunding: requireInt256(BigInt(expectedPartyBFunding), "expected PartyB funding"),
		newFunding,
		oldGlobalFunding: requireInt256(BigInt(oldGlobalFunding), "old global PartyB funding"),
		quoteCount,
	}
}

async function main(): Promise<void> {
	const symmio = parseAddress("SYMMIO", requiredEnv("SYMMIO"))
	const groupsFile = path.resolve(requiredEnv("GROUPS_FILE"))
	const pageSize = parsePositiveInteger("PAGE_SIZE", process.env.PAGE_SIZE, DEFAULT_PAGE_SIZE)
	const groupBatchSize = parsePositiveInteger("GROUP_BATCH_SIZE", process.env.GROUP_BATCH_SIZE, DEFAULT_GROUP_BATCH_SIZE)
	const execute = process.env.EXECUTE === "true"
	if (process.env.EXECUTE !== undefined && process.env.EXECUTE !== "true" && process.env.EXECUTE !== "false") {
		throw new Error("EXECUTE must be exactly true or false")
	}

	const network = await ethers.provider.getNetwork()
	const chainId = network.chainId
	const blockTag = await ethers.provider.getBlockNumber()
	const sourceBlock = await ethers.provider.getBlock(blockTag)
	if (!sourceBlock?.hash) throw new Error(`Source block ${blockTag} was not returned`)
	if ((await ethers.provider.getCode(symmio, blockTag)) === "0x") throw new Error(`SYMMIO has no contract code at ${symmio}`)

	const view = ViewFacet__factory.connect(symmio, ethers.provider)
	const pauseState = await view.pauseState({ blockTag })
	if (!pauseState.globalPaused) throw new Error(`Protocol was not globally paused at block ${blockTag}`)

	const viewQuote = ViewFacetQuote__factory.connect(symmio, ethers.provider)
	const viewAggregate = ViewFacetAggregate__factory.connect(symmio, ethers.provider)
	const migrationRead = MigrationFacet__factory.connect(symmio, ethers.provider)
	const groups = loadGroups(groupsFile)
	const repairs: PreparedRepair[] = []
	for (const group of groups) repairs.push(await prepareRepair(group, viewQuote, viewAggregate, blockTag, pageSize))
	const sourceBlockAfterReads = await ethers.provider.getBlock(blockTag)
	if (sourceBlockAfterReads?.hash !== sourceBlock.hash) throw new Error(`Source block ${blockTag} changed while the repair was calculated`)

	const expectedGlobals = new Map<string, { repair: PreparedRepair; oldValue: bigint; value: bigint }>()
	for (const repair of repairs) {
		const key = globalFundingKey(repair)
		const current = expectedGlobals.get(key)
		if (current) {
			if (current.oldValue !== repair.oldGlobalFunding) throw new Error(`Inconsistent fixed-block global funding for ${key}`)
			current.value = addFunding(subtractFunding(current.value, repair.expectedPartyBFunding), repair.newFunding)
		} else {
			expectedGlobals.set(key, {
				repair,
				oldValue: repair.oldGlobalFunding,
				value: addFunding(subtractFunding(repair.oldGlobalFunding, repair.expectedPartyBFunding), repair.newFunding),
			})
		}
	}

	const batches: PreparedRepair[][] = []
	for (let start = 0; start < repairs.length; start += groupBatchSize) batches.push(repairs.slice(start, start + groupBatchSize))
	const transactions = batches.map((batch, index) => ({
		index,
		to: symmio,
		value: "0",
		data: migrationRead.interface.encodeFunctionData("resyncAggregateFunding", [batch.map(contractRepair)]),
		groups: batch.map(jsonRepair),
	}))
	const plan = {
		chainId: chainId.toString(),
		blockTag,
		blockHash: sourceBlock.hash,
		symmio,
		pageSize,
		groupBatchSize,
		globalFunding: [...expectedGlobals.values()].map(expected => ({
			partyB: expected.repair.partyB,
			symbolId: expected.repair.symbolId.toString(),
			positionType: positionTypeName(expected.repair.positionType),
			oldFunding: expected.oldValue.toString(),
			newFunding: expected.value.toString(),
		})),
		transactions,
	}
	const serializedPlan = `${JSON.stringify(plan, null, 2)}\n`
	console.log(serializedPlan)
	if (process.env.OUTPUT_FILE) {
		const outputFile = path.resolve(process.env.OUTPUT_FILE)
		fs.mkdirSync(path.dirname(outputFile), { recursive: true })
		fs.writeFileSync(outputFile, serializedPlan)
		console.log(`Wrote repair plan to ${outputFile}`)
	}

	if (!execute) {
		console.log("Dry run only. No transaction was sent.")
		return
	}
	if (process.env.CONFIRM_CHAIN_ID !== chainId.toString()) {
		throw new Error(`Set CONFIRM_CHAIN_ID=${chainId} to execute on this chain`)
	}

	const [signer] = await ethers.getSigners()
	if (!signer) throw new Error("No transaction signer is configured")
	if (!(await view.hasRole(signer.address, MIGRATION_ROLE))) throw new Error(`Signer ${signer.address} does not have MIGRATION_ROLE`)
	if (!(await view.pauseState()).globalPaused) throw new Error("Protocol is no longer globally paused")
	const migration = migrationRead.connect(signer)

	for (const [index, batch] of batches.entries()) {
		const input = batch.map(contractRepair)
		await migration.resyncAggregateFunding.staticCall(input)
		const transaction = await migration.resyncAggregateFunding(input)
		const receipt = await transaction.wait()
		if (!receipt || receipt.status !== 1) throw new Error(`Repair transaction ${index} failed`)
		console.log(`Applied repair batch ${index + 1}/${batches.length}: ${transaction.hash}`)
	}

	for (const repair of repairs) {
		const key = globalFundingKey(repair)
		const [partyAFunding, partyBFunding] = await Promise.all([
			viewAggregate.getPartyAAggregatedFundingPerPartyB(repair.partyA, repair.partyB, repair.symbolId, repair.positionType),
			viewAggregate.getPartyBAggregatedFundingPerPartyA(repair.partyB, repair.partyA, repair.symbolId, repair.positionType),
		])
		if (BigInt(partyAFunding) !== repair.newFunding || BigInt(partyBFunding) !== repair.newFunding) {
			throw new Error(`Post-repair pair verification failed for ${key}`)
		}
	}
	for (const [key, expected] of expectedGlobals) {
		const actual = await viewAggregate.getPartyBAggregatedFunding(expected.repair.partyB, expected.repair.symbolId, expected.repair.positionType)
		if (BigInt(actual) !== expected.value) throw new Error(`Post-repair global verification failed for ${key}`)
	}
	console.log(`Verified ${repairs.length} repaired funding group(s).`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
