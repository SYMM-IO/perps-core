import { expect } from "chai"
import { TypedDataDomain, toUtf8Bytes } from "ethers"

import type { InstantLayer } from "../../src/types/index.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"
import { limitOpenRequestBuilder, OpenRequest } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder, QuoteRequest } from "../models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "../utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "../utils/SignatureUtils.js"

// ════════════════════════════════════════════════════════════════════════════════
// Gas benchmark for the full production InstantOpen flow:
//   addMarginToNextVA → sendQuote → lockQuote → openPosition
// executed atomically through InstantLayer.executeTemplate with the SymmioPartyB
// wrapper, AccountLayer routing (fresh virtual account per position), affiliate +
// system hooks, and instantOpenMode enabled.
//
// Each scenario runs the flow twice: run #1 warms global one-time state
// (lastId, counters, fee collector balance, partyB nonces, ...) so run #2 is
// production-equivalent (every InstantOpen in production creates a fresh VA but
// global counters are long since non-zero).
// ════════════════════════════════════════════════════════════════════════════════

const ROLES = {
	SETTER_ROLE: ethers.keccak256(toUtf8Bytes("SETTER_ROLE")),
	TRUSTED_ROLE: ethers.keccak256(toUtf8Bytes("TRUSTED_ROLE")),
	INSTANT_LAYER_ROLE: ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")),
}

const MARGIN_AMOUNT = decimal(1000n)

interface BenchEnv {
	context: RunContext
	subAccount: string
	affiliate: string
	partyBAddress: string
	domain: TypedDataDomain
	types: ReturnType<typeof cloneTypes>
	templateId4: bigint // addMargin + send + lock + open
	templateId3: bigint // send + lock + open (no addMargin)
	templateIdCombined: bigint // addMargin + send + lockAndOpenPosition
	templateId2: bigint // _callWithMargin(send) + lockAndOpenPosition
	requestSendQuote: QuoteRequest
	requestOpenQuote: OpenRequest
}

function generateSalt(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

function signedOp(
	signer: string,
	target: string,
	callData: string,
	signerAccount: InstantLayer.AccountStruct,
	deadline: bigint,
): InstantLayer.SignedOperationStruct {
	return {
		signer,
		target,
		callData,
		signerAccount,
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce: 0n, deadline, salt: generateSalt() },
	}
}

