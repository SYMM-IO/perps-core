import { expect } from "chai"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { MigrationInput, MigrationProgressContext } from "../../scripts/upgrade/migrate.js"
import { migrate, validateMigrationProgressFile } from "../../scripts/upgrade/migrate.js"

describe("migration progress resume identity", function () {
	const context: MigrationProgressContext = {
		chainId: 31_337n,
		diamondAddress: "0x1111111111111111111111111111111111111111",
		networkName: "hardhat",
		forkMode: false,
		executionDomain: "test-instance",
		migrationImplementation: "0x7777777777777777777777777777777777777777",
		migrationCodeHash: `0x${"a".repeat(64)}`,
	}
	const partyB = "0x2222222222222222222222222222222222222222"
	const partyA1 = "0x3333333333333333333333333333333333333333"
	const partyA2 = "0x4444444444444444444444444444444444444444"
	const partyA3 = "0x5555555555555555555555555555555555555555"
	let temporaryDirectory: string

	beforeEach(function () {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-migration-progress-"))
	})

	afterEach(function () {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true })
	})

	async function captureError(promise: Promise<unknown>): Promise<Error> {
		try {
			await promise
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error))
		}
		throw new Error("Expected operation to fail")
	}

	async function leaveInterruptedQuoteProgress(progressFile: string, input: MigrationInput): Promise<void> {
		let calls = 0
		const migrationFacet = {
			migrateQuotes: async () => {
				calls++
				if (calls > 1) throw new Error("intentional interruption")
				return {
					hash: `0x${"1".repeat(64)}`,
					wait: async () => undefined,
				}
			},
		}

		const error = await captureError(
			migrate(migrationFacet as any, {} as any, input, {
				chunkSize: 1,
				maxRetries: 1,
				skipPreCheck: true,
				progressFile,
				progressContext: context,
			}),
		)
		expect(error.message).to.include("intentional interruption")
	}

	it("atomically persists a bound checkpoint and rejects a changed same-length quote input", async function () {
		const progressFile = path.join(temporaryDirectory, "progress.json")
		const input: MigrationInput = { quoteIds: [10n, 20n], partyBTasks: [] }
		await leaveInterruptedQuoteProgress(progressFile, input)

		const progress = validateMigrationProgressFile(progressFile, input, 1, true, context)
		expect(progress?.identity).to.include({
			chainId: "31337",
			diamondAddress: context.diamondAddress,
			networkName: "hardhat",
			forkMode: false,
			executionDomain: "test-instance",
			migrationImplementation: context.migrationImplementation,
			migrationCodeHash: context.migrationCodeHash,
			chunkSize: 1,
		})
		expect(progress?.quotesProcessed).to.equal(1)
		expect(progress?.lastProcessedQuoteChunk).to.equal(0)
		expect(fs.readdirSync(temporaryDirectory).filter(name => name.endsWith(".tmp"))).to.deep.equal([])

		const changedSameLengthInput: MigrationInput = { quoteIds: [10n, 21n], partyBTasks: [] }
		expect(() => validateMigrationProgressFile(progressFile, changedSameLengthInput, 1, true, context)).to.throw(
			"identity.migrationInputHash mismatch",
		)

		const resumedChunks: bigint[][] = []
		await migrate(
			{
				migrateQuotes: async (chunk: bigint[]) => {
					resumedChunks.push(chunk)
					return {
						hash: `0x${"3".repeat(64)}`,
						wait: async () => undefined,
					}
				},
			} as any,
			{} as any,
			input,
			{
				chunkSize: 1,
				maxRetries: 1,
				skipPreCheck: true,
				progressFile,
				progressContext: context,
			},
		)
		expect(resumedChunks).to.deep.equal([[20n]])
		expect(fs.existsSync(progressFile)).to.equal(false)
	})

	it("binds a partial PartyA chunk to the exact PartyB task", async function () {
		const progressFile = path.join(temporaryDirectory, "progress.json")
		const input: MigrationInput = {
			quoteIds: [],
			partyBTasks: [{ partyB, partyAs: [partyA1, partyA2, partyA2, "0x0000000000000000000000000000000000000000"] }],
		}
		let calls = 0
		const migrationFacet = {
			migrateCrossLockedValues: async () => {
				calls++
				if (calls > 1) throw new Error("intentional interruption")
				return {
					hash: `0x${"2".repeat(64)}`,
					wait: async () => undefined,
				}
			},
		}

		await captureError(
			migrate(migrationFacet as any, {} as any, input, {
				chunkSize: 1,
				maxRetries: 1,
				skipPreCheck: true,
				progressFile,
				progressContext: context,
			}),
		)
		const progress = validateMigrationProgressFile(progressFile, input, 1, true, context)
		expect(progress?.activePartyBTask).to.include({ index: 0, partyB })
		expect(progress?.lastProcessedPartyAChunk).to.equal(0)
		const validPartialProgress = fs.readFileSync(progressFile, "utf-8")
		const tamperedCount = JSON.parse(validPartialProgress)
		tamperedCount.partyAsProcessed = 0
		fs.writeFileSync(progressFile, JSON.stringify(tamperedCount))
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, context)).to.throw(
			"partyAsProcessed does not match completed PartyB task chunks",
		)
		fs.writeFileSync(progressFile, validPartialProgress)

		const changedSameLengthTask: MigrationInput = {
			quoteIds: [],
			partyBTasks: [{ partyB, partyAs: [partyA1, partyA3, partyA3, "0x0000000000000000000000000000000000000000"] }],
		}
		expect(() => validateMigrationProgressFile(progressFile, changedSameLengthTask, 1, true, context)).to.throw("identity.partyBTasksHash mismatch")

		const tampered = JSON.parse(fs.readFileSync(progressFile, "utf-8"))
		tampered.activePartyBTask.taskHash = `0x${"f".repeat(64)}`
		fs.writeFileSync(progressFile, JSON.stringify(tampered))
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, context)).to.throw("activePartyBTask identity mismatch")

		fs.writeFileSync(progressFile, validPartialProgress)
		const resumedReport = await migrate(
			{
				migrateCrossLockedValues: async () => ({
					hash: `0x${"4".repeat(64)}`,
					wait: async () => undefined,
				}),
			} as any,
			{} as any,
			input,
			{
				chunkSize: 1,
				maxRetries: 1,
				skipPreCheck: true,
				progressFile,
				progressContext: context,
			},
		)
		expect(resumedReport.partyAsTotal).to.equal(2)
		expect(resumedReport.partyAsMigrated).to.equal(2)
	})

	it("revalidates every covered item when resuming with prechecks enabled", async function () {
		const progressFile = path.join(temporaryDirectory, "progress.json")
		const input: MigrationInput = {
			quoteIds: [10n],
			partyBTasks: [{ partyB, partyAs: [partyA1] }],
		}
		const successfulTransaction = {
			hash: `0x${"5".repeat(64)}`,
			wait: async () => undefined,
		}
		await captureError(
			migrate(
				{
					isQuoteMigrated: async () => false,
					migrateQuotes: async () => successfulTransaction,
					isCrossLockedValuesMigrated: async () => false,
					migrateCrossLockedValues: async () => {
						throw new Error("intentional interruption")
					},
				} as any,
				{
					getQuote: async () => ({ quoteStatus: 4n, partyA: partyA1, quantity: 1n, closedAmount: 0n }),
				} as any,
				input,
				{
					chunkSize: 1,
					maxRetries: 1,
					skipPreCheck: false,
					progressFile,
					progressContext: context,
				},
			),
		)

		let quoteMigrationCalls = 0
		await migrate(
			{
				isQuoteMigrated: async () => false,
				migrateQuotes: async () => {
					quoteMigrationCalls++
					return successfulTransaction
				},
				isCrossLockedValuesMigrated: async () => false,
				migrateCrossLockedValues: async () => successfulTransaction,
			} as any,
			{
				getQuote: async () => ({ quoteStatus: 4n, partyA: partyA1, quantity: 1n, closedAmount: 0n }),
			} as any,
			input,
			{
				chunkSize: 1,
				maxRetries: 1,
				skipPreCheck: false,
				progressFile,
				progressContext: context,
			},
		)
		expect(quoteMigrationCalls).to.equal(1)
	})

	it("fails closed for corrupt, legacy, or differently scoped progress", async function () {
		const progressFile = path.join(temporaryDirectory, "progress.json")
		const input: MigrationInput = { quoteIds: [10n, 20n], partyBTasks: [] }
		await leaveInterruptedQuoteProgress(progressFile, input)
		const validPartialProgress = fs.readFileSync(progressFile, "utf-8")

		const tamperedCursor = JSON.parse(validPartialProgress)
		tamperedCursor.lastProcessedQuoteChunk = 1
		fs.writeFileSync(progressFile, JSON.stringify(tamperedCursor))
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, context)).to.throw(
			"quotesProcessed does not match lastProcessedQuoteChunk",
		)

		const prematureBalancePhase = JSON.parse(validPartialProgress)
		prematureBalancePhase.phase = "balances"
		fs.writeFileSync(progressFile, JSON.stringify(prematureBalancePhase))
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, context)).to.throw(
			"balance-phase progress does not prove every quote chunk completed",
		)
		fs.writeFileSync(progressFile, validPartialProgress)

		expect(() => validateMigrationProgressFile(progressFile, input, 2, true, context)).to.throw("identity.chunkSize mismatch")
		expect(() => validateMigrationProgressFile(progressFile, input, 1, false, context)).to.throw("identity.skipPreCheck mismatch")
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, { ...context, networkName: "fork-hardhat" })).to.throw(
			"identity.networkName mismatch",
		)
		expect(() => validateMigrationProgressFile(progressFile, input, 1, false, { ...context, forkMode: true })).to.throw("identity.forkMode mismatch")
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, { ...context, executionDomain: "other-instance" })).to.throw(
			"identity.executionDomain mismatch",
		)
		expect(() =>
			validateMigrationProgressFile(progressFile, input, 1, true, {
				...context,
				migrationImplementation: "0x8888888888888888888888888888888888888888",
			}),
		).to.throw("identity.migrationImplementation mismatch")
		expect(() =>
			validateMigrationProgressFile(progressFile, input, 1, true, {
				...context,
				migrationCodeHash: `0x${"b".repeat(64)}`,
			}),
		).to.throw("identity.migrationCodeHash mismatch")
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, { ...context, chainId: 1n })).to.throw("identity.chainId mismatch")
		expect(() =>
			validateMigrationProgressFile(progressFile, input, 1, true, {
				...context,
				diamondAddress: "0x6666666666666666666666666666666666666666",
			}),
		).to.throw("identity.diamondAddress mismatch")

		fs.writeFileSync(progressFile, "{not-json")
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, context)).to.throw("contains invalid JSON")

		fs.writeFileSync(
			progressFile,
			JSON.stringify({
				startedAt: new Date().toISOString(),
				phase: "quotes",
				quotesProcessed: 1,
			}),
		)
		expect(() => validateMigrationProgressFile(progressFile, input, 1, true, context)).to.throw("unsupported or missing schemaVersion")
	})

	it("does not call the migration contract when the initial progress write fails", async function () {
		const readOnlyDirectory = path.join(temporaryDirectory, "read-only")
		fs.mkdirSync(readOnlyDirectory)
		fs.chmodSync(readOnlyDirectory, 0o500)
		let transactionCalls = 0
		const migrationFacet = {
			migrateQuotes: async () => {
				transactionCalls++
				throw new Error("must not be reached")
			},
		}
		const input: MigrationInput = { quoteIds: [1n], partyBTasks: [] }

		const dryRunError = await captureError(
			migrate(migrationFacet as any, {} as any, input, {
				chunkSize: 1,
				dryRun: true,
				progressFile: path.join(temporaryDirectory, "dry-run-progress.json"),
				progressContext: context,
			}),
		)
		expect(dryRunError.message).to.include("Persisted migration progress is not allowed in dry-run mode")

		const unconfirmedError = await captureError(
			migrate(migrationFacet as any, {} as any, input, {
				chunkSize: 1,
				confirmations: 0,
				progressFile: path.join(temporaryDirectory, "unconfirmed-progress.json"),
				progressContext: context,
			}),
		)
		expect(unconfirmedError.message).to.include("requires at least one transaction confirmation")

		const unsafeForkError = await captureError(
			migrate(migrationFacet as any, {} as any, input, {
				chunkSize: 1,
				skipPreCheck: true,
				progressFile: path.join(temporaryDirectory, "fork-progress.json"),
				progressContext: { ...context, forkMode: true, executionDomain: "hardhat:fork-instance" },
			}),
		)
		expect(unsafeForkError.message).to.include("Persisted fork migration requires skipPreCheck=false")

		let error: Error
		try {
			error = await captureError(
				migrate(migrationFacet as any, {} as any, input, {
					chunkSize: 1,
					skipPreCheck: true,
					progressFile: path.join(readOnlyDirectory, "progress.json"),
					progressContext: context,
				}),
			)
		} finally {
			fs.chmodSync(readOnlyDirectory, 0o700)
		}
		expect(error.message).to.include("Failed to atomically save migration progress file")
		expect(transactionCalls).to.equal(0)
	})
})
