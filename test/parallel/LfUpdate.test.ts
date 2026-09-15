import { expect } from "chai"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { LF_BTC_ETH, LF_OTHER, LF_CORE_ABI, LF_ROLE_NAME, createLfPlan } from "../../scripts/utils/lfUpdate.js"
import { inspectLf, runLfUpdate, verifyLfUpdate } from "../../scripts/utils/lfUpdateRuntime.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture, time } from "../helpers/network-helpers.js"
import { Hedger } from "../models/Hedger.js"
import { User } from "../models/User.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"

describe("LF update operator adapter", function () {
	let context: any, manager: any, operator: any, directory: string, config: any
	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		operator = context.signers.admin
		const core = await context.symbolControlFacet.getAddress()
		manager = await (await ethers.getContractFactory("SymmioSymbolManager")).deploy(core, operator.address)
		await manager.waitForDeployment()
		await manager.grantRole(ethers.id(LF_ROLE_NAME), operator.address)
		await manager.grantRole(ethers.id("SETTER_ROLE"), operator.address)
		await context.controlFacet.connect(operator).grantRole(await manager.getAddress(), ethers.id("SYMBOL_MANAGER_ROLE"))
		for (const name of ["BTCUSD_CARBONRWA", "ETHUSDT", "SOLUSDT"]) {
			await context.symbolControlFacet.connect(operator).addSymbol(name, decimal(7n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
		}
		await context.symbolControlFacet.connect(operator).setSymbolValidationState(2, false)
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "lf-adapter-"))
		config = {
			network: "localhost",
			chainId: Number((await ethers.provider.getNetwork()).chainId),
			core,
			symbolManager: await manager.getAddress(),
			authority: operator.address,
			batchSize: 2,
			announcementReference: "local fixture announcement",
			enforcementAt: "2020-01-01T00:00:00Z",
		}
	})
	afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
	async function prepare() {
		const snapshot = await inspectLf(ethers.provider, config)
		return createLfPlan(snapshot, snapshot.classification.btcEthIds.join(","))
	}
	const args = (plan: any, execute = false) => ({
		provider: ethers.provider,
		signer: operator,
		plan,
		expectedDigest: plan.digest,
		reportPath: path.join(directory, "report.json"),
		execute,
	})
	it("dry-runs, journals partial execution, resumes and verifies every symbol without duplicate writes", async function () {
		const plan = await prepare(),
			before = await ethers.provider.getTransactionCount(operator.address)
		assert.equal((await runLfUpdate(args(plan))).status, "ready")
		assert.equal(await ethers.provider.getTransactionCount(operator.address), before)
		const partial = await runLfUpdate({ ...args(plan, true), maxBatches: 1 })
		assert.equal(partial.status, "ready")
		assert.equal(partial.transactions.length, 1)
		assert.equal(partial.transactions[0].status, "confirmed")
		const complete = await runLfUpdate(args(plan, true))
		assert.equal(complete.status, "complete")
		assert.equal(complete.transactions.length, 2)
		assert.deepEqual(
			complete.verification!.symbols.map(symbol => symbol.minAcceptablePortionLF),
			[LF_BTC_ETH, LF_BTC_ETH, LF_BTC_ETH, LF_OTHER],
		)
		assert.deepEqual(
			complete.verification!.symbols.map(symbol => symbol.minAcceptableQuoteValue),
			plan.snapshot.symbols.map((symbol: any) => symbol.minAcceptableQuoteValue),
		)
		assert.equal(complete.verification!.symbols[1].isValid, false)
		const nonce = await ethers.provider.getTransactionCount(operator.address)
		assert.equal((await runLfUpdate(args(plan, true))).status, "complete")
		assert.equal(await ethers.provider.getTransactionCount(operator.address), nonce)
	})
	it("waits for quota and resumes after the on-chain reset", async function () {
		await manager.setDailyLimits([25, 25, 25, 25, 2, 25, 25])
		const plan = await prepare()
		assert.equal((await runLfUpdate(args(plan, true))).status, "waiting-daily-limit")
		await time.increase(86400)
		assert.equal((await runLfUpdate(args(plan, true))).status, "complete")
	})
	it("refuses quote-minimum drift, wrong signer, tampered plan, and premature enforcement", async function () {
		config.enforcementAt = new Date((Number(await time.latest()) + 3600) * 1000).toISOString().replace(".000Z", "Z")
		const plan = await prepare()
		assert.equal((await runLfUpdate(args(plan, true))).status, "waiting-enforcement")
		await assert.rejects(runLfUpdate({ ...args(plan, true), signer: context.signers.user }), /signer/)
		await assert.rejects(runLfUpdate({ ...args(plan), expectedDigest: "wrong" }), /digest/)
		await context.symbolControlFacet.connect(operator).setSymbolAcceptableValues(1, 99, decimal(1n, 16))
		await assert.rejects(runLfUpdate(args(plan, true)), /minAcceptableQuoteValue/)
	})
	it("stops on unknown transaction outcomes before another broadcast", async function () {
		const plan = await prepare(),
			report = await runLfUpdate(args(plan))
		report.transactions.push({
			label: "uncertain LF",
			hash: "0x" + "ab".repeat(32),
			nonce: 9,
			status: "unresolved",
			from: operator.address,
			to: config.symbolManager,
			data: plan.actions[0].data,
			value: "0",
			submittedAt: new Date().toISOString(),
			durationMs: 0,
			confirmations: 1,
		})
		fs.writeFileSync(args(plan).reportPath, JSON.stringify(report))
		const nonce = await ethers.provider.getTransactionCount(operator.address)
		await assert.rejects(runLfUpdate(args(plan, true)), /unresolved broadcast/)
		assert.equal(await ethers.provider.getTransactionCount(operator.address), nonce)
	})
	it("enforces the 3% and 4% collateral boundary on new quotes through the actual Core", async function () {
		const plan = await prepare()
		await runLfUpdate(args(plan, true))
		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(5000n), decimal(3000n), decimal(3000n))
		for (const [symbolId, lf, mm] of [
			[1, 3n, 75n],
			[4, 4n, 74n],
		] as const) {
			// Total locked collateral is exactly 100; changing MM in the failing quote keeps that denominator fixed.
			await expect(
				user.sendQuote(
					limitQuoteRequestBuilder()
						.symbolId(symbolId)
						.cva(decimal(22n))
						.partyAmm(decimal(mm) + 1n)
						.lf(decimal(lf) - 1n)
						.build(),
				),
			).to.be.revertedWith("PartyAFacet: LF is not enough")
			await expect(user.sendQuote(limitQuoteRequestBuilder().symbolId(symbolId).cva(decimal(22n)).partyAmm(decimal(mm)).lf(decimal(lf)).build())).to
				.not.be.reverted
		}
	})
	it("preserves an already-open position including its original locked LF", async function () {
		const user = new User(context, context.signers.user),
			hedger = new Hedger(context, context.signers.hedger)
		await user.setup()
		await user.setBalances(decimal(5000n), decimal(3000n), decimal(3000n))
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))
		await user.sendQuote(limitQuoteRequestBuilder().lf(decimal(2n)).partyAmm(decimal(76n)).build())
		await hedger.lockQuote(1)
		await hedger.openPosition(1)
		const before = await context.viewFacetQuote.getQuote(1)
		const plan = await prepare()
		await runLfUpdate(args(plan, true))
		assert.deepEqual((await context.viewFacetQuote.getQuote(1)).toArray(true), before.toArray(true))
	})
	it("defers final proof and detects missing LF effects without resubmitting", async function () {
		const plan = await prepare()
		const report = await runLfUpdate({ ...args(plan, true), deferFinalVerification: true })
		assert.equal(report.status, "submitted")
		assert.equal(report.verification, undefined)
		await context.symbolControlFacet
			.connect(operator)
			.setSymbolAcceptableValues(1, plan.snapshot.symbols[0].minAcceptableQuoteValue, plan.snapshot.symbols[0].minAcceptablePortionLF)
		const nonce = await ethers.provider.getTransactionCount(operator.address)
		await assert.rejects(verifyLfUpdate(args(plan)), /final verification failed/)
		const failed = JSON.parse(fs.readFileSync(args(plan).reportPath, "utf8"))
		assert.equal(failed.status, "verification-failed")
		assert.equal(failed.pending, 1)
		assert.equal(failed.verification.symbols.length, 4)
		await assert.rejects(runLfUpdate(args(plan, true)), /previously confirmed LF update is no longer at target/)
		assert.equal(await ethers.provider.getTransactionCount(operator.address), nonce)
	})
	it("verifies receipt blocks when latest remains behind confirmed LF transactions", async function () {
		const plan = await prepare(),
			staleBlock = await ethers.provider.getBlock("latest")
		const laggingProvider = new Proxy(ethers.provider, {
			get(target, property) {
				if (property === "getBlock") return (tag: any) => (tag === "latest" ? Promise.resolve(staleBlock) : target.getBlock(tag))
				const value = Reflect.get(target, property)
				return typeof value === "function" ? value.bind(target) : value
			},
		})
		const report = await runLfUpdate({ ...args(plan, true), provider: laggingProvider })
		assert.equal(report.status, "complete")
		assert.equal(report.transactions.length, 2)
		assert.ok(report.verification!.block.number >= report.transactions.at(-1)!.blockNumber!)
		assert.deepEqual(
			report.transactions.flatMap(tx => tx.symbolIds),
			["1", "2", "3", "4"],
		)
		assert.ok(report.transactions.every(tx => tx.postState === undefined))
	})
	it("does not resubmit confirmed symbols when a resumed RPC head is behind the receipt", async function () {
		const plan = await prepare(),
			staleBlock = await ethers.provider.getBlock("latest")
		await runLfUpdate({ ...args(plan, true), maxBatches: 1 })
		const laggingProvider = new Proxy(ethers.provider, {
			get(target, property) {
				if (property === "getBlock") return (tag: any) => (tag === "latest" ? Promise.resolve(staleBlock) : target.getBlock(tag))
				const value = Reflect.get(target, property)
				return typeof value === "function" ? value.bind(target) : value
			},
		})
		const report = await runLfUpdate({ ...args(plan, true), provider: laggingProvider })
		assert.equal(report.status, "complete")
		assert.equal(report.transactions.length, 2)
		assert.deepEqual(
			report.transactions.flatMap(tx => tx.symbolIds),
			["1", "2", "3", "4"],
		)
	})
	for (const missing of ["block", "state"]) {
		it(`waits for temporarily unavailable receipt ${missing} data without resubmitting`, async function () {
			const plan = await prepare(),
				failures = new Map<number, number>()
			const delayedProvider = new Proxy(ethers.provider, {
				get(target, property) {
					const method = missing === "block" ? "getBlock" : "call"
					if (property === method)
						return async (argument: any) => {
							const tag = missing === "block" ? argument : argument.blockTag
							if (typeof tag === "number" && tag > plan.snapshot.block.number && (failures.get(tag) ?? 0) < 2) {
								failures.set(tag, (failures.get(tag) ?? 0) + 1)
								if (missing === "block") return null
								throw Object.assign(new Error("missing revert data"), { info: { error: { message: "header not found" } } })
							}
							return (target[method] as any)(argument)
						}
					const value = Reflect.get(target, property)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
			const report = await runLfUpdate({
				...args(plan, true),
				provider: delayedProvider,
				readRetry: { maxAttempts: 3, delayMs: 0 },
			})
			assert.equal(report.status, "complete")
			assert.deepEqual(
				report.transactions.flatMap(tx => tx.symbolIds),
				["1", "2", "3", "4"],
			)
			assert.ok(failures.size >= 1)
			assert.ok([...failures.values()].every(count => count === 2))
		})
	}
	for (const unavailable of [true, false]) {
		it(`defers proof until all batches finish when the final receipt block ${unavailable ? "is unavailable" : "has a different hash"}`, async function () {
			const plan = await prepare(),
				nonce = await ethers.provider.getTransactionCount(operator.address)
			const inconsistentProvider = new Proxy(ethers.provider, {
				get(target, property) {
					if (property === "getBlock")
						return async (tag: any) => {
							const block = await target.getBlock(tag)
							if (typeof tag === "number" && tag > plan.snapshot.block.number) return unavailable ? null : { ...block, hash: "0x" + "ab".repeat(32) }
							return block
						}
					const value = Reflect.get(target, property)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
			await assert.rejects(
				runLfUpdate({ ...args(plan, true), provider: inconsistentProvider, readRetry: { maxAttempts: 3, delayMs: 0 } }),
				unavailable ? /verification block .* unavailable/ : /receipt block .* changed/,
			)
			assert.equal(await ethers.provider.getTransactionCount(operator.address), nonce + 2)
			const report = JSON.parse(fs.readFileSync(args(plan).reportPath, "utf8"))
			assert.equal(report.transactions.length, 2)
			assert.equal(report.transactions[0].status, "confirmed")
			assert.equal(report.transactions[0].postState, undefined)
		})
	}
	it("rejects a receipt block hash that changes while state reads catch up", async function () {
		const plan = await prepare()
		let delayedState = false
		const changedProvider = new Proxy(ethers.provider, {
			get(target, property) {
				if (property === "call")
					return async (tx: any) => {
						if (typeof tx.blockTag === "number" && tx.blockTag > plan.snapshot.block.number && !delayedState) {
							delayedState = true
							throw new Error("header not found")
						}
						return target.call(tx)
					}
				if (property === "getBlock")
					return async (tag: any) => {
						const block = await target.getBlock(tag)
						return delayedState && typeof tag === "number" && tag > plan.snapshot.block.number ? { ...block, hash: "0x" + "ab".repeat(32) } : block
					}
				const value = Reflect.get(target, property)
				return typeof value === "function" ? value.bind(target) : value
			},
		})
		await assert.rejects(
			runLfUpdate({ ...args(plan, true), provider: changedProvider, readRetry: { maxAttempts: 3, delayMs: 0 } }),
			/receipt block .* changed/,
		)
		const report = JSON.parse(fs.readFileSync(args(plan).reportPath, "utf8"))
		assert.equal(report.transactions.length, 2)
		assert.equal(report.transactions[0].status, "confirmed")
		assert.equal(report.transactions[0].postState, undefined)
	})
	it("resumes after a submission failure following a confirmed first batch", async function () {
		const plan = await prepare()
		let attempts = 0
		const interruptedSigner = {
			getAddress: () => operator.getAddress(),
			sendTransaction: (transaction: any) => {
				if (++attempts === 2) throw new Error("test signing interruption")
				return operator.sendTransaction(transaction)
			},
		}
		await assert.rejects(runLfUpdate({ ...args(plan, true), signer: interruptedSigner }), /signing interruption/)
		const report = await runLfUpdate(args(plan, true))
		assert.equal(report.status, "complete")
		assert.equal(report.transactions.length, 2)
	})
	it("reads the full catalog once at start and once at the end across continuous windows", async function () {
		const plan = await prepare()
		let catalogs = 0
		const lookups: string[] = []
		const abi = new ethers.Interface(LF_CORE_ABI)
		const provider = new Proxy(ethers.provider, {
			get(target, property) {
				if (property === "call")
					return (request: any) => {
						const parsed = abi.parseTransaction({ data: request.data })
						if (["getSymbols", "getSymbolsWithType"].includes(parsed?.name ?? "") && parsed!.args[1] === 200n) catalogs++
						return target.call(request)
					}
				if (property === "getTransactionReceipt")
					return (hash: string) => {
						lookups.push(hash)
						return target.getTransactionReceipt(hash)
					}
				const value = Reflect.get(target, property)
				return typeof value === "function" ? value.bind(target) : value
			},
		})
		const first = await runLfUpdate({ ...args(plan, true), provider, maxBatches: 1, deferFinalVerification: true })
		assert.equal(first.status, "ready")
		assert.equal(catalogs, 1)
		const second = await runLfUpdate({ ...args(plan, true), provider, continueRun: true, deferFinalVerification: true })
		assert.equal(second.status, "submitted")
		assert.equal(second.verification, undefined)
		assert.equal(catalogs, 1)
		assert.deepEqual(lookups, [])
		const final = await verifyLfUpdate({ ...args(plan), provider })
		assert.equal(final.status, "complete")
		assert.equal(catalogs, 2)
		assert.deepEqual(lookups, [])
		assert.equal(final.transactions.length, 2)
	})
	it("reads fresh state on a real resume and skips legacy successful receipts without post-state proofs", async function () {
		const plan = await prepare()
		const partial = await runLfUpdate({ ...args(plan, true), maxBatches: 1 })
		delete partial.transactions[0].receiptObservations
		delete partial.transactions[0].postState
		fs.writeFileSync(args(plan).reportPath, JSON.stringify(partial))
		const lookups: string[] = []
		const provider = new Proxy(ethers.provider, {
			get(target, property) {
				if (property === "getTransactionReceipt")
					return (hash: string) => {
						lookups.push(hash)
						return target.getTransactionReceipt(hash)
					}
				const value = Reflect.get(target, property)
				return typeof value === "function" ? value.bind(target) : value
			},
		})
		const result = await runLfUpdate({ ...args(plan, true), provider })
		assert.equal(result.status, "complete")
		assert.equal(result.transactions.length, 2)
		assert.deepEqual(lookups, [])
	})
	it("checks fresh quote minimums before writing a continuation window", async function () {
		const plan = await prepare()
		await runLfUpdate({ ...args(plan, true), maxBatches: 1 })
		await context.symbolControlFacet.connect(operator).setSymbolAcceptableValues(3, 99, decimal(1n, 16))
		const nonce = await ethers.provider.getTransactionCount(operator.address)
		await assert.rejects(runLfUpdate({ ...args(plan, true), continueRun: true }), /minAcceptableQuoteValue/)
		assert.equal(await ethers.provider.getTransactionCount(operator.address), nonce)
	})
	it("continues through provisional receipts without duplicate transactions", async function () {
		const plan = await prepare()
		const earlySigner = {
			getAddress: () => operator.getAddress(),
			async sendTransaction(request: any) {
				const tx = await operator.sendTransaction(request)
				return new Proxy(tx, {
					get(target, property) {
						if (property === "wait") return async (confirmations: number) => ({ ...(await target.wait(confirmations)), blockHash: ethers.ZeroHash })
						const value = Reflect.get(target, property)
						return typeof value === "function" ? value.bind(target) : value
					},
				})
			},
		}
		const report = await runLfUpdate({ ...args(plan, true), signer: earlySigner, readRetry: { maxAttempts: 3, delayMs: 0 } })
		assert.equal(report.status, "complete")
		assert.equal(report.transactions.length, 2)
		for (const tx of report.transactions) {
			assert.equal(tx.receiptObservations![0].blockHash, ethers.ZeroHash)
			assert.equal(tx.postState, undefined)
		}
		assert.equal(report.transactions.at(-1)!.receiptObservations!.at(-1)!.blockHash, report.verification!.block.hash)
	})
})