async function setupBench(opts: {
	affiliateHook: "accountLayer" | "mock" | "none"
	systemHook: "noop" | "accountLayer" | "none"
	bind?: boolean // default true (bound fast-path). false = unbound Muon path with cross partyB funding
}): Promise<BenchEnv> {
	const bind = opts.bind ?? true
	const context = await loadFixture(initializeFixture)
	const user = context.signers.user
	const partyBSigner = context.signers.hedger
	const partyBAddress = await context.symmioPartyB.getAddress()
	const affiliate = await context.accountManager.getAddress()

	// ── Core-side roles / registration (mirrors production ops config) ──
	await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)
	await context.controlFacet.connect(context.signers.admin).registerPartyB(partyBAddress)
	await context.controlFacet.connect(context.signers.admin).setPartyBBindable(partyBAddress, true)
	await context.symbolControlFacet.whitelistSymbolType(partyBAddress, 1)

	// ── Hooks ──
	if (opts.affiliateHook === "accountLayer") {
		await context.controlFacet.connect(context.signers.admin).registerHook(affiliate, context.accountLayerDiamond)
	} else if (opts.affiliateHook === "mock") {
		const MockHook = await ethers.getContractFactory("MockHook")
		const mockHook = await MockHook.deploy()
		await mockHook.waitForDeployment()
		await context.controlFacet.connect(context.signers.admin).registerHook(affiliate, await mockHook.getAddress())
	}
	if (opts.systemHook === "noop") {
		const BenchNoopHook = await ethers.getContractFactory("BenchNoopHook")
		const noopHook = await BenchNoopHook.deploy()
		await noopHook.waitForDeployment()
		await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await noopHook.getAddress())
	} else if (opts.systemHook === "accountLayer") {
		await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, context.accountLayerDiamond)
	}

	// ── InstantLayer config ──
	await context.instantLayer.registerPartyBs([partyBAddress])
	await context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await context.signers.admin.getAddress())
	await context.symmioPartyB.setSigner(partyBSigner.address)

	// ── Sub-account with POSITION isolation (fresh VA per position — production shape) ──
	const creationData = [
		{
			name: "bench",
			metadata: "0x",
			symmioCore: context.diamond,
			isolationType: 0, // SubAccountIsolationType.POSITION
			singleVAMode: false,
		},
	]
	const predicted = await context.alCoreFacet.connect(user).createSubAccounts.staticCall(affiliate, creationData)
	await context.alCoreFacet.connect(user).createSubAccounts(affiliate, creationData)
	const subAccount = predicted[0]

	// ── Fund the sub-account's deposited balance on core ──
	await context.collateral.connect(user).mint(user.address, decimal(100000n))
	await context.collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
	await context.accountFacet.connect(user).depositFor(subAccount, decimal(10000n))

	if (bind) {
		// ── Bind the sub-account to the SymmioPartyB (bound fast-path) ──
		const bindCd = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [partyBAddress])
		await context.alCoreFacet.connect(user)._call(subAccount, [bindCd])
	} else {
		// ── Unbound: fund the partyB cross bucket so Muon-path solvency checks pass ──
		await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(true)
		await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyBAddress, true)
		await context.accountFacet.connect(user).depositFor(partyBAddress, decimal(10000n))
		const allocateCd = context.partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [decimal(10000n), ethers.ZeroAddress])
		await context.symmioPartyB.connect(context.signers.admin)._call([allocateCd])
	}

	// ── Templates ──
	await context.instantLayer.addTemplate("bench-addMargin-send-lock-open", [
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }, // addMarginToNextVA
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }, // sendQuote
		{ insertionPoints: [0], sourceIndices: [1], sourceOffsets: [0] }, // lockQuote(quoteId ← op1)
		{ insertionPoints: [0], sourceIndices: [1], sourceOffsets: [0] }, // openPosition(quoteId ← op1)
	])
	const templateId4 = (await context.instantLayer.getNextTemplateId()) - 1n
	await context.instantLayer.setTemplateInstantOpenMode(templateId4, true)

	await context.instantLayer.addTemplate("bench-send-lock-open", [
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
		{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
		{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
	])
	const templateId3 = (await context.instantLayer.getNextTemplateId()) - 1n
	await context.instantLayer.setTemplateInstantOpenMode(templateId3, true)

	await context.instantLayer.addTemplate("bench-addMargin-send-lockAndOpen", [
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }, // addMarginToNextVA
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }, // sendQuote
		{ insertionPoints: [0], sourceIndices: [1], sourceOffsets: [0] }, // lockAndOpenPosition(quoteId ← op1)
	])
	const templateIdCombined = (await context.instantLayer.getNextTemplateId()) - 1n
	await context.instantLayer.setTemplateInstantOpenMode(templateIdCombined, true)

	// op0 targets the AL directly, so its result is the raw abi-encoded bytes[]:
	// [0x20][len=1][0x20][elemLen=32][quoteId] → quoteId lives at byte offset 128
	await context.instantLayer.addTemplate("bench-callWithMargin-lockAndOpen", [
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }, // _callWithMargin(sendQuote)
		{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [128] }, // lockAndOpenPosition(quoteId ← op0)
	])
	const templateId2 = (await context.instantLayer.getNextTemplateId()) - 1n
	await context.instantLayer.setTemplateInstantOpenMode(templateId2, true)

	const requestSendQuote = limitQuoteRequestBuilder().partyBWhiteList([partyBAddress]).affiliate(affiliate).build()
	const requestOpenQuote = limitOpenRequestBuilder().build()

	const domain: TypedDataDomain = {
		name: "SymmioInstantLayer",
		version: "1",
		chainId: (await ethers.provider.getNetwork()).chainId,
		verifyingContract: await context.instantLayer.getAddress(),
	}

	return {
		context,
		subAccount,
		affiliate,
		partyBAddress,
		domain,
		types: cloneTypes(),
		templateId4,
		templateId3,
		templateIdCombined,
		templateId2,
		requestSendQuote,
		requestOpenQuote,
	}
}

