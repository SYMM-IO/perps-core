import { expect } from "chai"
import { ethers } from "ethers"
import fs from "fs"
import os from "os"
import path from "path"

import {
	buildMigrationProgressIdentity,
	migrate,
	type ActivePartyBTaskIdentity,
	type MigrationInput,
	type MigrationProgress,
	type MigrationProgressContext,
} from "../../scripts/upgrade/migrate.js"

const txResponse = (hash: string) => ({
	hash,
	wait: async () => ({ status: 1 }),
})

const progressContext: MigrationProgressContext = {
	chainId: 31_337n,
	diamondAddress: "0x1111111111111111111111111111111111111111",
	networkName: "hardhat",
	forkMode: false,
	executionDomain: "migration-script-test",
	migrationImplementation: "0x7777777777777777777777777777777777777777",
	migrationCodeHash: `0x${"a".repeat(64)}`,
}

function activeTaskIdentity(input: MigrationInput, index: number): ActivePartyBTaskIdentity {
	const task = input.partyBTasks[index]
	const partyB = ethers.getAddress(task.partyB)
	const seen = new Set<string>()
	const partyAs = task.partyAs
		.map(address => ethers.getAddress(address).toLowerCase())
		.filter(address => {
			if (seen.has(address)) return false
			seen.add(address)
			return true
		})
	const canonicalTask = { index, partyB: partyB.toLowerCase(), partyAs }
	return {
		index,
		partyB,
		taskHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(canonicalTask))),
	}
}

function makeProgressFile(input: MigrationInput, progress: Omit<MigrationProgress, "schemaVersion" | "identity">): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-migration-"))
	const file = path.join(dir, "progress.json")
	const persistedProgress: MigrationProgress = {
		schemaVersion: 1,
		identity: buildMigrationProgressIdentity(input, 2, false, progressContext),
		...progress,
	}
	fs.writeFileSync(file, JSON.stringify(persistedProgress, null, 2))
	return { dir, file }
}

describe("Migration script", function () {
	it("resumes quote migration without skipping filtered pending quotes", async function () {
		const input: MigrationInput = { quoteIds: [1n, 2n, 3n, 4n], partyBTasks: [] }
		const { dir, file } = makeProgressFile(input, {
			startedAt: new Date(0).toISOString(),
			phase: "quotes",
			quotesProcessed: 2,
			partyBsProcessed: 0,
			partyAsProcessed: 0,
			lastProcessedQuoteChunk: 0,
			lastProcessedPartyB: -1,
			lastProcessedPartyAChunk: -1,
			activePartyBTask: null,
		})

		const migratedQuotes = new Set(["1", "2"])
		const migrateQuoteCalls: bigint[][] = []
		const migrationFacet = {
			isQuoteMigrated: async (quoteId: bigint) => migratedQuotes.has(quoteId.toString()),
			migrateQuotes: async (quoteIds: bigint[]) => {
				migrateQuoteCalls.push(quoteIds)
				for (const quoteId of quoteIds) migratedQuotes.add(quoteId.toString())
				return txResponse("0xquote")
			},
			isCrossLockedValuesMigrated: async () => true,
			migrateCrossLockedValues: async () => txResponse("0xbalance"),
		}
		const viewFacetQuote = {
			getQuote: async () => ({
				quoteStatus: 4n,
				partyA: "0x0000000000000000000000000000000000000001",
				quantity: 100n,
				closedAmount: 0n,
			}),
		}

		try {
			await migrate(migrationFacet as any, viewFacetQuote, input, {
				chunkSize: 2,
				progressFile: file,
				progressContext,
				confirmations: 1,
				maxRetries: 1,
			})

			expect(migrateQuoteCalls).to.deep.equal([[3n, 4n]])
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it("resumes partyB balance migration without skipping filtered pending partyAs", async function () {
		const partyB = "0x00000000000000000000000000000000000000b0"
		const partyAs = [
			"0x00000000000000000000000000000000000000a1",
			"0x00000000000000000000000000000000000000a2",
			"0x00000000000000000000000000000000000000a3",
			"0x00000000000000000000000000000000000000a4",
		]
		const input: MigrationInput = { quoteIds: [], partyBTasks: [{ partyB, partyAs }] }
		const { dir, file } = makeProgressFile(input, {
			startedAt: new Date(0).toISOString(),
			phase: "balances",
			quotesProcessed: 0,
			partyBsProcessed: 0,
			partyAsProcessed: 2,
			lastProcessedQuoteChunk: -1,
			lastProcessedPartyB: -1,
			lastProcessedPartyAChunk: 0,
			activePartyBTask: activeTaskIdentity(input, 0),
		})
		const migratedPairs = new Set([partyAs[0].toLowerCase(), partyAs[1].toLowerCase()])
		const balanceCalls: string[][] = []
		const migrationFacet = {
			isQuoteMigrated: async () => true,
			migrateQuotes: async () => txResponse("0xquote"),
			isCrossLockedValuesMigrated: async (_partyB: string, partyA: string) => migratedPairs.has(partyA.toLowerCase()),
			migrateCrossLockedValues: async (_partyB: string, chunk: string[]) => {
				balanceCalls.push(chunk)
				for (const partyA of chunk) migratedPairs.add(partyA.toLowerCase())
				return txResponse("0xbalance")
			},
		}
		const viewFacetQuote = {
			getQuote: async () => ({
				quoteStatus: 4n,
				partyA: partyAs[0],
				quantity: 100n,
				closedAmount: 0n,
			}),
		}

		try {
			await migrate(migrationFacet as any, viewFacetQuote, input, {
				chunkSize: 2,
				progressFile: file,
				progressContext,
				confirmations: 1,
				maxRetries: 1,
			})

			expect(balanceCalls).to.deep.equal([[partyAs[2], partyAs[3]]])
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})
