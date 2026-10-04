import { ZeroAddress } from "ethers"
import assert from "node:assert/strict"
import test from "node:test"

import { coreInterface as api, tokenInterface as token, digest, runWithdrawalPhase } from "../../deployment-tooling/core-withdrawal.js"
import { completeGovernanceTransactionRequest } from "../../tasks/deploy/governanceActions.js"
import { send } from "../../tasks/deploy/tx.js"

function harness(classic = false, decimals = 18) {
	const account = "0x1111111111111111111111111111111111111111",
		core = "0x2222222222222222222222222222222222222222",
		collateral = "0x3333333333333333333333333333333333333333",
		facet = "0x4444444444444444444444444444444444444444"
	const input = {
		schema: 1,
		network: "localhost",
		chainId: 31337,
		core,
		account,
		recipient: account,
		amount: "all",
		action: "all",
		route: "auto",
		muonUrl: "https://muon.example/",
	}
	let height = 1000,
		time = 1000,
		free = 0n,
		allocated = 10n ** 19n,
		nonce = 7,
		last = 0,
		cooldown = 100,
		request: any = null,
		sends = 0,
		fetches = 0,
		failWait = false,
		badEvent = false,
		reject = false,
		unknown = false
	let offsets: number[] = [],
		waits = 0,
		estimateDelay = 0,
		simulationDelay = 0
	let mutateMuon = (_response: any) => {}
	const txs = new Map(),
		receipts = new Map(),
		saved: any[] = []
	const report: any = { schema: 1, inputDigest: digest(input), operations: {}, actions: {} }
	const block = (n: number) => ({ number: n, timestamp: time, hash: "0x" + n.toString(16).padStart(64, "0") })
	const log = (name: string, args: any[], iface = api, address = core) => ({ address, ...iface.encodeEventLog(iface.getEvent(name), args) })
	const provider: any = {
		getNetwork: async () => ({ chainId: 31337n }),
		getBlock: async (tag: any) => block(tag === "latest" ? height : Number(tag)),
		getBlockNumber: async () => height,
		getCode: async (a: string) => (a.toLowerCase() === account ? "0x" : "0x60016000"),
		getTransactionCount: async () => nonce,
		getTransaction: async (h: string) => txs.get(h),
		getTransactionReceipt: async (h: string) => receipts.get(h),
		estimateGas: async (r: any) => {
			assert.equal(r.from, account)
			time += estimateDelay
			estimateDelay = 0
			return 100000n
		},
		getFeeData: async () => ({ maxFeePerGas: 4n, maxPriorityFeePerGas: 1n, gasPrice: 2n }),
		call: async (r: any) => {
			const iface = r.to === collateral ? token : api,
				p = iface.parseTransaction(r),
				name = p.name,
				args = p.args
			if (["deallocate", "initiateWithdraw", "withdrawTo", "finalizeWithdrawRequest"].includes(name)) {
				assert.equal(r.from, account)
				if (name === "deallocate") {
					time += simulationDelay
					simulationDelay = 0
					if (time > Number(args[1].timestamp) + 60) throw new Error("LibMuon: Expired signature")
					assert(BigInt(args[0]) <= allocated)
					assert.equal(args[1].upnl, 0n)
				}
				if (name === "withdrawTo" && args[1] > 0n) {
					assert(time >= last + cooldown)
					assert(free >= args[1] * 10n ** BigInt(18 - decimals))
				}
				if (name === "finalizeWithdrawRequest") {
					assert.equal(request.status, 0)
					assert(time >= request.cooldownEndTime)
				}
				return name === "initiateWithdraw" ? api.encodeFunctionResult(name, [1, Math.max(time, last + cooldown)]) : "0x"
			}
			assert.notEqual(r.blockTag, undefined, `unpinned ${name}`)
			if (name === "facetAddress") {
				const fn = api.getFunction(args[0]).name
				return api.encodeFunctionResult(name, [
					["initiateWithdraw", "finalizeWithdrawRequest", "getWithdrawRequests"].includes(fn) && !classic
						? ZeroAddress
						: ["getMuonFunctionUpnlValidTime"].includes(fn)
							? ZeroAddress
							: facet,
				])
			}
			const values: any = {
				getCollateral: [collateral],
				balanceOf: [free],
				balanceInfoOfPartyA: [allocated, ...Array(8).fill(0n)],
				nonceOfPartyA: [3],
				getMuonConfig: [60, 60],
				withdrawCooldownOf: [last],
				deallocateCooldown: [cooldown],
				isSuspended: [false],
				isPartyB: [false],
				isLegacyDeallocateDeprecated: [false],
				decimals: [decimals],
				getWithdrawRequests: [request],
			}
			assert(values[name], name)
			return iface.encodeFunctionResult(name, values[name])
		},
	}
	const signer: any = {
		getAddress: async () => account,
		sendTransaction: async (r: any) => {
			assert(r.gasLimit && r.maxFeePerGas && r.maxPriorityFeePerGas, "explicit gas/fees before signing")
			if (reject) throw Object.assign(new Error("device rejected"), { code: "ACTION_REJECTED" })
			if (unknown) throw new Error("connection lost after signing")
			sends++
			height++
			const p = api.parseTransaction(r),
				name = p.name,
				args = p.args
			let logs: any[] = []
			if (name === "deallocate") {
				allocated -= args[0]
				free += args[0]
				last = time
				logs = [log("DeallocatePartyA", [account, args[0], allocated])]
			}
			if (name === "initiateWithdraw") {
				free -= args[0][0].amount * 10n ** BigInt(18 - decimals)
				request = {
					id: 1,
					user: account,
					parts: args[0].toArray(),
					timestamp: time,
					cooldownEndTime: Math.max(time, last + cooldown),
					status: 0,
					speedUp: false,
					isCooldownModified: false,
					provider: ZeroAddress,
					isPureVirtual: false,
					providerData: "0x",
					totalAmount: args[0][0].amount,
					totalVirtualAmount: 0,
					advancedAmount: 0,
				}
				logs = [log("WithdrawInitiated", [1, account, args[0], false, "0x", request.cooldownEndTime])]
			}
			if (name === "withdrawTo" || name === "finalizeWithdrawRequest") {
				const amount = name === "withdrawTo" ? args[1] : BigInt(request.totalAmount)
				if (name === "withdrawTo") free -= amount * 10n ** BigInt(18 - decimals)
				else request.status = 3
				logs = [log("Withdraw", [account, account, amount]), log("Transfer", [core, account, badEvent ? amount - 1n : amount], token, collateral)]
			}
			const hash = "0x" + String(sends).padStart(64, "0"),
				receipt: any = { hash, status: 1, blockNumber: height, blockHash: block(height).hash, gasUsed: 100000n, gasPrice: 2n, logs }
			receipts.set(hash, receipt)
			const tx = {
				provider,
				...r,
				from: account,
				hash,
				chainId: 31337n,
				nonce: nonce++,
				wait: async () => {
					if (failWait) throw new Error("receipt timed out")
					return receipt
				},
			}
			txs.set(hash, tx)
			return tx
		},
	}
	const fetchImpl = async () => {
		fetches++
		const timestamp = time + (offsets.shift() || 0)
		return {
			ok: true,
			json: async () => {
				const response = {
					success: true,
					result: {
						confirmed: true,
						app: "symmio",
						method: "uPnl_A",
						reqId: "0x1234",
						data: {
							timestamp,
							result: { chainId: "31337", symmio: core, partyA: account, nonce: "3", uPnl: "0" },
							init: { nonceAddress: account },
						},
						shieldSignature: "0x" + "01".repeat(65),
						signatures: [{ signature: "0x" + "02".repeat(32), owner: account }],
					},
				}
				mutateMuon(response)
				return response
			},
		}
	}
	const run = (phase: string, execute = false, transaction?: string) =>
		runWithdrawalPhase({
			provider,
			input,
			report,
			phase,
			execute,
			transaction,
			save: () => saved.push(structuredClone(report)),
			signer,
			completeRequest: completeGovernanceTransactionRequest,
			send,
			fetchImpl,
			wait: async () => {
				waits++
				time++
				height++
			},
		})
	return {
		input,
		report,
		run,
		provider,
		txs,
		receipts,
		saved,
		signer,
		stats: () => ({ sends, fetches, free, allocated, waits }),
		advance: (seconds = 101) => {
			time += seconds
			height++
		},
		approve: () => (report.approvedDigest = report.plan.digest),
		timeout: (b = true) => (failWait = b),
		badEvent: () => (badEvent = true),
		reject: () => (reject = true),
		unknown: () => (unknown = true),
		drift: () => free++,
		offsets: (values: number[]) => (offsets = values),
		mutateMuon: (fn: (response: any) => void) => (mutateMuon = fn),
		delayEstimate: (seconds: number) => (estimateDelay = seconds),
		delaySimulation: (seconds: number) => (simulationDelay = seconds),
	}
}