async function buildOps(
	env: BenchEnv,
	includeAddMargin: boolean,
	opts?: { data?: string; userSigner?: any; combinedLockOpen?: boolean; mergedMargin?: boolean },
) {
	const { context, subAccount, partyBAddress, requestSendQuote, requestOpenQuote } = env
	const user = opts?.userSigner ?? context.signers.user
	const partyBSigner = context.signers.hedger
	const symmioAddress = context.diamond
	const accountLayerAddress = context.accountLayerDiamond
	const deadline = await getBlockTimestamp(300n)

	const addMarginCallData = context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [
		subAccount,
		0, // VirtualAccountIsolationType.POSITION
		requestSendQuote.symbolId,
		MARGIN_AMOUNT,
	])

	const quoteCallData =
		opts?.data !== undefined
			? context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliateAndData", [
					requestSendQuote.partyBWhiteList,
					requestSendQuote.symbolId,
					requestSendQuote.positionType,
					requestSendQuote.orderType,
					requestSendQuote.price,
					requestSendQuote.quantity,
					requestSendQuote.cva,
					requestSendQuote.lf,
					requestSendQuote.partyAmm,
					requestSendQuote.partyBmm,
					await requestSendQuote.deadline,
					requestSendQuote.affiliate,
					await requestSendQuote.upnlSig,
					opts.data,
				])
			: context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
					requestSendQuote.partyBWhiteList,
					requestSendQuote.symbolId,
					requestSendQuote.positionType,
					requestSendQuote.orderType,
					requestSendQuote.price,
					requestSendQuote.quantity,
					requestSendQuote.cva,
					requestSendQuote.lf,
					requestSendQuote.partyAmm,
					requestSendQuote.partyBmm,
					requestSendQuote.maxFundingRate,
					await requestSendQuote.deadline,
					requestSendQuote.affiliate,
					await requestSendQuote.upnlSig,
				])

	const lockQuoteCallData = context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [0, await getDummySingleUpnlSig(0n)])
	const openCallData = context.partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
		0,
		requestOpenQuote.filledAmount,
		requestOpenQuote.openPrice,
		await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n),
	])
	const lockAndOpenCallData = context.partyBExecutionFacet.interface.encodeFunctionData("lockAndOpenPosition", [
		0,
		requestOpenQuote.filledAmount,
		requestOpenQuote.openPrice,
		await getDummySingleUpnlSig(0n),
		await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n),
		0,
	])

	const userAccount: InstantLayer.AccountStruct = { addr: subAccount, isPartyB: false }
	const partyBAccount: InstantLayer.AccountStruct = { addr: partyBAddress, isPartyB: true }

	const ops: InstantLayer.SignedOperationStruct[] = []
	const signers: any[] = []

	if (opts?.mergedMargin) {
		const callWithMarginCallData = context.alCoreFacet.interface.encodeFunctionData("_callWithMargin", [
			subAccount,
			0, // VirtualAccountIsolationType.POSITION
			requestSendQuote.symbolId,
			MARGIN_AMOUNT,
			[quoteCallData],
		])
		ops.push(signedOp(user.address, accountLayerAddress, callWithMarginCallData, userAccount, deadline))
		signers.push(user)
	} else {
		if (includeAddMargin) {
			ops.push(signedOp(user.address, accountLayerAddress, addMarginCallData, userAccount, deadline))
			signers.push(user)
		}
		ops.push(signedOp(user.address, symmioAddress, quoteCallData, userAccount, deadline))
		signers.push(user)
	}
	if (opts?.combinedLockOpen) {
		ops.push(signedOp(partyBAddress, symmioAddress, lockAndOpenCallData, partyBAccount, deadline))
		signers.push(partyBSigner)
	} else {
		ops.push(signedOp(partyBAddress, symmioAddress, lockQuoteCallData, partyBAccount, deadline))
		signers.push(partyBSigner)
		ops.push(signedOp(partyBAddress, symmioAddress, openCallData, partyBAccount, deadline))
		signers.push(partyBSigner)
	}

	const sigs: string[] = []
	for (let i = 0; i < ops.length; i++) {
		sigs.push(await signers[i].signTypedData(env.domain, env.types, ops[i]))
	}

	return { ops, sigs }
}

