import { ZeroAddress } from "ethers"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { settlementFixture } from "../../cli/test/fixtures/disputed-settlement.js"
import { contracts, digest, ROLE } from "../../deployment-tooling/disputed-settlement.js"
import { runSettlementPhase } from "../../tasks/deploy/disputedSettlement.js"

// Exercise the real ABI encoder/decoder, pinned snapshot reader, runtime, gas/fee
// completion and transaction journal. Only the chain transport and wallet are local.
function harness() {
	const { input, snapshot: s } = settlementFixture()
	s.detail.timestamp = "900"
	s.detail.liquidationTimestamp = "900"
	let height = 1000,
		sends = 0,
		failWait = false,
		badFinal = false,
		nonce = 7
	const root = path.resolve(import.meta.dirname, "../..")
	const { core, layer } = contracts(null, input, root)
	const iface = core.interface,
		txs = new Map(),
		receipts = new Map()
	const report: any = { schema: 1, inputDigest: digest(input), operations: {} }
	const saved: any[] = []
	const block = (n: number) => ({ number: n, timestamp: n, hash: "0x" + n.toString(16).padStart(64, "0") })
	const event = (name: string, values: any[]) => ({ address: input.core, ...iface.encodeEventLog(iface.getEvent(name)!, values) })
	function value(param: any, given: any): any {
		if (param.baseType === "array") return (given || []).map((v: any) => value(param.arrayChildren, v))
		if (param.baseType === "tuple") return param.components.map((p: any, i: number) => value(p, given?.[p.name] ?? given?.[i]))
		if (given !== undefined) return given
		if (param.type === "address") return ZeroAddress
		if (param.type === "bool") return false
		if (param.type === "string") return ""
		if (param.type === "bytes") return "0x"
		if (param.type.startsWith("bytes")) return "0x" + "00".repeat(Number(param.type.slice(5)))
		return 0n
	}
	const mutation = new Map([
		["grantRole", "grant"],
		["takeoverPartyALiquidation", "takeover"],
		["applyClearingHouseSettlement", "payment"],
		["settlePartyATakeover", "finalize"],
		["revokeRole", "cleanup"],
	])
	const provider: any = {
		getNetwork: async () => ({ chainId: BigInt(input.chainId) }),
		getBlock: async (tag: any) => block(tag === "latest" ? height : Number(tag)),
		getBlockNumber: async () => height,
		getCode: async () => "0x60016000",
		getTransactionCount: async () => nonce,
		estimateGas: async (request: any) => {
			assert.equal(request.from, input.operator)
			return 100000n
		},
		getFeeData: async () => ({ maxFeePerGas: 4n, maxPriorityFeePerGas: 1n, gasPrice: 2n }),
		getTransaction: async (hash: string) => txs.get(hash),
		getTransactionReceipt: async (hash: string) => receipts.get(hash),
		getLogs: async ({ fromBlock, toBlock }: any) =>
			s.logs
				.filter(() => fromBlock <= 950 && toBlock >= 950)
				.map((l: any, i: number) => ({
					...event(
						"QuoteLiquidationFundingCalculated",
						iface.getEvent("QuoteLiquidationFundingCalculated")!.inputs.map((p: any) => value(p, l[p.name])),
					),
					blockNumber: 950,
					index: i,
					transactionHash: "0x" + "ab".repeat(32),
				})),
		call: async (request: any) => {
			const api = request.to.toLowerCase() === input.core.toLowerCase() ? iface : layer.interface
			const parsed = api.parseTransaction(request)!,
				fn = parsed.name,
				args = parsed.args.toArray()
			if (mutation.has(fn)) {
				assert.equal(request.from, input.operator)
				return "0x"
			}
			assert(request.blockTag !== undefined, `Unpinned ${fn}`)
			const b = s.parties[0]
			const fields: Record<string, any> = {
				getOwner: s.owner,
				getCollateral: s.collateral,
				getAffiliateHook: s.hook,
				isRoleAdmin: s.admin,
				hasRole: s.role,
				isPartyALiquidated: s.liquidated,
				getLiquidatedStateOfPartyA: s.detail,
				getPartyATakeoverDetails: s.takeover,
				allocatedBalanceOfPartyA: s.allocated,
				balanceOf: args[0] === input.partyA ? s.balance : s.parentBalance,
				partyAReimbursement: s.reimbursement,
				getPartyADeferredBalance: s.deferred,
				partyAPositionsCount: s.open,
				partyAPendingQuotesCount: s.pending,
				pauseState: s.pause,
				getVirtualAccount: s.virtual,
				getSubAccount: s.parent,
				getSettlementStates: [b.settlement],
				isCrossPartyB: b.cross,
				isPartyB: b.registered,
				isPartyBLiquidated: b.liquidated,
				getPartyBCrossLiquidationStatus: b.crossLiquidated,
				allocatedBalanceOfPartyB: b.allocation,
				getQuote: s.quotes.find((q: any) => q.id === String(args[0])),
				facetAddress: input.core,
				facets: [{ facetAddress: input.core, functionSelectors: ["0x12345678"] }],
			}
			assert(fn in fields, `Unexpected read ${fn}`)
			const fragment = api.getFunction(fn)!
			const outputs =
				fragment.outputs!.length === 1
					? [value(fragment.outputs![0], fields[fn])]
					: fragment.outputs!.map((p: any, i: number) => value(p, fields[fn][p.name] ?? fields[fn][i]))
			return api.encodeFunctionResult(fragment, outputs)
		},
	}
	const signer = {
		getAddress: async () => input.operator,
		sendTransaction: async (request: any) => {
			const phase = mutation.get(iface.parseTransaction(request)!.name)!
			assert.equal(report.operations[phase].status, "prepared")
			assert.equal(saved.at(-1).operations[phase].status, "prepared")
			assert.equal(request.gasLimit, 120000n)
			assert.equal(request.maxFeePerGas, 4n)
			assert.equal(request.maxPriorityFeePerGas, 1n)
			assert.equal(request.chainId, input.chainId)
			const p = report.plan,
				logs: any[] = []
			if (phase === "grant" || phase === "cleanup") {
				s.role = phase === "grant"
				logs.push(event(phase === "grant" ? "RoleGranted" : "RoleRevoked", [ROLE, input.operator]))
			} else if (phase === "takeover") {
				s.detail.disputed = false
				s.detail.liquidationFee = "0"
				s.takeover.inProgress = true
				s.takeover.liquidationId = p.liquidationId
				logs.push(event("TakeoverPartyALiquidation", [input.partyA, p.liquidationId, height]))
			} else if (phase === "payment") {
				s.allocated = String(BigInt(s.allocated) - BigInt(p.total))
				s.parties[0].allocation = String(BigInt(s.parties[0].allocation) + BigInt(p.solverTotal))
				const amounts = new Map<string, { row: any[]; amount: bigint }>()
				for (const row of p.actions.find((a: any) => a.phase === phase).args[1]) {
					logs.push(event("ClearingHouseSettlementComponent", [input.partyA, row[0], row[2], row[1], ...row.slice(3)]))
					const key = row.slice(0, 2).join(":")
					amounts.set(key, { row, amount: (amounts.get(key)?.amount || 0n) + row.slice(3).reduce((a: bigint, b: string) => a + BigInt(b), 0n) })
				}
				for (const { row, amount } of amounts.values()) logs.push(event("ClearingHouseAccountSettlement", [input.partyA, row[0], row[1], amount]))
			} else {
				s.liquidated = false
				s.takeover.inProgress = false
				s.takeover.liquidationId = "0x"
				s.detail = { liquidationId: "0x", disputed: false }
				s.virtual.isExists = badFinal
				s.parties[0].settlement = { pending: false, actualAmount: "0", expectedAmount: "0", cva: "0" }
				s.allocated = "0"
				s.parentBalance = String(BigInt(s.parentBalance) + BigInt(p.residual))
				logs.push(event("SettlePartyATakeover", [input.partyA, p.liquidationId]))
				logs.push(event("InternalTransferToBalance", [input.partyA, s.virtual.parentAccount, s.parentBalance, p.residual]))
			}
			sends++
			const hash = "0x" + sends.toString(16).padStart(64, "0")
			const receipt: any = { hash, status: 1, blockNumber: ++height, blockHash: block(height).hash, logs, gasUsed: 90000n, gasPrice: 2n }
			const tx: any = {
				...request,
				from: input.operator,
				hash,
				nonce: nonce++,
				provider,
				wait: async () => {
					if (failWait) throw new Error("simulated receipt timeout")
					return receipt
				},
			}
			txs.set(hash, tx)
			receipts.set(hash, receipt)
			return tx
		},
	}
	const run = (phase: string, extra: any = {}) =>
		runSettlementPhase({ provider, input, report, phase, signer, root, save: () => saved.push(structuredClone(report)), ...extra })
	const inspect = async () => {
		await run("inspect")
		report.approvedDigest = report.plan.digest
	}
	return {
		input,
		s,
		report,
		provider,
		signer,
		run,
		inspect,
		saved,
		sends: () => sends,
		timeout: (v: boolean) => {
			failWait = v
		},
		incorrectFinal: () => {
			badFinal = true
		},
	}
}