test("legacy dry run, cooldown, withdrawal, proof and completed replay", async () => {
	const h = harness()
	await h.run("inspect")
	await h.run("deallocate")
	assert.equal(h.stats().sends, 0)
	h.approve()
	await h.run("deallocate", true)
	await h.run("ready")
	assert.equal(h.report.readiness.ready, false)
	await assert.rejects(h.run("withdraw", true), /cooldown/)
	h.advance()
	await h.run("withdraw", true)
	await h.run("verify")
	assert(h.report.completed)
	assert.equal(h.stats().sends, 2)
	await h.run("deallocate", true)
	await h.run("withdraw", true)
	assert.equal(h.stats().sends, 2)
	assert.equal(h.stats().allocated, 0n)
	assert.equal(h.stats().free, 0n)
})
test("classic six-decimal collateral request resumes through finalization", async () => {
	const h = harness(true, 6)
	await h.run("inspect")
	h.approve()
	await h.run("deallocate", true)
	await h.run("initiate", true)
	assert.equal(h.report.request.id, "1")
	assert.equal(h.report.plan.withdrawToken, "10000000")
	await h.run("ready")
	assert(!h.report.readiness.ready)
	h.advance()
	await h.run("withdraw", true)
	await h.run("verify")
	assert(h.report.completed)
	assert.equal(h.stats().sends, 3)
})
test("timeout after submission reconciles without a new signature or duplicate send", async () => {
	const h = harness()
	await h.run("inspect")
	h.approve()
	h.timeout()
	await assert.rejects(h.run("deallocate", true), /timed out/)
	assert.equal(h.report.operations.deallocate.status, "submitted")
	h.timeout(false)
	await h.run("deallocate", true)
	assert.equal(h.stats().sends, 1)
	assert.equal(h.stats().fetches, 1)
})
test("unknown pre-hash outcome never retries; explicit device rejection is retryable", async () => {
	const h = harness()
	await h.run("inspect")
	h.approve()
	h.unknown()
	await assert.rejects(h.run("deallocate", true), /connection lost/)
	h.advance()
	await assert.rejects(h.run("deallocate", true), /no automatic resend/)
	assert.equal(h.stats().fetches, 1)
	assert.equal(h.report.operations.deallocate.status, "prepared")
	const r = harness()
	await r.run("inspect")
	r.approve()
	r.reject()
	await assert.rejects(r.run("deallocate", true), /device rejected/)
	assert.equal(r.report.operations.deallocate, undefined)
})
test("wrong amount token event, balance drift and unapproved send fail closed", async () => {
	const h = harness()
	await h.run("inspect")
	await assert.rejects(h.run("deallocate", true), /not been approved/)
	assert.equal(h.stats().sends, 0)
	h.approve()
	await h.run("deallocate", true)
	h.advance()
	h.badEvent()
	await assert.rejects(h.run("withdraw", true), /collateral transfer/)
	assert(!h.report.completed)
	const d = harness()
	await d.run("inspect")
	d.approve()
	d.drift()
	await assert.rejects(d.run("deallocate", true), /balances changed/)
	assert.equal(d.stats().sends, 0)
})
test("same-intent replacement succeeds; changed recipient and reverted receipts cannot continue", async () => {
	for (const bad of ["none", "recipient", "reverted"]) {
		const h = harness()
		await h.run("inspect")
		h.approve()
		h.timeout()
		await assert.rejects(h.run("deallocate", true))
		const original = h.report.operations.deallocate.hash,
			replacement = "0x" + "ab".repeat(32),
			tx = { ...h.txs.get(original), hash: replacement },
			receipt = { ...h.receipts.get(original), hash: replacement }
		if (bad === "recipient") tx.to = h.input.account
		if (bad === "reverted") receipt.status = 0
		h.txs.set(replacement, tx)
		h.receipts.set(replacement, receipt)
		h.timeout(false)
		if (bad === "none") {
			await h.run("deallocate", false, replacement)
			assert.equal(h.report.operations.deallocate.hash, replacement)
		} else await assert.rejects(h.run("deallocate", false, replacement))
		assert.equal(h.stats().sends, 1)
	}
})