async function runFlow(
	env: BenchEnv,
	templateId: bigint,
	includeAddMargin: boolean,
	opts?: { data?: string; userSigner?: any; viaMulticast?: boolean; combinedLockOpen?: boolean; mergedMargin?: boolean },
) {
	const { ops, sigs } = await buildOps(env, includeAddMargin, opts)
	const fills = ops.map(() => [])
	const flexSigs = ops.map(() => [])
	if (opts?.viaMulticast) {
		// Production entry: bot → SymmioPartyB._multicastCall → InstantLayer.executeTemplate
		const ilCd = env.context.instantLayer.interface.encodeFunctionData("executeTemplate", [templateId, ops, sigs, fills, flexSigs])
		const ilAddress = await env.context.instantLayer.getAddress()
		const tx = await env.context.symmioPartyB.connect(env.context.signers.admin)._multicastCall([ilAddress], [ilCd])
		const receipt = await tx.wait()
		return { tx, receipt: receipt! }
	}
	const tx = await env.context.instantLayer.executeTemplate(templateId, ops, sigs, fills, flexSigs)
	const receipt = await tx.wait()
	return { tx, receipt: receipt! }
}

function calldataGas(data: string): { bytes: number; gas: number } {
	const buf = ethers.getBytes(data)
	let gas = 0
	for (const b of buf) gas += b === 0 ? 4 : 16
	return { bytes: buf.length, gas }
}

