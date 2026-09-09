import { expect } from "chai"
import { TypedDataDomain, ZeroAddress, ZeroHash, toUtf8Bytes } from "ethers"

import type { InstantLayer } from "../../src/types/index.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import { loadFixture, time } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "../utils/Common.js"

const POSITION = 0
const DELAY = 300n
const MARGIN = decimal(1000n)
// executeTimelockOp(SignedTimelockApproval[] approvals, bytes innerCallData) with one reserved approval lays out, after
// the selector: the two head offset words at [0, 64), the array length and the element offset at [64, 128), the five
// approval words at [128, 288), the element's signature offset word at [288, 320), then the signature tail at 320: its
// length word plus the bytes the owner reserved for it, and finally innerCallData. The owner leaves the approval words
// and the signature region as flex fields and never exposes an offset word, so a filler can change nothing about which
// inner calldata runs.
const APPROVAL_OFFSET = 128
const APPROVAL_LENGTH = 160
const SIGNATURE_OFFSET = 320
const ECDSA_SIGNATURE_LENGTH = 65

const APPROVAL_TYPES = {
	TimelockApproval: [
		{ name: "account", type: "address" },
		{ name: "unlocker", type: "address" },
		{ name: "callDataHash", type: "bytes32" },
		{ name: "deadline", type: "uint256" },
		{ name: "salt", type: "bytes32" },
	],
}

const NO_APPROVAL = { account: ZeroAddress, unlocker: ZeroAddress, callDataHash: ZeroHash, deadline: 0, salt: ZeroHash }

// Zero bytes the owner reserves for the unlocker's signature; the slot is its length word plus the padded bytes.
function reservedSignature(length: number): string {
	return ethers.hexlify(new Uint8Array(length))
}

function signatureSlotLength(reserved: number): number {
	return 32 + Math.ceil(reserved / 32) * 32
}

// Fill value for the signature region: the ABI tail of `signature`, padded to the reserved slot.
function signatureFill(signature: string, reserved: number): string {
	return ethers.concat([ethers.toBeHex(ethers.dataLength(signature), 32), ethers.zeroPadBytes(signature, signatureSlotLength(reserved) - 32)])
}

// Everything outside the two flex regions: the head and offset words, and the inner calldata.
function outsideFills(cd: string, reserved: number): string {
	const sigEnd = 4 + SIGNATURE_OFFSET + signatureSlotLength(reserved)
	return ethers.concat([
		ethers.dataSlice(cd, 0, 4 + APPROVAL_OFFSET),
		ethers.dataSlice(cd, 4 + APPROVAL_OFFSET + APPROVAL_LENGTH, 4 + SIGNATURE_OFFSET),
		ethers.dataSlice(cd, sigEnd),
	])
}