test("classic flow waits out preconfirmed receipts for every transaction without duplicate sends", async () => {
	const h = harness(true, 6)
	const originalReceipt = h.provider.getTransactionReceipt
	const reads = new Map<string, number>()
	h.provider.getTransactionReceipt = async (hash: string) => {
		const receipt = await originalReceipt(hash)
		const count = (reads.get(hash) || 0) + 1
		reads.set(hash, count)
		return receipt && count === 1 ? { ...receipt, blockHash: "0x" + "00".repeat(32) } : receipt
	}
	await h.run("inspect")
	h.approve()
	await h.run("deallocate", true)
	await h.run("initiate", true)
	await h.run("ready")
	assert.equal(h.report.readiness.ready, false)
	h.advance()
	await h.run("withdraw", true)
	await h.run("verify")
	assert.equal(h.report.completed, true)
	assert.equal(h.stats().sends, 3)
	for (const phase of ["deallocate", "initiate", "withdraw"]) assert(h.report.proofs[phase].eventsVerified)
	await h.run("withdraw", true)
	assert.equal(h.stats().sends, 3)
})

test("expired and nearly expired Muon responses are journaled and refreshed before a single send", async () => {
	for (const offset of [-61, -46]) {
		const h = harness()
		await h.run("inspect")
		h.approve()
		h.offsets([offset, 0])
		await h.run("deallocate", true)
		assert.equal(h.stats().fetches, 2)
		assert.equal(h.stats().sends, 1)
		assert.equal(h.report.muonAttempts[0].timing.reason, offset === -61 ? "expired" : "near_expiry")
		assert.equal(h.report.muonAttempts[0].response.result.data.timestamp, 1000 + offset)
		assert.equal(h.report.muon.expiresAt, h.report.muon.signature.timestamp + 60)
		assert.equal(h.report.muon.refreshAt, h.report.muon.expiresAt - 15)
		assert.equal(h.report.operations.deallocate.status, "confirmed")
	}
})
test("persistent stale Muon responses stop after three fetches without a prepared transaction", async () => {
	const h = harness()
	await h.run("inspect")
	h.approve()
	h.offsets([-61, -61, -61])
	await assert.rejects(h.run("deallocate", true), /expired/)
	assert.equal(h.stats().fetches, 3)
	assert.equal(h.stats().sends, 0)
	assert.equal(h.report.operations.deallocate, undefined)
	assert.equal(h.report.muonAttempts.length, 3)
	assert(h.report.muonAttempts.every((attempt: any) => attempt.error && attempt.timing.reason === "expired"))
})
test("signature nearing expiry during gas completion is refreshed with new calldata before journaling", async () => {
	const h = harness()
	await h.run("inspect")
	h.approve()
	h.delayEstimate(46)
	await h.run("deallocate", true)
	assert.equal(h.stats().fetches, 2)
	assert.equal(h.stats().sends, 1)
	assert.equal(h.report.muonAttempts[0].stage, "before_submit")
	assert.equal(h.report.muonAttempts[0].timing.reason, "near_expiry")
	const tx = h.txs.get(h.report.operations.deallocate.hash)
	assert.equal(Number(api.parseTransaction(tx)!.args[1].timestamp), h.report.muon.signature.timestamp)
	assert(h.report.muon.signature.timestamp > 1000)
	assert(h.saved.filter(s => s.operations.deallocate).every(s => s.muon.signature.timestamp > 1000))
})
test("expiry during simulation refreshes, but unrelated simulation errors do not", async () => {
	const h = harness()
	await h.run("inspect")
	h.approve()
	h.delaySimulation(61)
	await h.run("deallocate", true)
	assert.equal(h.stats().fetches, 2)
	assert.equal(h.stats().sends, 1)
	const b = harness()
	await b.run("inspect")
	b.approve()
	const call = b.provider.call
	b.provider.call = async (request: any) => {
		if (request.from) throw new Error("insufficient headroom")
		return call(request)
	}
	await assert.rejects(b.run("deallocate", true), /insufficient headroom/)
	assert.equal(b.stats().fetches, 1)
	assert.equal(b.stats().sends, 0)
})
test("small oracle clock lead waits for chain time; large future timestamps exhaust bounded refreshes", async () => {
	const h = harness()
	await h.run("inspect")
	h.approve()
	h.offsets([2])
	await h.run("deallocate", true)
	assert.equal(h.stats().fetches, 1)
	assert.equal(h.stats().waits, 2)
	assert.equal(h.stats().sends, 1)
	const b = harness()
	await b.run("inspect")
	b.approve()
	b.offsets([20, 20, 20])
	await assert.rejects(b.run("deallocate", true), /future/)
	assert.equal(b.stats().fetches, 3)
	assert.equal(b.stats().sends, 0)
	assert.equal(b.report.operations.deallocate, undefined)
})
test("identity, nonce and malformed responses are saved but never automatically retried", async () => {
	for (const mutate of [
		(response: any) => (response.result.data.result.nonce = "4"),
		(response: any) => (response.result.data.result.chainId = "1"),
		(response: any) => {
			response.result.shieldSignature = "0x"
			response.result.data.timestamp = 1
		},
	]) {
		const h = harness()
		await h.run("inspect")
		h.approve()
		h.mutateMuon(mutate)
		await assert.rejects(h.run("deallocate", true))
		assert.equal(h.stats().fetches, 1)
		assert.equal(h.stats().sends, 0)
		assert(h.report.muonAttempts[0].response)
		assert(h.report.muonAttempts[0].error)
	}
})