describe("InstantOpenGasBenchmark", function () {
	this.timeout(300000)

	it("production path: 4-op template, AL affiliate hook + noop system hook, instantOpenMode", async function () {
		const env = await setupBench({ affiliateHook: "accountLayer", systemHook: "noop" })

		const run1 = await runFlow(env, env.templateId4, true)
		const run2 = await runFlow(env, env.templateId4, true)

		const cd = calldataGas(run2.tx.data)
		console.log(`      [prod] run1 (cold globals): ${run1.receipt.gasUsed}`)
		console.log(`      [prod] run2 (prod-equivalent): ${run2.receipt.gasUsed}`)
		console.log(`      [prod] calldata: ${cd.bytes} bytes → ${cd.gas} gas + 21000 intrinsic = ${cd.gas + 21000}`)
		console.log(`      [prod] execution-only (run2 - intrinsic - calldata): ${run2.receipt.gasUsed - BigInt(cd.gas + 21000)}`)
	})

	it("variant: no system hook (isolates system-hook overhead)", async function () {
		const env = await setupBench({ affiliateHook: "accountLayer", systemHook: "none" })
		await runFlow(env, env.templateId4, true)
		const run2 = await runFlow(env, env.templateId4, true)
		console.log(`      [no-system-hook] run2: ${run2.receipt.gasUsed}`)
	})

	it("variant: no hooks at all (isolates affiliate-hook overhead)", async function () {
		const env = await setupBench({ affiliateHook: "none", systemHook: "none" })
		await runFlow(env, env.templateId4, true)
		const run2 = await runFlow(env, env.templateId4, true)
		console.log(`      [no-hooks] run2: ${run2.receipt.gasUsed}`)
	})

	it("variant: 3-op template without addMarginToNextVA (isolates op0 cost)", async function () {
		const env = await setupBench({ affiliateHook: "accountLayer", systemHook: "noop" })
		// pre-fund the next VA outside the template so sendQuote still has margin
		await env.context.alMarginFacet
			.connect(env.context.signers.user)
			.addMarginToNextVA(env.subAccount, 0, env.requestSendQuote.symbolId, MARGIN_AMOUNT)
		await runFlow(env, env.templateId3, false)
		await env.context.alMarginFacet
			.connect(env.context.signers.user)
			.addMarginToNextVA(env.subAccount, 0, env.requestSendQuote.symbolId, MARGIN_AMOUNT)
		const run2 = await runFlow(env, env.templateId3, false)
		console.log(`      [3-op, margin pre-added] run2: ${run2.receipt.gasUsed}`)
	})

	it("variant: instantOpenMode OFF (normal pending-balance path)", async function () {
		const env = await setupBench({ affiliateHook: "accountLayer", systemHook: "noop" })
		await env.context.instantLayer.setTemplateInstantOpenMode(env.templateId4, false)
		await runFlow(env, env.templateId4, true)
		const run2 = await runFlow(env, env.templateId4, true)
		console.log(`      [instantOpenMode OFF] run2: ${run2.receipt.gasUsed}`)
	})

	it("variant: combined lockAndOpenPosition (3-op template)", async function () {
		const env = await setupBench({ affiliateHook: "accountLayer", systemHook: "noop" })
		const opts = { combinedLockOpen: true }
		await runFlow(env, env.templateIdCombined, true, opts)
		const run2 = await runFlow(env, env.templateIdCombined, true, opts)
		const cd = calldataGas(run2.tx.data)
		console.log(`      [lockAndOpen] run2: ${run2.receipt.gasUsed} (calldata ${cd.bytes} bytes)`)
	})

	it("variant: 2-op template (_callWithMargin + lockAndOpenPosition) saves at least 120k vs 4-op", async function () {
		const env = await setupBench({ affiliateHook: "accountLayer", systemHook: "noop" })

		// 4-op baseline in the same fixture so the delta is a guard, not just a printout
		await runFlow(env, env.templateId4, true)
		const baseline = await runFlow(env, env.templateId4, true)

		const opts = { mergedMargin: true, combinedLockOpen: true }
		const run2 = await runFlow(env, env.templateId2, false, opts)
		const cd = calldataGas(run2.tx.data)
		const quote = await env.context.viewFacetQuote.getQuote(3)
		const saving = baseline.receipt.gasUsed - run2.receipt.gasUsed
		console.log(`      [2-op] ${run2.receipt.gasUsed} vs 4-op ${baseline.receipt.gasUsed} → saving ${saving} (calldata ${cd.bytes} bytes)`)
		expect(quote.quoteStatus).to.equal(4n) // OPENED
		expect(saving).to.be.gte(120000n)
	})

	it("variant: unbound (Muon path via mock verifier, cross partyB)", async function () {
		const env = await setupBench({ affiliateHook: "accountLayer", systemHook: "noop", bind: false })
		await runFlow(env, env.templateId4, true)
		const run2 = await runFlow(env, env.templateId4, true)
		const cd = calldataGas(run2.tx.data)
		console.log(`      [unbound] run2: ${run2.receipt.gasUsed} (calldata ${cd.bytes} bytes; mock verifier — add ~13k/verify ×3 for real Schnorr)`)
	})

	it("production replica: HyperEVM tx 0xb570e9c4 shape (data payload, delegate, multicast, MockHook affiliate + AL system hook)", async function () {
		// Matches decoded mainnet tx: SymmioPartyB._multicastCall → executeTemplate(0, 4 ops),
		// sendQuoteWithAffiliateAndData with 160-byte data (double-encoded UUID string),
		// ops signed by a delegated session key, system hook = AL diamond,
		// affiliate hook = separate contract (MockHook stands in for the unknown production hook).
		const PROD_DATA =
			"0x0000000000000000000000000000000000000000000000000000000000000020" +
			"0000000000000000000000000000000000000000000000000000000000000020" +
			"0000000000000000000000000000000000000000000000000000000000000024" +
			"37346161656464612d363235382d343439622d386161632d6261396566643838" +
			"3933376500000000000000000000000000000000000000000000000000000000"

		const env = await setupBench({ affiliateHook: "mock", systemHook: "accountLayer" })
		const { context } = env
		const delegate = context.signers.hedger2

		// Grant delegation from the owner to the session key for both user-op selectors
		const addMarginSelector = context.alMarginFacet.interface.getFunction("addMarginToNextVA")!.selector
		const sendQuoteSelector = context.partyAFacet.interface.getFunction("sendQuoteWithAffiliateAndData")!.selector
		await context.instantLayer.connect(context.signers.user).grantDelegation({
			account: { addr: env.subAccount, isPartyB: false },
			delegatedSigner: delegate.address,
			selectors: [addMarginSelector, sendQuoteSelector],
			expiryTimestamp: (await getBlockTimestamp(0n)) + 86400n,
		})

		// Allow the bot's multicast entry: SymmioPartyB → InstantLayer
		await context.symmioPartyB.setMulticastWhitelist(await context.instantLayer.getAddress(), true)

		const opts = { data: PROD_DATA, userSigner: delegate, viaMulticast: true }
		const run1 = await runFlow(env, env.templateId4, true, opts)
		const run2 = await runFlow(env, env.templateId4, true, opts)
		const cd = calldataGas(run2.tx.data)
		console.log(`      [replica] run1 (cold globals): ${run1.receipt.gasUsed}`)
		console.log(`      [replica] run2 (prod-equivalent): ${run2.receipt.gasUsed}`)
		console.log(`      [replica] calldata: ${cd.bytes} bytes → ${cd.gas} gas + 21000 intrinsic`)
		console.log(`      [replica] mainnet reference: reverted at 2,841,833 used / 3,000,000 limit`)

		// Same shape but empty data payload — isolates the cost of the 160-byte UUID blob
		const optsNoData = { data: "0x", userSigner: delegate, viaMulticast: true }
		const run3 = await runFlow(env, env.templateId4, true, optsNoData)
		console.log(`      [replica, data=0x] run3: ${run3.receipt.gasUsed} (Δ vs run2 = ${run2.receipt.gasUsed - run3.receipt.gasUsed})`)
	})

	it("trace: per-frame attribution of the production run", async function () {
		const env = await setupBench({ affiliateHook: "accountLayer", systemHook: "noop" })
		await runFlow(env, env.templateId4, true)
		const run2 = await runFlow(env, env.templateId4, true)
		const hash = run2.receipt.hash
		const { context } = env

		// ── selector → name map ──
		const selectorNames: Record<string, string> = {}
		const ifaceSources = [
			context.partyAFacet,
			context.partyBQuoteActionsFacet,
			context.partyBPositionActionsFacet,
			context.accountFacet,
			context.controlFacet,
			context.bindingFacet,
			context.viewFacet,
			context.instantLayer,
			context.symmioPartyB,
			context.alCoreFacet,
			context.alMarginFacet,
			context.alViewFacet,
			context.alControlFacet,
			context.collateral,
		]
		for (const c of ifaceSources) {
			c.interface.forEachFunction((f: any) => {
				selectorNames[f.selector] = f.name
			})
		}

		// ── address → name map ──
		const addrNames: Record<string, string> = {}
		addrNames[(await context.instantLayer.getAddress()).toLowerCase()] = "InstantLayer"
		addrNames[context.diamond.toLowerCase()] = "CoreDiamond"
		addrNames[context.accountLayerDiamond.toLowerCase()] = "ALDiamond"
		addrNames[(await context.symmioPartyB.getAddress()).toLowerCase()] = "SymmioPartyB"
		addrNames[(await context.collateral.getAddress()).toLowerCase()] = "Collateral"
		addrNames["0x0000000000000000000000000000000000000001"] = "ecrecover"

		const callTrace: any = await ethers.provider.send("debug_traceTransaction", [hash, { tracer: "callTracer" }])
		const structTrace: any = await ethers.provider.send("debug_traceTransaction", [
			hash,
			{ disableStack: true, disableMemory: true, disableStorage: true },
		])
		const logs: any[] = structTrace.structLogs

		// pre-refund execution gas from structLogs
		const preRefundExec = logs.length > 0 ? logs[0].gas - logs[logs.length - 1].gas + logs[logs.length - 1].gasCost : 0
		console.log(`      pre-refund execution gas ≈ ${preRefundExec} (post-refund receipt: ${run2.receipt.gasUsed})`)

		// ── flatten callTracer frames in DFS order, skipping precompiles (they create no depth change in structLogs) ──
		interface Frame {
			label: string
			gasUsed: number
			depth: number
			ops: Record<string, { count: number; gas: number }>
		}
		const isPrecompile = (to: string) => BigInt(to) <= 0x0an
		const dfs: Frame[] = []
		const flatten = (node: any, depth: number) => {
			const to = (node.to || "").toLowerCase()
			const name = addrNames[to] ?? to.slice(0, 10)
			const sel = (node.input || "").slice(0, 10)
			const fn = selectorNames[sel] ?? sel
			dfs.push({ label: `${node.type} ${name}.${fn}`, gasUsed: parseInt(node.gasUsed, 16), depth, ops: {} })
			for (const child of node.calls ?? []) {
				if (!isPrecompile((child.to || "0x1").toLowerCase())) flatten(child, depth + 1)
			}
		}
		flatten(callTrace, 0)

		// ── walk structLogs, attribute opcode costs to current frame (self gas, children excluded) ──
		let frameIdx = 0
		const stack: Frame[] = [dfs[0]]
		let prevDepth = 1 // structLogs depth starts at 1
		const callOps = new Set(["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE", "CREATE", "CREATE2"])
		for (const l of logs) {
			if (l.depth > prevDepth) {
				frameIdx++
				if (frameIdx < dfs.length) stack.push(dfs[frameIdx])
			} else if (l.depth < prevDepth) {
				for (let d = 0; d < prevDepth - l.depth; d++) stack.pop()
			}
			prevDepth = l.depth
			const cur = stack[stack.length - 1]
			if (!cur) continue
			if (callOps.has(l.op)) continue // gasCost of call ops may include forwarded gas
			const agg = (cur.ops[l.op] ??= { count: 0, gas: 0 })
			agg.count++
			agg.gas += l.gasCost
		}

		// ── render ──
		const CATEGORIES: Record<string, string[]> = {
			SSTORE: ["SSTORE"],
			SLOAD: ["SLOAD"],
			LOG: ["LOG0", "LOG1", "LOG2", "LOG3", "LOG4"],
			KECCAK: ["KECCAK256", "SHA3"],
		}
		for (const f of dfs) {
			const indent = "  ".repeat(f.depth)
			const parts: string[] = []
			let attributed = 0
			for (const [cat, ops] of Object.entries(CATEGORIES)) {
				let gas = 0
				let count = 0
				for (const op of ops) {
					gas += f.ops[op]?.gas ?? 0
					count += f.ops[op]?.count ?? 0
				}
				attributed += gas
				if (gas > 0) parts.push(`${cat}=${gas}(${count})`)
			}
			let selfTotal = 0
			for (const v of Object.values(f.ops)) selfTotal += v.gas
			parts.push(`otherExec=${selfTotal - attributed}`)
			console.log(`      ${indent}${f.label} total=${f.gasUsed} self≈${selfTotal} | ${parts.join(" ")}`)
		}
	})
})