test("runtime previews without signing, checks authority/approval, then settles with explicit Ledger fees and no duplicate writes", async () => {
	const h = harness()
	await h.run("inspect")
	assert.equal(h.report.plan.solverTotal, "3442572744357476090")
	await h.run("grant")
	assert.equal(h.sends(), 0)
	await assert.rejects(h.run("grant", { execute: true }), /not approved/)
	h.report.approvedDigest = h.report.plan.digest
	await assert.rejects(h.run("grant", { execute: true, signer: { getAddress: async () => h.input.partyA } }), /not the operator/)
	await assert.rejects(h.run("payment", { execute: true }), /reviewed order/)
	for (const a of h.report.plan.actions) await h.run(a.phase, { execute: true })
	await h.run("verify")
	assert.equal(h.report.completed, true)
	assert.equal(h.report.proofs.payment.snapshot.allocated, h.report.plan.residual)
	assert.equal(h.sends(), 5)
	assert.equal(h.s.role, false)
	assert.equal(h.s.parentBalance, "579974554669831766")
	for (const a of h.report.plan.actions) await h.run(a.phase, { execute: true })
	await h.run("verify")
	assert.equal(h.sends(), 5)
})

test("runtime reconciles a payment mined before timeout and resumes without paying twice", async t => {
	const h = harness()
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dispute-events-"))
	const eventsFile = path.join(directory, "events.ndjson"),
		fd = fs.openSync(eventsFile, "w"),
		previousFd = process.env.SYMMIO_TASK_EVENT_FD
	process.env.SYMMIO_TASK_EVENT_FD = String(fd)
	t.after(() => {
		if (previousFd === undefined) delete process.env.SYMMIO_TASK_EVENT_FD
		else process.env.SYMMIO_TASK_EVENT_FD = previousFd
		fs.closeSync(fd)
		fs.rmSync(directory, { recursive: true, force: true })
	})
	await h.inspect()
	for (const phase of ["grant", "takeover"]) await h.run(phase, { execute: true })
	h.timeout(true)
	await assert.rejects(h.run("payment", { execute: true }), /simulated receipt timeout/)
	assert.equal(h.report.operations.payment.status, "submitted")
	h.timeout(false)
	await h.run("payment", { execute: true })
	const recoveredEvents = fs
		.readFileSync(eventsFile, "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line))
	assert(
		recoveredEvents.some(
			e => e.type === "tx.confirmed" && e.detail.transaction.hash === h.report.operations.payment.hash && e.detail.transaction.status === "confirmed",
		),
	)
	for (const phase of ["finalize", "cleanup", "verify"]) await h.run(phase, { execute: true })
	assert.equal(h.report.completed, true)
	assert.equal(h.sends(), 5)
})

test("successful receipts do not hide incorrect account cleanup", async () => {
	const h = harness()
	await h.inspect()
	for (const phase of ["grant", "takeover", "payment"]) await h.run(phase, { execute: true })
	h.incorrectFinal()
	await assert.rejects(h.run("finalize", { execute: true }), /cleanup is incomplete/)
	await assert.rejects(h.run("cleanup", { execute: true }), /cleanup is incomplete/)
	assert.equal(h.sends(), 4)
	assert.notEqual(h.report.completed, true)
})

test("runtime refuses chain, source and account economics drift before signing", async () => {
	const h = harness()
	await h.inspect()
	const previous = h.report.sourceDigest
	h.report.sourceDigest = "changed"
	await assert.rejects(h.run("grant", { execute: true }), /source changed/)
	h.report.sourceDigest = previous
	h.s.allocated = "1"
	await assert.rejects(h.run("grant", { execute: true }), /allocation differs/)
	h.provider.getNetwork = async () => ({ chainId: 1n })
	await assert.rejects(h.run("grant", { execute: true }), /chain differs/)
	assert.equal(h.sends(), 0)
})