test("freshness uses the latest chain clock after slow pinned-state reads", async () => {
	const h = harness()
	await h.run("inspect")
	h.approve()
	const call = h.provider.call
	let slow = true
	h.provider.call = async (request: any) => {
		const result = await call(request)
		if (slow && api.parseTransaction(request)?.name === "nonceOfPartyA") {
			slow = false
			h.advance(46)
		}
		return result
	}
	// The first snapshot precedes fetching; only delay the snapshot after a response exists.
	const delayed = h.provider.call
	h.provider.call = async (request: any) => (h.stats().fetches ? delayed(request) : call(request))
	await h.run("deallocate", true)
	assert.equal(h.stats().fetches, 2)
	assert.equal(h.stats().sends, 1)
	assert.equal(h.report.muonAttempts[0].timing.remainingSeconds, 14)
})
test("a changed Core account nonce during gas preparation stops before journaling", async () => {
	const h = harness()
	await h.run("inspect")
	h.approve()
	let changed = false
	const estimate = h.provider.estimateGas
	h.provider.estimateGas = async (request: any) => {
		changed = true
		return estimate(request)
	}
	const call = h.provider.call
	h.provider.call = async (request: any) => {
		if (changed && api.parseTransaction(request)?.name === "nonceOfPartyA") return api.encodeFunctionResult("nonceOfPartyA", [4])
		return call(request)
	}
	await assert.rejects(h.run("deallocate", true), /nonce is stale/)
	assert.equal(h.stats().fetches, 1)
	assert.equal(h.stats().sends, 0)
	assert.equal(h.report.operations.deallocate, undefined)
})