describe("AccountLayer Timelock via InstantLayer", function () {
	let context: RunContext
	let user: any
	let unlocker: any
	let executor: any
	let subAccount: string
	let marginCd: string
	let view: any
	let accountLayer: string
	let instantDomain: TypedDataDomain
	let approvalDomain: TypedDataDomain
	let types: ReturnType<typeof cloneTypes>
	let quoteCallData: string
	let deadline: bigint

	function signedOp(callData: string, target: string, flexFields: any[] = [], signer: any = user): InstantLayer.SignedOperationStruct {
		return {
			signer: signer.address,
			target,
			callData,
			signerAccount: { addr: subAccount, isPartyB: false },
			flexFields,
			maxUses: 1,
			replayAttackHeader: { nonce: 0, deadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
		}
	}

	async function signApproval(callDataHash: string, account: string = subAccount) {
		const approval = {
			account,
			unlocker: unlocker.address,
			callDataHash,
			deadline: BigInt(await time.latest()) + 60n,
			salt: ethers.hexlify(ethers.randomBytes(32)),
		}
		const signature = await unlocker.signTypedData(approvalDomain, APPROVAL_TYPES, approval)
		return { approval, signature }
	}

	// The owner's op: a zeroed approval, a reserved signature slot, and both regions open to the solver.
	function wrapperOp(innerCallData: string, reserved = ECDSA_SIGNATURE_LENGTH, signer: any = user) {
		const tl = context.alTimelockFacet
		const callData = tl.interface.encodeFunctionData("executeTimelockOp", [
			[{ approval: NO_APPROVAL, signature: reservedSignature(reserved) }],
			innerCallData,
		])
		const flexFields = [
			{ offset: APPROVAL_OFFSET, length: APPROVAL_LENGTH, authorizedFlexFiller: executor.address },
			{ offset: SIGNATURE_OFFSET, length: signatureSlotLength(reserved), authorizedFlexFiller: executor.address },
		]
		return { callData, op: signedOp(callData, accountLayer, flexFields, signer) }
	}

	// Fills for the two flex regions from a fresh approval over the exact calldata of the timelocked op inside innerCallData.
	async function solverFills(innerCallData: string, guardedCallData: string, account: string = subAccount) {
		const signed = await signApproval(ethers.keccak256(guardedCallData), account)
		const filledCd = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[signed], innerCallData])
		return [
			ethers.dataSlice(filledCd, 4 + APPROVAL_OFFSET, 4 + APPROVAL_OFFSET + APPROVAL_LENGTH),
			signatureFill(signed.signature, ECDSA_SIGNATURE_LENGTH),
		]
	}

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = context.signers.user
		unlocker = context.signers.hedger
		executor = context.signers.admin
		accountLayer = context.accountLayerDiamond
		view = context.alViewFacet
		const affiliate = await context.accountManager.getAddress()

		const creationData = [{ name: "tli", metadata: "0x", symmioCore: context.diamond, isolationType: POSITION, singleVAMode: false }]
		const predicted = await context.alCoreFacet.connect(user).createSubAccounts.staticCall(affiliate, creationData)
		await context.alCoreFacet.connect(user).createSubAccounts(affiliate, creationData)
		subAccount = predicted[0]

		await context.collateral.connect(user).mint(user.address, decimal(100000n))
		await context.collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user).depositFor(subAccount, decimal(10000n))

		await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		await context.instantLayer.setAccountLayer(accountLayer)

		const chainId = (await ethers.provider.getNetwork()).chainId
		instantDomain = { name: "SymmioInstantLayer", version: "1", chainId, verifyingContract: await context.instantLayer.getAddress() }
		approvalDomain = { name: "SymmioAccountLayerTimelock", version: "1", chainId, verifyingContract: accountLayer }
		types = cloneTypes()
		deadline = await getBlockTimestamp(300n)

		const request = limitQuoteRequestBuilder()
			.partyBWhiteList([await context.signers.hedger.getAddress()])
			.build()
		quoteCallData = context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
			request.partyBWhiteList,
			request.symbolId,
			request.positionType,
			request.orderType,
			request.price,
			request.quantity,
			request.cva,
			request.lf,
			request.partyAmm,
			request.partyBmm,
			request.maxFundingRate,
			await request.deadline,
			request.affiliate,
			await request.upnlSig,
		])

		const addMarginToNextVA = context.alMarginFacet.interface.getFunction("addMarginToNextVA")!.selector
		const internalTransfer = context.accountFacet.interface.getFunction("internalTransfer")!.selector
		await context.alTimelockFacet.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [addMarginToNextVA, internalTransfer])
		// The op the solver guards inside an instant-open batch: the margin move _callWithMargin performs first.
		marginCd = context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [subAccount, POSITION, 1, MARGIN])
	})

	it("the solver fills the approval and signature slots of the user's executeTimelockOp op and the batch opens the quote", async function () {
		const tl = context.alTimelockFacet
		const cwmCd = context.alCoreFacet.interface.encodeFunctionData("_callWithMargin", [subAccount, POSITION, 1, MARGIN, [quoteCallData]])

		// The user signs their own intent with a zeroed approval and a reserved signature slot the solver may fill.
		const { callData: wrapperCd, op } = wrapperOp(cwmCd)
		const sig = await user.signTypedData(instantDomain, types, op)

		// The solver produces the fills from a fresh approval over the margin move it guards, not over the whole batch.
		const signed = await signApproval(ethers.keccak256(marginCd))
		const filledCd = tl.interface.encodeFunctionData("executeTimelockOp", [[signed], cwmCd])
		const approvalFill = ethers.dataSlice(filledCd, 4 + APPROVAL_OFFSET, 4 + APPROVAL_OFFSET + APPROVAL_LENGTH)
		const sigFill = signatureFill(signed.signature, ECDSA_SIGNATURE_LENGTH)
		const sigEnd = SIGNATURE_OFFSET + signatureSlotLength(ECDSA_SIGNATURE_LENGTH)
		// The two fills are exactly the regions that differ; head, offset words, and inner calldata are untouched.
		expect(ethers.dataSlice(filledCd, 4 + SIGNATURE_OFFSET, 4 + sigEnd)).to.equal(sigFill)
		expect(outsideFills(filledCd, ECDSA_SIGNATURE_LENGTH)).to.equal(outsideFills(wrapperCd, ECDSA_SIGNATURE_LENGTH))

		await context.instantLayer.connect(executor).executeBatch([op], [sig], [[approvalFill, sigFill]], [["0x", "0x"]])

		expect((await context.viewFacetQuote.getQuote(1)).partyA).to.not.equal(ZeroAddress)
		expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(true)
	})

	it("a signature slot reserved larger than the unlocker needs still decodes", async function () {
		const tl = context.alTimelockFacet
		const cwmCd = context.alCoreFacet.interface.encodeFunctionData("_callWithMargin", [subAccount, POSITION, 1, MARGIN, [quoteCallData]])
		const reserved = 2 * ECDSA_SIGNATURE_LENGTH // room for a two-key contract unlocker
		const { callData: wrapperCd, op } = wrapperOp(cwmCd, reserved)
		const sig = await user.signTypedData(instantDomain, types, op)

		const signed = await signApproval(ethers.keccak256(marginCd))
		const filledCd = tl.interface.encodeFunctionData("executeTimelockOp", [
			[{ approval: signed.approval, signature: reservedSignature(reserved) }],
			cwmCd,
		])
		const approvalFill = ethers.dataSlice(filledCd, 4 + APPROVAL_OFFSET, 4 + APPROVAL_OFFSET + APPROVAL_LENGTH)
		const sigFill = signatureFill(signed.signature, reserved)
		expect(ethers.dataLength(sigFill)).to.equal(signatureSlotLength(reserved))
		expect(outsideFills(filledCd, reserved)).to.equal(outsideFills(wrapperCd, reserved))

		await context.instantLayer.connect(executor).executeBatch([op], [sig], [[approvalFill, sigFill]], [["0x", "0x"]])
		expect((await context.viewFacetQuote.getQuote(1)).partyA).to.not.equal(ZeroAddress)
	})

	it("checks a template-mutated inner call against an approval for the final calldata", async function () {
		const il = context.instantLayer
		const core = context.alCoreFacet
		const tl = context.alTimelockFacet
		const mock = await (await ethers.getContractFactory("MockInstantTarget")).deploy()
		await il.setTargetWhitelist(await mock.getAddress(), true)

		const placeholderAmount = 0x112233445566778899n
		const finalAmount = decimal(10n)
		const placeholderTransfer = context.accountFacet.interface.encodeFunctionData("internalTransfer", [
			context.signers.user2.address,
			placeholderAmount,
		])
		const finalTransfer = context.accountFacet.interface.encodeFunctionData("internalTransfer", [context.signers.user2.address, finalAmount])
		const innerCall = core.interface.encodeFunctionData("_call", [subAccount, [placeholderTransfer]])
		const { callData: wrapperCd, op: wrapperOperation } = wrapperOp(innerCall)
		const marker = ethers.toBeHex(placeholderAmount, 32).slice(2)
		const markerIndex = wrapperCd.slice(2).indexOf(marker)
		expect(markerIndex).to.be.greaterThan(-1)
		expect(wrapperCd.slice(2).lastIndexOf(marker)).to.equal(markerIndex)
		const insertionPoint = markerIndex / 2 - 4

		const sourceCd = mock.interface.encodeFunctionData("getTuple", [finalAmount, 0])
		const templateId = await il.nextTemplateId()
		await il.addTemplate("Final inserted timelock approval", [
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [insertionPoint], sourceIndices: [0], sourceOffsets: [0] },
		])
		const sourceOp = signedOp(sourceCd, await mock.getAddress())
		const sourceSignature = await user.signTypedData(instantDomain, types, sourceOp)
		const wrapperSignature = await user.signTypedData(instantDomain, types, wrapperOperation)

		function fillsFor(signed: { approval: any; signature: string }) {
			const filledCd = tl.interface.encodeFunctionData("executeTimelockOp", [[signed], innerCall])
			return [
				ethers.dataSlice(filledCd, 4 + APPROVAL_OFFSET, 4 + APPROVAL_OFFSET + APPROVAL_LENGTH),
				signatureFill(signed.signature, ECDSA_SIGNATURE_LENGTH),
			]
		}

		const wrong = await signApproval(ethers.keccak256(placeholderTransfer))
		const execute = (wrapperFills: string[]) =>
			il
				.connect(executor)
				.executeTemplate(templateId, [sourceOp, wrapperOperation], [sourceSignature, wrapperSignature], [[], wrapperFills], [[], ["0x", "0x"]])
		await expect(execute(fillsFor(wrong)))
			.to.be.revertedWithCustomError(il, "OperationFailed")
			.withArgs(1, (d: string) => d.startsWith(tl.interface.getError("TimelockOpNotApprovedOrScheduled")!.selector))
		expect(await view.isApprovalUsed(await view.hashTimelockApproval(wrong.approval))).to.equal(false)
		expect(await il.operationUsageCount(await il.getOperationHash(sourceOp))).to.equal(0n)
		expect(await il.operationUsageCount(await il.getOperationHash(wrapperOperation))).to.equal(0n)

		const right = await signApproval(ethers.keccak256(finalTransfer))
		const before = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
		await execute(fillsFor(right))
		expect(await view.isApprovalUsed(await view.hashTimelockApproval(right.approval))).to.equal(true)
		expect(await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)).to.equal(before + finalAmount)
	})

	it("the same op without fills is rejected", async function () {
		const cwmCd = context.alCoreFacet.interface.encodeFunctionData("_callWithMargin", [subAccount, POSITION, 1, MARGIN, [quoteCallData]])
		const { op } = wrapperOp(cwmCd)
		const sig = await user.signTypedData(instantDomain, types, op)
		// Empty fills keep the user's zeroed approval, which names no unlocker, so the wrapper refuses it before anything runs.
		await expect(context.instantLayer.connect(executor).executeBatch([op], [sig], [["0x", "0x"]], [["0x", "0x"]]))
			.to.be.revertedWithCustomError(context.instantLayer, "OperationFailed")
			.withArgs(0, (d: string) => d.startsWith(context.alTimelockFacet.interface.getError("ZeroUnlocker")!.selector))
	})

	it("a session key needs a delegation for the wrapped call, not for the wrapper", async function () {
		const sessionKey = context.signers.hedger2
		const cwmSelector = context.alCoreFacet.interface.getFunction("_callWithMargin")!.selector
		const wrapperSelector = context.alTimelockFacet.interface.getFunction("executeTimelockOp")!.selector
		const expiry = (await getBlockTimestamp(0n)) + 86400n
		const cwmCd = context.alCoreFacet.interface.encodeFunctionData("_callWithMargin", [subAccount, POSITION, 1, MARGIN, [quoteCallData]])

		// A delegation over the wrapper alone grants nothing: the InstantLayer checks the wrapped call's selector.
		await context.instantLayer.connect(user).grantDelegation({
			account: { addr: subAccount, isPartyB: false },
			delegatedSigner: sessionKey.address,
			selectors: [wrapperSelector],
			expiryTimestamp: expiry,
		})
		const { op: opByWrapperOnly } = wrapperOp(cwmCd, ECDSA_SIGNATURE_LENGTH, sessionKey)
		const sigByWrapperOnly = await sessionKey.signTypedData(instantDomain, types, opByWrapperOnly)
		await expect(
			context.instantLayer
				.connect(executor)
				.executeBatch([opByWrapperOnly], [sigByWrapperOnly], [await solverFills(cwmCd, marginCd)], [["0x", "0x"]]),
		).to.be.revertedWithCustomError(context.instantLayer, "InvalidDelegation")

		// A delegation over _callWithMargin is what the session key needs, and it is enough.
		await context.instantLayer.connect(user).grantDelegation({
			account: { addr: subAccount, isPartyB: false },
			delegatedSigner: sessionKey.address,
			selectors: [cwmSelector],
			expiryTimestamp: expiry,
		})
		const { op } = wrapperOp(cwmCd, ECDSA_SIGNATURE_LENGTH, sessionKey)
		const sig = await sessionKey.signTypedData(instantDomain, types, op)
		await context.instantLayer.connect(executor).executeBatch([op], [sig], [await solverFills(cwmCd, marginCd)], [["0x", "0x"]])
		expect((await context.viewFacetQuote.getQuote(1)).partyA).to.not.equal(ZeroAddress)
	})

	for (const depth of [1, 2]) {
		for (const route of ["batch", "template"] as const) {
			it(`rejects a flex replacement of the delegated selector through ${depth} wrappers in a ${route}`, async function () {
				const il = context.instantLayer
				const core = context.alCoreFacet
				const sessionKey = context.signers.hedger2
				const rename = core.interface.encodeFunctionData("editAccountName", [subAccount, "rename"])
				const transfer = core.interface.encodeFunctionData("transferSubAccountOwnership", [subAccount, sessionKey.address])
				let original = rename
				let modified = ethers.zeroPadBytes(transfer, ethers.dataLength(rename))
				for (let i = 0; i < depth; i++) {
					original = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[], original])
					modified = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[], modified])
				}
				await il.connect(user).grantDelegation({
					account: { addr: subAccount, isPartyB: false },
					delegatedSigner: sessionKey.address,
					selectors: [core.interface.getFunction("editAccountName")!.selector],
					expiryTimestamp: deadline,
				})
				const op = signedOp(
					original,
					accountLayer,
					[{ offset: 0, length: ethers.dataLength(original) - 4, authorizedFlexFiller: executor.address }],
					sessionKey,
				)
				const signature = await sessionKey.signTypedData(instantDomain, types, op)
				const fills = [[ethers.dataSlice(modified, 4)]]
				const templateId = await il.nextTemplateId()
				if (route === "template") await il.addTemplate("Final flex delegation", [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }])
				const execute = () =>
					route === "batch"
						? il.connect(executor).executeBatch([op], [signature], fills, [["0x"]])
						: il.connect(executor).executeTemplate(templateId, [op], [signature], fills, [["0x"]])
				await expect(execute()).to.be.revertedWithCustomError(il, "InvalidDelegation")
				expect(await view.ownerOf(subAccount)).to.equal(user.address)
				expect(await il.operationUsageCount(await il.getOperationHash(op))).to.equal(0n)

				// The same signed operation is valid once the final selector is delegated.
				await il.connect(user).grantDelegation({
					account: { addr: subAccount, isPartyB: false },
					delegatedSigner: sessionKey.address,
					selectors: [core.interface.getFunction("transferSubAccountOwnership")!.selector],
					expiryTimestamp: deadline,
				})
				await execute()
				expect(await view.ownerOf(subAccount)).to.equal(sessionKey.address)
			})
		}
	}

	for (const mutation of ["selector", "offset"] as const) {
		it(`checks delegation after template results replace the wrapped ${mutation}`, async function () {
			const il = context.instantLayer
			const core = context.alCoreFacet
			const sessionKey = context.signers.hedger2
			const mock = await (await ethers.getContractFactory("MockInstantTarget")).deploy()
			await il.setTargetWhitelist(await mock.getAddress(), true)
			const rename = core.interface.encodeFunctionData("editAccountName", [subAccount, "rename"])
			const transfer = core.interface.encodeFunctionData("transferSubAccountOwnership", [subAccount, sessionKey.address])
			let wrapper = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[], rename])
			const innerStart = 4 + Number(BigInt(ethers.dataSlice(wrapper, 36, 68))) + 32
			let insertionPoints: number[]
			let sourceOffsets: number[]
			let sourceCd: string
			if (mutation === "selector") {
				insertionPoints = [innerStart - 4, innerStart + 32]
				sourceOffsets = [0, 32]
				sourceCd = mock.interface.encodeFunctionData("getTuple", [BigInt(ethers.dataSlice(transfer, 0, 32)), BigInt(sessionKey.address)])
			} else {
				const newOffset = ethers.dataLength(wrapper) - 4
				wrapper = ethers.concat([wrapper, ethers.toBeHex(ethers.dataLength(transfer), 32), ethers.zeroPadBytes(transfer, 96)])
				insertionPoints = [32]
				sourceOffsets = [0]
				sourceCd = mock.interface.encodeFunctionData("getTuple", [newOffset, 0])
			}
			await il.connect(user).grantDelegation({
				account: { addr: subAccount, isPartyB: false },
				delegatedSigner: sessionKey.address,
				selectors: [core.interface.getFunction("editAccountName")!.selector],
				expiryTimestamp: deadline,
			})
			const templateId = await il.nextTemplateId()
			await il.addTemplate("Final inserted delegation", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints, sourceIndices: insertionPoints.map(() => 0), sourceOffsets },
			])
			const ops = [signedOp(sourceCd, await mock.getAddress()), signedOp(wrapper, accountLayer, [], sessionKey)]
			const signatures = [await user.signTypedData(instantDomain, types, ops[0]), await sessionKey.signTypedData(instantDomain, types, ops[1])]
			const execute = () => il.connect(executor).executeTemplate(templateId, ops, signatures, [[], []], [[], []])
			await expect(execute()).to.be.revertedWithCustomError(il, "InvalidDelegation")
			expect(await view.ownerOf(subAccount)).to.equal(user.address)
			for (const op of ops) expect(await il.operationUsageCount(await il.getOperationHash(op))).to.equal(0n)
			await il.connect(user).grantDelegation({
				account: { addr: subAccount, isPartyB: false },
				delegatedSigner: sessionKey.address,
				selectors: [core.interface.getFunction("transferSubAccountOwnership")!.selector],
				expiryTimestamp: deadline,
			})
			await execute()
			expect(await view.ownerOf(subAccount)).to.equal(sessionKey.address)
		})
	}

	it("authorizes the final selector even when the signed placeholder selector is not delegated", async function () {
		const il = context.instantLayer
		const core = context.alCoreFacet
		const sessionKey = context.signers.hedger2
		const rename = core.interface.encodeFunctionData("editAccountName", [subAccount, "rename"])
		const transfer = core.interface.encodeFunctionData("transferSubAccountOwnership", [subAccount, sessionKey.address])
		const wrapper = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[], rename])
		const finalWrapper = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [
			[],
			ethers.zeroPadBytes(transfer, ethers.dataLength(rename)),
		])
		await il.connect(user).grantDelegation({
			account: { addr: subAccount, isPartyB: false },
			delegatedSigner: sessionKey.address,
			selectors: [core.interface.getFunction("transferSubAccountOwnership")!.selector],
			expiryTimestamp: deadline,
		})
		const op = signedOp(
			wrapper,
			accountLayer,
			[{ offset: 0, length: ethers.dataLength(wrapper) - 4, authorizedFlexFiller: executor.address }],
			sessionKey,
		)
		const signature = await sessionKey.signTypedData(instantDomain, types, op)
		await il.connect(executor).executeBatch([op], [signature], [[ethers.dataSlice(finalWrapper, 4)]], [["0x"]])
		expect(await view.ownerOf(subAccount)).to.equal(sessionKey.address)
	})

	it("keeps a delegated wrapper confined to the account family after flex replacement", async function () {
		const il = context.instantLayer
		const core = context.alCoreFacet
		const tl = context.alTimelockFacet
		const sessionKey = context.signers.hedger2
		const affiliate = await context.accountManager.getAddress()
		const creationData = [{ name: "sibling", metadata: "0x", symmioCore: context.diamond, isolationType: POSITION, singleVAMode: false }]
		const sibling = (await core.connect(user).createSubAccounts.staticCall(affiliate, creationData))[0]
		await core.connect(user).createSubAccounts(affiliate, creationData)

		const originalInner = core.interface.encodeFunctionData("editAccountName", [subAccount, "scoped"])
		const siblingInner = core.interface.encodeFunctionData("editAccountName", [sibling, "scoped"])
		const original = tl.interface.encodeFunctionData("executeTimelockOp", [[], originalInner])
		const modified = tl.interface.encodeFunctionData("executeTimelockOp", [[], siblingInner])
		expect(ethers.dataLength(modified)).to.equal(ethers.dataLength(original))
		await il.connect(user).grantDelegation({
			account: { addr: subAccount, isPartyB: false },
			delegatedSigner: sessionKey.address,
			selectors: [core.interface.getFunction("editAccountName")!.selector],
			expiryTimestamp: deadline,
		})
		const op = signedOp(
			original,
			accountLayer,
			[{ offset: 0, length: ethers.dataLength(original) - 4, authorizedFlexFiller: executor.address }],
			sessionKey,
		)
		const signature = await sessionKey.signTypedData(instantDomain, types, op)

		await expect(il.connect(executor).executeBatch([op], [signature], [[ethers.dataSlice(modified, 4)]], [["0x"]]))
			.to.be.revertedWithCustomError(il, "OperationFailed")
			.withArgs(0, (d: string) => d.startsWith(core.interface.getError("AccountOutOfScope")!.selector))
		expect((await view.getSubAccount(sibling)).name).to.equal("sibling")
		expect(await il.operationUsageCount(await il.getOperationHash(op))).to.equal(0n)

		await il.connect(executor).executeBatch([op], [signature], [[ethers.dataSlice(original, 4)]], [["0x"]])
		expect((await view.getSubAccount(subAccount)).name).to.equal("scoped")
	})

	it("rolls back approvals, state, signer scope, and operation usage when a later batch operation fails", async function () {
		const il = context.instantLayer
		const core = context.alCoreFacet
		const tl = context.alTimelockFacet
		const transferCd = context.accountFacet.interface.encodeFunctionData("internalTransfer", [context.signers.user2.address, decimal(10n)])
		const wrappedCall = core.interface.encodeFunctionData("_call", [subAccount, [transferCd]])
		const { op: zeroNonceOp } = wrapperOp(wrappedCall)
		const op = { ...zeroNonceOp, replayAttackHeader: { ...zeroNonceOp.replayAttackHeader, nonce: 1n } }
		const opSignature = await user.signTypedData(instantDomain, types, op)
		const signed = await signApproval(ethers.keccak256(transferCd))
		const filledCd = tl.interface.encodeFunctionData("executeTimelockOp", [[signed], wrappedCall])
		const wrapperFills = [
			ethers.dataSlice(filledCd, 4 + APPROVAL_OFFSET, 4 + APPROVAL_OFFSET + APPROVAL_LENGTH),
			signatureFill(signed.signature, ECDSA_SIGNATURE_LENGTH),
		]

		const invalidRename = core.interface.encodeFunctionData("editAccountName", [subAccount, ""])
		const zeroNonceFailingOp = signedOp(invalidRename, accountLayer)
		const failingOp = { ...zeroNonceFailingOp, replayAttackHeader: { ...zeroNonceFailingOp.replayAttackHeader, nonce: 2n } }
		const failingSignature = await user.signTypedData(instantDomain, types, failingOp)
		const approvalHash = await view.hashTimelockApproval(signed.approval)
		const before = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)

		await expect(
			il.connect(executor).executeBatch([op, failingOp], [opSignature, failingSignature], [wrapperFills, []], [["0x", "0x"], []]),
		).to.be.revertedWithCustomError(il, "OperationFailed")
		expect(await view.isApprovalUsed(approvalHash)).to.equal(false)
		expect(await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)).to.equal(before)
		expect(await view.getSignerScope()).to.equal(ZeroAddress)
		expect(await il.operationUsageCount(await il.getOperationHash(op))).to.equal(0n)
		expect(await il.operationUsageCount(await il.getOperationHash(failingOp))).to.equal(0n)
		expect(await il.nonces(subAccount)).to.equal(0n)

		await il.connect(executor).executeBatch([op], [opSignature], [wrapperFills], [["0x", "0x"]])
		expect(await view.isApprovalUsed(approvalHash)).to.equal(true)
		expect(await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)).to.be.greaterThan(before)
		expect(await il.nonces(subAccount)).to.equal(1n)
	})

	for (const mutation of ["offset out of bounds", "length out of bounds", "short selector"] as const) {
		it(`rejects final wrapper calldata with ${mutation}`, async function () {
			const il = context.instantLayer
			const sessionKey = context.signers.hedger2
			const rename = context.alCoreFacet.interface.encodeFunctionData("editAccountName", [subAccount, "rename"])
			const wrapper = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[], rename])
			const innerOffset = Number(BigInt(ethers.dataSlice(wrapper, 36, 68)))
			const offset = mutation === "offset out of bounds" ? 32 : innerOffset
			const value = mutation === "short selector" ? 3n : ethers.MaxUint256
			await il.connect(user).grantDelegation({
				account: { addr: subAccount, isPartyB: false },
				delegatedSigner: sessionKey.address,
				selectors: [context.alCoreFacet.interface.getFunction("editAccountName")!.selector],
				expiryTimestamp: deadline,
			})
			const op = signedOp(wrapper, accountLayer, [{ offset, length: 32, authorizedFlexFiller: executor.address }], sessionKey)
			const signature = await sessionKey.signTypedData(instantDomain, types, op)
			await expect(il.connect(executor).executeBatch([op], [signature], [[ethers.toBeHex(value, 32)]], [["0x"]])).to.be.revertedWithCustomError(
				il,
				"InvalidDelegation",
			)
			expect(await view.ownerOf(subAccount)).to.equal(user.address)
		})
	}

	it("rejects a timelock wrapper shorter than its two-word ABI head", async function () {
		const il = context.instantLayer
		const sessionKey = context.signers.hedger2
		const wrapperSelector = context.alTimelockFacet.interface.getFunction("executeTimelockOp")!.selector
		const truncatedWrapper = ethers.concat([wrapperSelector, ZeroHash])
		await il.connect(user).grantDelegation({
			account: { addr: subAccount, isPartyB: false },
			delegatedSigner: sessionKey.address,
			selectors: [context.alCoreFacet.interface.getFunction("editAccountName")!.selector],
			expiryTimestamp: deadline,
		})
		const op = signedOp(truncatedWrapper, accountLayer, [], sessionKey)
		const signature = await sessionKey.signTypedData(instantDomain, types, op)

		await expect(il.connect(executor).executeBatch([op], [signature], [[]], [[]])).to.be.revertedWithCustomError(il, "InvalidDelegation")
		expect(await il.operationUsageCount(await il.getOperationHash(op))).to.equal(0n)
	})

	for (const malformedWord of ["offset", "length"] as const) {
		it(`rejects an out-of-bounds ${malformedWord} in a nested timelock wrapper`, async function () {
			const il = context.instantLayer
			const tl = context.alTimelockFacet
			const sessionKey = context.signers.hedger2
			const rename = context.alCoreFacet.interface.encodeFunctionData("editAccountName", [subAccount, "rename"])
			const innerWrapper = tl.interface.encodeFunctionData("executeTimelockOp", [[], rename])
			const innerCallOffset = Number(BigInt(ethers.dataSlice(innerWrapper, 36, 68)))
			const wordOffset = malformedWord === "offset" ? 36 : 4 + innerCallOffset
			const malformedInnerWrapper = ethers.concat([
				ethers.dataSlice(innerWrapper, 0, wordOffset),
				ethers.toBeHex(ethers.MaxUint256, 32),
				ethers.dataSlice(innerWrapper, wordOffset + 32),
			])
			const outerWrapper = tl.interface.encodeFunctionData("executeTimelockOp", [[], malformedInnerWrapper])
			await il.connect(user).grantDelegation({
				account: { addr: subAccount, isPartyB: false },
				delegatedSigner: sessionKey.address,
				selectors: [context.alCoreFacet.interface.getFunction("editAccountName")!.selector],
				expiryTimestamp: deadline,
			})
			const op = signedOp(outerWrapper, accountLayer, [], sessionKey)
			const signature = await sessionKey.signTypedData(instantDomain, types, op)

			await expect(il.connect(executor).executeBatch([op], [signature], [[]], [[]])).to.be.revertedWithCustomError(il, "InvalidDelegation")
			expect(await il.operationUsageCount(await il.getOperationHash(op))).to.equal(0n)
		})
	}

	it("one batch can carry wrapper ops for two accounts, each with its own approvals", async function () {
		const core = context.alCoreFacet
		const tl = context.alTimelockFacet
		const affiliate = await context.accountManager.getAddress()
		const internalTransfer = context.accountFacet.interface.getFunction("internalTransfer")!.selector

		// A second sub-account of the same owner, timelocked by the same solver.
		const creationData = [{ name: "tli2", metadata: "0x", symmioCore: context.diamond, isolationType: POSITION, singleVAMode: false }]
		const second = (await core.connect(user).createSubAccounts.staticCall(affiliate, creationData))[0]
		await core.connect(user).createSubAccounts(affiliate, creationData)
		await context.accountFacet.connect(user).depositFor(second, decimal(1000n))
		await tl.connect(user).setupTimelocks(second, unlocker.address, DELAY, [internalTransfer])

		const transferCd = context.accountFacet.interface.encodeFunctionData("internalTransfer", [context.signers.user2.address, decimal(10n)])
		const firstCall = core.interface.encodeFunctionData("_call", [subAccount, [transferCd]])
		const secondCall = core.interface.encodeFunctionData("_call", [second, [transferCd]])
		const { op: firstOp } = wrapperOp(firstCall)
		const secondOp = { ...wrapperOp(secondCall).op, signerAccount: { addr: second, isPartyB: false } }
		const firstSig = await user.signTypedData(instantDomain, types, firstOp)
		const secondSig = await user.signTypedData(instantDomain, types, secondOp)

		// Each wrapper op gets the solver's approval over the transfer inside it, for its own account; the same batch carries both.
		const fills = [await solverFills(firstCall, transferCd, subAccount), await solverFills(secondCall, transferCd, second)]
		await expect(
			context.instantLayer.connect(executor).executeBatch([firstOp, secondOp], [firstSig, secondSig], fills, [
				["0x", "0x"],
				["0x", "0x"],
			]),
		)
			.to.emit(tl, "TimelockOpExecuted")
			.withArgs(subAccount, ethers.keccak256(transferCd))
			.and.to.emit(tl, "TimelockOpExecuted")
			.withArgs(second, ethers.keccak256(transferCd))
	})

	it("a relayed core op carrying a timelocked selector is rejected", async function () {
		const cd = context.accountFacet.interface.encodeFunctionData("internalTransfer", [context.signers.user2.address, decimal(10n)])
		const op = signedOp(cd, context.diamond)
		const sig = await user.signTypedData(instantDomain, types, op)
		await expect(context.instantLayer.connect(executor).executeBatch([op], [sig], [[]], [[]]))
			.to.be.revertedWithCustomError(context.instantLayer, "OperationFailed")
			.withArgs(0, (d: string) => d.startsWith(context.alTimelockFacet.interface.getError("TimelockOpNotApprovedOrScheduled")!.selector))
	})

	it("a relayed core op on a selector outside the set passes", async function () {
		const cd = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(10n)])
		const op = signedOp(cd, context.diamond)
		const sig = await user.signTypedData(instantDomain, types, op)
		await context.instantLayer.connect(executor).executeBatch([op], [sig], [[]], [[]])
	})
})
