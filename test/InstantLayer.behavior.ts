import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs"
import { expect } from "chai"
import { ZeroAddress, toUtf8Bytes, TypedDataDomain } from "ethers"

import type { InstantLayer } from "../src/types/index.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { cloneTypes, DELEGATE_TYPES, FLEX_FILLER_AUTH_TYPES } from "./helpers/instantLayerEIP712Types.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { OrderType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder, OpenRequest } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder, QuoteRequest } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "./utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

// ════════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════════

const ROLES = {
	SETTER_ROLE: ethers.keccak256(toUtf8Bytes("SETTER_ROLE")),
	OPERATOR_ROLE: ethers.keccak256(toUtf8Bytes("OPERATOR_ROLE")),
	REVOKER_ROLE: ethers.keccak256(toUtf8Bytes("REVOKER_ROLE")),
	INSTANT_LAYER_ROLE: ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")),
	TRUSTED_ROLE: ethers.keccak256(toUtf8Bytes("TRUSTED_ROLE")),
	BINDABLE_SETTER_ROLE: ethers.keccak256(toUtf8Bytes("BINDABLE_SETTER_ROLE")),
}

const DEFAULT_DEADLINE_OFFSET = 300n
const DEFAULT_EXPIRY_OFFSET = 3600n
const MIN_REVOCATION_COOLDOWN = 5 * 60 // 5 minutes
const MAX_REVOCATION_COOLDOWN = 30 * 24 * 3600 // 30 days

const INSTANT_OPEN_WITH_CUSTOM_VA_TEMPLATE_NAME = "InstantOpenWithCustomVA"
const INSTANT_CLOSE_WITH_PARENT_ALLOCATION_TEMPLATE_NAME = "InstantCloseWithParentAllocation"

// ════════════════════════════════════════════════════════════════════════════════
// HELPER TYPES
// ════════════════════════════════════════════════════════════════════════════════

interface TestContext {
	context: RunContext
	partyA1: User
	partyA2: User
	partyB1: Hedger
	partyB2: Hedger
	types: ReturnType<typeof cloneTypes>
	domain: TypedDataDomain
	quoteCallData: string
	lockQuoteCallData: string
	openQuoteCallData: string
	bindToPartyBCallData: string
	requestSendQuote: QuoteRequest
	requestOpenQuote: OpenRequest
	ops: InstantLayer.OperationStruct[]
}

interface ExecutionTestContext extends TestContext {
	accounts: any[]
	symmioAddress: string
	deadline: bigint
}

// ════════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════════

async function createDomain(instantLayerAddress: string): Promise<TypedDataDomain> {
	return {
		name: "SymmioInstantLayer",
		version: "1",
		chainId: (await ethers.provider.getNetwork()).chainId,
		verifyingContract: instantLayerAddress,
	}
}

function generateSalt(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

async function signOperation(
	signer: any,
	domain: TypedDataDomain,
	types: ReturnType<typeof cloneTypes>,
	op: InstantLayer.SignedOperationStruct,
): Promise<string> {
	return signer.signTypedData(domain, types, op)
}

function createSignedOperation(
	signer: string,
	target: string,
	callData: string,
	signerAccount: InstantLayer.AccountStruct,
	nonce: bigint,
	deadline: bigint,
): InstantLayer.SignedOperationStruct {
	return {
		signer,
		target,
		callData,
		signerAccount,
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce, deadline, salt: generateSalt() },
	}
}

function instantOpenWithCustomVATemplateOps(): InstantLayer.OperationStruct[] {
	return [
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
		{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
		{ insertionPoints: [0], sourceIndices: [2], sourceOffsets: [0] },
		{ insertionPoints: [0], sourceIndices: [2], sourceOffsets: [0] },
	]
}

function instantCloseWithParentAllocationTemplateOps(): InstantLayer.OperationStruct[] {
	return [
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
		{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
		{ insertionPoints: [0], sourceIndices: [2], sourceOffsets: [0] },
	]
}

function normalizeTemplateOps(ops: any[]): { insertionPoints: number[]; sourceIndices: number[]; sourceOffsets: number[] }[] {
	return ops.map(op => ({
		insertionPoints: op.insertionPoints.map(Number),
		sourceIndices: op.sourceIndices.map(Number),
		sourceOffsets: op.sourceOffsets.map(Number),
	}))
}

async function increaseTime(seconds: number): Promise<void> {
	await time.increase(seconds)
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN TEST SUITE
// ════════════════════════════════════════════════════════════════════════════════

export function shouldBehaveLikeInstantLayer(): void {
	let ctx: TestContext

	// ──────────────────────────────────────────────────────────────────────────
	// BASE SETUP
	// ──────────────────────────────────────────────────────────────────────────

	beforeEach(async function () {
		const context = await loadFixture(initializeFixture)
		const partyA1 = new User(context, context.signers.user)
		const partyA2 = new User(context, context.signers.user2)
		const partyB1 = new Hedger(context, context.signers.hedger)
		const partyB2 = new Hedger(context, context.signers.hedger2)

		await Promise.all([partyA1.setup(), partyA2.setup(), partyB1.setup(), partyB2.setup()])

		await partyA1.setBalances(decimal(100000n), decimal(5000n), decimal(2000n))
		await partyA2.setBalances(decimal(100000n), decimal(5000n))

		await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)
		// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
		await context.controlFacet.connect(context.signers.admin).registerPartyB(await context.symmioPartyB.getAddress())
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(await context.symmioPartyB.getAddress(), true)

		await context.instantLayer.setAccountLayer(context.accountLayerDiamond)

		const requestSendQuote = limitQuoteRequestBuilder()
			.partyBWhiteList([await context.symmioPartyB.getAddress()])
			.build()
		const requestOpenQuote = limitOpenRequestBuilder().build()

		const { partyAFacet, partyBPositionActionsFacet, partyBQuoteActionsFacet, bindingFacet } = context

		const quoteCallData = partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
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

		const lockQuoteCallData = partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [1, await getDummySingleUpnlSig(10n)])
		const openQuoteCallData = partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
			1,
			requestOpenQuote.filledAmount,
			requestOpenQuote.openPrice,
			await getDummyPairUpnlAndPriceSig(10n),
		])
		const bindToPartyBCallData = bindingFacet.interface.encodeFunctionData("bindToPartyB", [await context.symmioPartyB.getAddress()])

		const ops: InstantLayer.OperationStruct[] = [
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] },
			{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] },
			{ sourceIndices: [0], insertionPoints: [0], sourceOffsets: [0] },
			{ sourceIndices: [0], insertionPoints: [0], sourceOffsets: [0] },
		]

		ctx = {
			context,
			partyA1,
			partyA2,
			partyB1,
			partyB2,
			types: cloneTypes(),
			domain: await createDomain(await context.instantLayer.getAddress()),
			quoteCallData,
			lockQuoteCallData,
			openQuoteCallData,
			bindToPartyBCallData,
			requestSendQuote,
			requestOpenQuote,
			ops,
		}
	})

	// ════════════════════════════════════════════════════════════════════════════
	// VIEW FUNCTIONS
	// ════════════════════════════════════════════════════════════════════════════

	describe("View Functions", function () {
		describe("getTemplate", function () {
			it("returns correct template data after creation", async function () {
				const templateName = "testTemplate"
				await ctx.context.instantLayer.addTemplate(templateName, ctx.ops)

				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n
				const template = await ctx.context.instantLayer.getTemplate(templateId)

				expect(template.name).to.equal(templateName)
				expect(template.active).to.be.true
				expect(template.operations.length).to.equal(ctx.ops.length)
			})

			it("returns inactive status after deactivation", async function () {
				await ctx.context.instantLayer.addTemplate("test", ctx.ops)
				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n

				await ctx.context.instantLayer.setTemplateActive(templateId, false)
				const template = await ctx.context.instantLayer.getTemplate(templateId)

				expect(template.active).to.be.false
			})
		})

		describe("getNextTemplateId", function () {
			it("returns 0 initially", async function () {
				expect(await ctx.context.instantLayer.getNextTemplateId()).to.equal(0)
			})

			it("increments after adding templates", async function () {
				await ctx.context.instantLayer.addTemplate("template1", ctx.ops)
				expect(await ctx.context.instantLayer.getNextTemplateId()).to.equal(1)

				await ctx.context.instantLayer.addTemplate("template2", ctx.ops)
				expect(await ctx.context.instantLayer.getNextTemplateId()).to.equal(2)
			})
		})

		describe("getTemplates", function () {
			it("returns empty array when no templates exist", async function () {
				const templates = await ctx.context.instantLayer.getTemplates(0, 10)
				expect(templates.length).to.equal(0)
			})

			it("returns all templates within range", async function () {
				await ctx.context.instantLayer.addTemplate("template1", ctx.ops)
				await ctx.context.instantLayer.addTemplate("template2", ctx.ops)
				await ctx.context.instantLayer.addTemplate("template3", ctx.ops)

				const templates = await ctx.context.instantLayer.getTemplates(0, 10)
				expect(templates.length).to.equal(3)
				expect(templates[0].name).to.equal("template1")
				expect(templates[1].name).to.equal("template2")
				expect(templates[2].name).to.equal("template3")
			})

			it("respects limit parameter", async function () {
				await ctx.context.instantLayer.addTemplate("template1", ctx.ops)
				await ctx.context.instantLayer.addTemplate("template2", ctx.ops)
				await ctx.context.instantLayer.addTemplate("template3", ctx.ops)

				const templates = await ctx.context.instantLayer.getTemplates(0, 2)
				expect(templates.length).to.equal(2)
				expect(templates[0].name).to.equal("template1")
				expect(templates[1].name).to.equal("template2")
			})

			it("respects startId parameter", async function () {
				await ctx.context.instantLayer.addTemplate("template1", ctx.ops)
				await ctx.context.instantLayer.addTemplate("template2", ctx.ops)
				await ctx.context.instantLayer.addTemplate("template3", ctx.ops)

				const templates = await ctx.context.instantLayer.getTemplates(1, 10)
				expect(templates.length).to.equal(2)
				expect(templates[0].name).to.equal("template2")
				expect(templates[1].name).to.equal("template3")
			})

			it("returns empty array when startId exceeds template count", async function () {
				await ctx.context.instantLayer.addTemplate("template1", ctx.ops)

				const templates = await ctx.context.instantLayer.getTemplates(5, 10)
				expect(templates.length).to.equal(0)
			})

			it("includes both active and inactive templates", async function () {
				await ctx.context.instantLayer.addTemplate("active", ctx.ops)
				await ctx.context.instantLayer.addTemplate("inactive", ctx.ops)
				await ctx.context.instantLayer.setTemplateActive(1, false)

				const templates = await ctx.context.instantLayer.getTemplates(0, 10)
				expect(templates.length).to.equal(2)
				expect(templates[0].active).to.be.true
				expect(templates[1].active).to.be.false
			})
		})

		describe("isDelegationActive", function () {
			let accountAddress: string

			beforeEach(async function () {
				await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("testAccount")
				const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 100)
				accountAddress = accounts[0].accountAddress
			})

			it("returns false when no delegation exists", async function () {
				const selector = ctx.quoteCallData.slice(0, 10) as `0x${string}`
				const isActive = await ctx.context.instantLayer.isDelegationActive(accountAddress, ctx.context.signers.admin.address, selector)
				expect(isActive).to.be.false
			})

			it("returns true when delegation is active", async function () {
				const selector = ctx.quoteCallData.slice(0, 10) as `0x${string}`
				await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: ctx.context.signers.admin.address,
					selectors: [selector],
					expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
				})

				const isActive = await ctx.context.instantLayer.isDelegationActive(accountAddress, ctx.context.signers.admin.address, selector)
				expect(isActive).to.be.true
			})

			it("returns false when delegation has expired", async function () {
				const selector = ctx.quoteCallData.slice(0, 10) as `0x${string}`
				await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: ctx.context.signers.admin.address,
					selectors: [selector],
					expiryTimestamp: (await getBlockTimestamp()) + 10n,
				})

				await increaseTime(15)

				const isActive = await ctx.context.instantLayer.isDelegationActive(accountAddress, ctx.context.signers.admin.address, selector)
				expect(isActive).to.be.false
			})
		})

		describe("nonces", function () {
			it("returns 0 for new addresses", async function () {
				const randomAddr = ethers.Wallet.createRandom().address
				expect(await ctx.context.instantLayer.nonces(randomAddr)).to.equal(0)
			})
		})

		describe("delegationNonces", function () {
			it("returns 0 for new addresses", async function () {
				const randomAddr = ethers.Wallet.createRandom().address
				expect(await ctx.context.instantLayer.delegationNonces(randomAddr)).to.equal(0)
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// PARTY B REGISTRATION
	// ════════════════════════════════════════════════════════════════════════════

	describe("PartyB Registration", function () {
		describe("registerPartyBs", function () {
			it("reverts when caller lacks SETTER_ROLE", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).registerPartyBs([ctx.partyA1.address])).to.be.reverted
			})

			it("registers single PartyB successfully", async function () {
				await ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address])

				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB1.address)).to.be.true
				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB2.address)).to.be.false
			})

			it("registers multiple PartyBs in single call", async function () {
				await ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address, ctx.partyB2.address])

				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB1.address)).to.be.true
				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB2.address)).to.be.true
				// Verify both got OPERATOR_ROLE
				expect(await ctx.context.instantLayer.hasRole(ROLES.OPERATOR_ROLE, ctx.partyB1.address)).to.be.true
				expect(await ctx.context.instantLayer.hasRole(ROLES.OPERATOR_ROLE, ctx.partyB2.address)).to.be.true
			})

			it("grants OPERATOR_ROLE to registered PartyBs", async function () {
				expect(await ctx.context.instantLayer.hasRole(ROLES.OPERATOR_ROLE, ctx.partyB1.address)).to.be.false

				await ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address])

				expect(await ctx.context.instantLayer.hasRole(ROLES.OPERATOR_ROLE, ctx.partyB1.address)).to.be.true
			})

			it("emits PartyBRegistered event", async function () {
				await expect(ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address]))
					.to.emit(ctx.context.instantLayer, "PartyBRegistered")
					.withArgs(ctx.partyB1.address)
			})

			it("reverts with empty array", async function () {
				await expect(ctx.context.instantLayer.registerPartyBs([])).to.be.revertedWithCustomError(ctx.context.instantLayer, "EmptyArray")
			})

			it("reverts when registering already-registered PartyB", async function () {
				await ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address])
				await expect(ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address]))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "PartyBAlreadyRegistered")
					.withArgs(ctx.partyB1.address)
				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB1.address)).to.be.true
			})
		})

		describe("unregisterPartyB", function () {
			beforeEach(async function () {
				await ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address])
			})

			it("reverts when caller lacks SETTER_ROLE", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).unregisterPartyB(ctx.partyB1.address)).to.be.reverted
			})

			it("removes PartyB from registry", async function () {
				await ctx.context.instantLayer.unregisterPartyB(ctx.partyB1.address)

				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB1.address)).to.be.false
				expect(await ctx.context.instantLayer.hasRole(ROLES.OPERATOR_ROLE, ctx.partyB1.address)).to.be.false
			})

			it("revokes OPERATOR_ROLE from unregistered PartyB", async function () {
				expect(await ctx.context.instantLayer.hasRole(ROLES.OPERATOR_ROLE, ctx.partyB1.address)).to.be.true

				await ctx.context.instantLayer.unregisterPartyB(ctx.partyB1.address)

				expect(await ctx.context.instantLayer.hasRole(ROLES.OPERATOR_ROLE, ctx.partyB1.address)).to.be.false
			})

			it("emits PartyBUnregistered event", async function () {
				await expect(ctx.context.instantLayer.unregisterPartyB(ctx.partyB1.address))
					.to.emit(ctx.context.instantLayer, "PartyBUnregistered")
					.withArgs(ctx.partyB1.address)
			})

			it("reverts when unregistering non-registered PartyB", async function () {
				await expect(ctx.context.instantLayer.unregisterPartyB(ctx.partyB2.address))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "PartyBNotRegistered")
					.withArgs(ctx.partyB2.address)
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// ACCOUNT LAYER CONFIGURATION
	// ════════════════════════════════════════════════════════════════════════════

	describe("AccountLayer Configuration", function () {
		describe("setAccountLayer", function () {
			it("reverts when caller lacks SETTER_ROLE", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).setAccountLayer(ctx.partyB1.address)).to.be.reverted
			})

			it("updates accountLayer address", async function () {
				const hubAddress = ctx.context.accountLayerDiamond
				await ctx.context.instantLayer.setAccountLayer(hubAddress)

				expect(await ctx.context.instantLayer.accountLayer()).to.equal(hubAddress)
				// Verify new hub is whitelisted
				expect(await ctx.context.instantLayer.whitelistedTargets(hubAddress)).to.be.true
			})

			it("reverts when setting to zero address", async function () {
				await expect(ctx.context.instantLayer.setAccountLayer(ZeroAddress)).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"UnregisteredAccountLayer",
				)
			})

			it("emits AccountLayerUpdated event", async function () {
				const newHub = ethers.Wallet.createRandom().address
				const oldHub = await ctx.context.instantLayer.accountLayer()

				await expect(ctx.context.instantLayer.setAccountLayer(newHub))
					.to.emit(ctx.context.instantLayer, "AccountLayerUpdated")
					.withArgs(oldHub, newHub)
			})

			it("auto-whitelists new accountLayer as target", async function () {
				const newHub = ethers.Wallet.createRandom().address
				await ctx.context.instantLayer.setAccountLayer(newHub)
				expect(await ctx.context.instantLayer.whitelistedTargets(newHub)).to.be.true
			})

			it("removes whitelist from old accountLayer", async function () {
				const hub1 = ctx.context.accountLayerDiamond
				const hub2 = ethers.Wallet.createRandom().address

				await ctx.context.instantLayer.setAccountLayer(hub1)
				expect(await ctx.context.instantLayer.whitelistedTargets(hub1)).to.be.true

				await ctx.context.instantLayer.setAccountLayer(hub2)
				expect(await ctx.context.instantLayer.whitelistedTargets(hub1)).to.be.false
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// TARGET WHITELIST MANAGEMENT
	// ════════════════════════════════════════════════════════════════════════════

	describe("Target Whitelist Management", function () {
		describe("setTargetWhitelist", function () {
			it("whitelists new target", async function () {
				const newTarget = ethers.Wallet.createRandom().address

				expect(await ctx.context.instantLayer.whitelistedTargets(newTarget)).to.be.false

				await expect(ctx.context.instantLayer.setTargetWhitelist(newTarget, true))
					.to.emit(ctx.context.instantLayer, "TargetWhitelistUpdated")
					.withArgs(newTarget, true)

				expect(await ctx.context.instantLayer.whitelistedTargets(newTarget)).to.be.true
			})

			it("removes target from whitelist", async function () {
				const target = ethers.Wallet.createRandom().address
				await ctx.context.instantLayer.setTargetWhitelist(target, true)

				await expect(ctx.context.instantLayer.setTargetWhitelist(target, false))
					.to.emit(ctx.context.instantLayer, "TargetWhitelistUpdated")
					.withArgs(target, false)

				expect(await ctx.context.instantLayer.whitelistedTargets(target)).to.be.false
			})

			it("reverts when caller lacks SETTER_ROLE", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).setTargetWhitelist(ctx.partyB1.address, true)).to.be.reverted
			})

			it("reverts when setting zero address", async function () {
				await expect(ctx.context.instantLayer.setTargetWhitelist(ZeroAddress, true)).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidCallData",
				)
			})

			it("symmio is whitelisted by default", async function () {
				expect(await ctx.context.instantLayer.whitelistedTargets(ctx.context.diamond)).to.be.true
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// TEMPLATE MANAGEMENT
	// ════════════════════════════════════════════════════════════════════════════

	describe("Template Management", function () {
		describe("addTemplate", function () {
			it("reverts when caller lacks SETTER_ROLE", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).addTemplate("test", ctx.ops)).to.be.reverted
			})

			it("creates active template with correct name", async function () {
				const name = "myTemplate"
				await ctx.context.instantLayer.addTemplate(name, ctx.ops)

				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n
				const template = await ctx.context.instantLayer.getTemplate(templateId)

				expect(template.name).to.equal(name)
				expect(template.active).to.be.true
				expect(template.operations.length).to.equal(ctx.ops.length)
			})

			it("stores operations correctly (including nonzero indices and insertion points)", async function () {
				const customOps = [
					{
						sourceIndices: [0, 2],
						insertionPoints: [12, 36],
						sourceOffsets: [0, 0],
					},
					{
						sourceIndices: [0],
						insertionPoints: [64],
						sourceOffsets: [0],
					},
				]
				await ctx.context.instantLayer.addTemplate("test", customOps)
				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n
				const template = await ctx.context.instantLayer.getTemplate(templateId)

				expect(template.operations.length).to.equal(customOps.length)
				for (let i = 0; i < template.operations.length; i++) {
					expect(template.operations[i].sourceIndices).to.deep.equal(customOps[i].sourceIndices)
					expect(template.operations[i].insertionPoints).to.deep.equal(customOps[i].insertionPoints)
					expect(template.operations[i].sourceOffsets).to.deep.equal(customOps[i].sourceOffsets)
				}
			})

			it("emits TemplateAdded event", async function () {
				const name = "eventTest"
				await expect(ctx.context.instantLayer.addTemplate(name, ctx.ops)).to.emit(ctx.context.instantLayer, "TemplateAdded").withArgs(0, name)
			})

			it("increments template ID sequentially", async function () {
				await ctx.context.instantLayer.addTemplate("first", ctx.ops)
				expect(await ctx.context.instantLayer.nextTemplateId()).to.equal(1)

				await ctx.context.instantLayer.addTemplate("second", ctx.ops)
				expect(await ctx.context.instantLayer.nextTemplateId()).to.equal(2)
			})

			it("reverts with empty operations array", async function () {
				await expect(ctx.context.instantLayer.addTemplate("empty", [])).to.be.revertedWithCustomError(ctx.context.instantLayer, "EmptyTemplate")
			})
		})

		describe("setTemplateActive", function () {
			beforeEach(async function () {
				await ctx.context.instantLayer.addTemplate("test", ctx.ops)
			})

			it("deactivates template", async function () {
				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n
				await ctx.context.instantLayer.setTemplateActive(templateId, false)

				const template = await ctx.context.instantLayer.getTemplate(templateId)
				expect(template.active).to.be.false
			})

			it("reactivates template", async function () {
				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n
				await ctx.context.instantLayer.setTemplateActive(templateId, false)
				await ctx.context.instantLayer.setTemplateActive(templateId, true)

				const template = await ctx.context.instantLayer.getTemplate(templateId)
				expect(template.active).to.be.true
			})

			it("emits TemplateUpdated event", async function () {
				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n
				await expect(ctx.context.instantLayer.setTemplateActive(templateId, false))
					.to.emit(ctx.context.instantLayer, "TemplateUpdated")
					.withArgs(templateId, false)
			})

			it("reverts for invalid template ID", async function () {
				const invalidId = 999n
				await expect(ctx.context.instantLayer.setTemplateActive(invalidId, false))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidTemplate")
					.withArgs(invalidId)
			})

			it("reverts when caller lacks SETTER_ROLE", async function () {
				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).setTemplateActive(templateId, false)).to.be.reverted
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// BATCH EXECUTION
	// ════════════════════════════════════════════════════════════════════════════

	describe("Batch Execution", function () {
		let execCtx: ExecutionTestContext

		async function setupExecutionContext(): Promise<ExecutionTestContext> {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
			const symmioAddress = ctx.context.diamond

			// Setup roles and registrations
			await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
			await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
			await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

			// Create account
			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("testAccount")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 100)

			// Fund account
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(accounts[0].accountAddress, decimal(30n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).internalTransfer(accounts[0].accountAddress, decimal(1000n))

			// Setup delegation
			const selectorQuote = ctx.quoteCallData.slice(0, 10)
			await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
				account: { addr: accounts[0].accountAddress, isPartyB: false },
				delegatedSigner: ctx.context.signers.admin.address,
				selectors: [selectorQuote],
				expiryTimestamp: await getBlockTimestamp(100n),
			})

			// Bind to PartyB
			await ctx.context.accountManager.connect(ctx.partyA1.signer)._call(accounts[0].accountAddress, [ctx.bindToPartyBCallData])

			// Whitelist symbol type
			await ctx.context.symbolControlFacet.whitelistSymbolType(ctx.context.symmioPartyB.getAddress(), 1)

			return { ...ctx, accounts, symmioAddress, deadline }
		}

		function createPartyASendQuoteOp(account: string, signer: string, nonce: bigint, deadline: bigint): InstantLayer.SignedOperationStruct {
			return createSignedOperation(signer, execCtx.symmioAddress, execCtx.quoteCallData, { addr: account, isPartyB: false }, nonce, deadline)
		}

		async function createPartyBLockOp(nonce: bigint, deadline: bigint): Promise<InstantLayer.SignedOperationStruct> {
			return createSignedOperation(
				await execCtx.context.symmioPartyB.getAddress(),
				execCtx.symmioAddress,
				execCtx.lockQuoteCallData,
				{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
				nonce,
				deadline,
			)
		}

		beforeEach(async function () {
			execCtx = await setupExecutionContext()
		})

		describe("executeBatch - Access Control", function () {
			it("reverts when caller lacks OPERATOR_ROLE", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).executeBatch([op], [sig], [[]], [[]])).to.be.reverted
			})
		})

		describe("executeBatch - Input Validation", function () {
			it("reverts with empty batch", async function () {
				await expect(ctx.context.instantLayer.executeBatch([], [], [], [])).to.be.revertedWithCustomError(ctx.context.instantLayer, "EmptyBatch")
			})

			it("reverts when ops and signatures length mismatch", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"ArrayLengthMismatch",
				)

				await expect(ctx.context.instantLayer.executeBatch([op, op], [sig], [[], []], [[], []])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"ArrayLengthMismatch",
				)
			})

			it("rejects MARKET_BEST_EFFORT when InstantLayer forwards an opening quote", async function () {
				const request = execCtx.requestSendQuote
				const callData = execCtx.context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
					request.partyBWhiteList,
					request.symbolId,
					request.positionType,
					OrderType.MARKET_BEST_EFFORT,
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
				const op = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					callData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const revertMessage = "PartyAFacet: MARKET_BEST_EFFORT is close-only"
				const revertData = "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [revertMessage]).slice(2)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]]))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "OperationFailed")
					.withArgs(0n, revertData)
			})
		})

		describe("executeBatch - Deadline Validation", function () {
			it("reverts when deadline has passed", async function () {
				const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 100
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, BigInt(deadline))
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Operation should succeed before deadline
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)

				// Advance time past deadline
				await time.increase(100)

				// Create new operation with same expired deadline
				const op2 = { ...op, replayAttackHeader: { ...op.replayAttackHeader, salt: generateSalt() } }
				const sig2 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op2)

				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"DeadlineExpired",
				)
			})
		})

		describe("executeBatch - Signature Validation", function () {
			it("reverts with invalid signature for PartyB", async function () {
				const op = await createPartyBLockOp(1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.hedger2, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidSignature",
				)
			})

			it("reverts when delegate lacks selector grant for partyA", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.user2.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.user2, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidDelegation",
				)
			})

			it("accepts EIP-1271 contract signatures", async function () {
				const Mock = await ethers.getContractFactory("Mock1271")
				const mock = await Mock.deploy(await execCtx.context.signers.user2.getAddress())
				await mock.waitForDeployment()

				const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)
				const expiry = now + 3600n
				const deadline = now + 600n

				const acc = { addr: execCtx.accounts[0].accountAddress, isPartyB: false }
				const selectors = execCtx.quoteCallData.slice(0, 10)

				const signedDelegation = {
					delegationInfo: {
						account: acc,
						delegatedSigner: await mock.getAddress(),
						selectors: [selectors],
						expiryTimestamp: expiry,
					},
					replayAttackHeader: { nonce: 1n, deadline, salt: ethers.id("unique-salt-1") },
				}

				const delegationSig = await execCtx.context.signers.user.signTypedData(execCtx.domain, DELEGATE_TYPES, signedDelegation)
				await ctx.context.instantLayer.connect(execCtx.partyA1.signer).grantBatchDelegationBySig(signedDelegation, delegationSig)

				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, await mock.getAddress(), 1n, deadline)
				const sig = await signOperation(execCtx.context.signers.user2, execCtx.domain, execCtx.types, op)
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

				// Verify EIP-1271 signature acceptance resulted in a valid quote
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
			})
		})

		describe("executeBatch - Replay Protection", function () {
			it("prevents replay attacks", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"MaxUsesExceeded",
				)
			})

			it("reverts with invalid nonce for ordered execution", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted
				// Nonce should be 2, not 3
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 3n, execCtx.deadline)
				const sig2 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op2)

				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidNonce",
				)
			})

			it("allows unordered batch execution with nonce=0", async function () {
				const op1 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 0n, execCtx.deadline)
				const op3 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 2n, execCtx.deadline)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op2)
				const sig3 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op3)

				// Execute with mixed nonces (1, 0, 2)
				await expect(ctx.context.instantLayer.executeBatch([op1, op2, op3], [sig1, sig2, sig3], [[], [], []], [[], [], []])).not.to.be.reverted

				// Verify all three quotes were created
				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)
				const quote3 = await ctx.context.viewFacetQuote.getQuote(3)
				expect(quote1.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote2.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote3.quoteStatus).to.equal(QuoteStatus.PENDING)

				// Verify nonce was incremented for ordered ops (1, 2) but not for salt-only (0)
				const nonce = await ctx.context.instantLayer.nonces(execCtx.accounts[0].accountAddress)
				expect(nonce).to.equal(2n)
			})

			it("allows unordered single execution with nonce=0", async function () {
				const op1 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 0n, execCtx.deadline)
				const op3 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 2n, execCtx.deadline)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op2)
				const sig3 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op3)

				// Execute individually with mixed nonces (1, 0, 2) - nonce=0 is salt-only, can be out of order
				await expect(ctx.context.instantLayer.executeBatch([op1], [sig1], [[]], [[]])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2], [[]], [[]])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op3], [sig3], [[]], [[]])).not.to.be.reverted

				// Verify all three quotes were created
				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)
				const quote3 = await ctx.context.viewFacetQuote.getQuote(3)
				expect(quote1.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote2.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote3.quoteStatus).to.equal(QuoteStatus.PENDING)
			})
		})

		describe("executeBatch - PartyB Validation", function () {
			it("reverts with unregistered PartyB", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.partyB2.address,
					target: execCtx.symmioAddress,
					callData: execCtx.lockQuoteCallData,
					signerAccount: { addr: execCtx.partyB2.address, isPartyB: true },
					flexFields: [],
					maxUses: 1,
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}
				const sig = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"UnregisteredPartyB",
				)
			})

			it("reverts when signer and account mismatch for PartyB", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: await execCtx.context.symmioPartyB.getAddress(),
					target: execCtx.symmioAddress,
					callData: execCtx.lockQuoteCallData,
					signerAccount: { addr: execCtx.partyB2.address, isPartyB: true },
					flexFields: [],
					maxUses: 1,
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}
				const sig = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]]))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "MismatchSignerAndAccount")
					.withArgs(await execCtx.context.symmioPartyB.getAddress(), execCtx.partyB2.address)
			})

			it("allows PartyB to skip signature when executing their own operations", async function () {
				// First create a quote so PartyB has something to lock
				const sendQuoteOp = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sendQuoteSig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, sendQuoteOp)
				await ctx.context.instantLayer.executeBatch([sendQuoteOp], [sendQuoteSig], [[]], [[]])

				// Verify quote was created
				const quoteBefore = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quoteBefore.quoteStatus).to.equal(QuoteStatus.PENDING)

				// Setup: Whitelist InstantLayer in SymmioPartyB's multicast whitelist
				const partyBAddress = await ctx.context.symmioPartyB.getAddress()
				const instantLayerAddress = await ctx.context.instantLayer.getAddress()
				await ctx.context.symmioPartyB.connect(ctx.context.signers.admin).setMulticastWhitelist(instantLayerAddress, true)
				await ctx.context.symmioPartyB.grantRole(ROLES.TRUSTED_ROLE, ctx.context.signers.hedger.address)

				// Create PartyB lock operation with empty signature
				const lockOp: InstantLayer.SignedOperationStruct = {
					signer: partyBAddress,
					target: execCtx.symmioAddress,
					callData: execCtx.lockQuoteCallData,
					signerAccount: { addr: partyBAddress, isPartyB: true },
					flexFields: [],
					maxUses: 1,
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				// Encode executeBatch call with empty signature
				const executeBatchCallData = ctx.context.instantLayer.interface.encodeFunctionData("executeBatch", [[lockOp], ["0x"], [[]], [[]]])

				// PartyB calls InstantLayer.executeBatch via _multicastCall (msg.sender = PartyB contract)
				// This should succeed because PartyB is executing their own operation, so signature is skipped
				await expect(ctx.context.symmioPartyB.connect(ctx.context.signers.hedger)._multicastCall([instantLayerAddress], [executeBatchCallData])).not
					.to.be.reverted

				// Verify the quote was locked
				const quoteAfter = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.LOCKED)
			})

			it("allows PartyA owner to skip signature when executing their own operations", async function () {
				// Admin (account owner) has OPERATOR_ROLE and is the signer
				// When admin calls executeBatch with their own operation, signature should be skipped
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)

				// Admin calls executeBatch with empty signature for their own operation
				// This should succeed because signer == msg.sender
				await expect(ctx.context.instantLayer.executeBatch([op], ["0x"], [[]], [[]])).not.to.be.reverted

				// Verify the quote was created
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
			})

			it("allows delegate to skip signature when executing delegated operations", async function () {
				// Setup: Grant delegation to user2 for sendQuoteWithAffiliate
				const selector = ctx.context.partyAFacet.interface.getFunction("sendQuoteWithAffiliate").selector as `0x${string}`
				await ctx.context.instantLayer.connect(execCtx.partyA1.signer).grantDelegation({
					account: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					delegatedSigner: ctx.context.signers.user2.address,
					selectors: [selector],
					expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
				})

				// Grant OPERATOR_ROLE to user2 so they can call executeBatch
				await ctx.context.instantLayer.grantRole(ROLES.OPERATOR_ROLE, ctx.context.signers.user2.address)

				// Create operation with user2 as signer (delegated)
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, ctx.context.signers.user2.address, 1n, execCtx.deadline)

				// User2 calls executeBatch with empty signature for their delegated operation
				// This should succeed because signer == msg.sender and delegation is valid
				await expect(ctx.context.instantLayer.connect(ctx.context.signers.user2).executeBatch([op], ["0x"], [[]], [[]])).not.to.be.reverted

				// Verify the quote was created
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
			})

			it("still requires signature when signer is not the executor", async function () {
				// First create a quote so PartyB has something to lock
				const sendQuoteOp = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sendQuoteSig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, sendQuoteOp)
				await ctx.context.instantLayer.executeBatch([sendQuoteOp], [sendQuoteSig], [[]], [[]])

				// Create PartyB lock operation with empty signature
				const partyBAddress = await ctx.context.symmioPartyB.getAddress()
				const lockOp: InstantLayer.SignedOperationStruct = {
					signer: partyBAddress,
					target: execCtx.symmioAddress,
					callData: execCtx.lockQuoteCallData,
					signerAccount: { addr: partyBAddress, isPartyB: true },
					flexFields: [],
					maxUses: 1,
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				// Admin (not PartyB) calls executeBatch with empty signature - should fail
				// Because msg.sender != signer, signature verification is required
				await expect(ctx.context.instantLayer.executeBatch([lockOp], ["0x"], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidSignature",
				)
			})

			it("still requires signature for PartyA when owner is not the executor", async function () {
				// Create operation signed by partyA1 (owner)
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 1n, execCtx.deadline)

				// Admin calls executeBatch with empty signature for partyA1's operation - should fail
				// Because msg.sender (admin) != signer (partyA1), signature verification is required
				await expect(ctx.context.instantLayer.executeBatch([op], ["0x"], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidSignature",
				)
			})
		})

		describe("executeBatch - Operation Execution", function () {
			it("executes single operation successfully", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.requestedOpenPrice).to.equal(execCtx.requestSendQuote.price)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
				expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
			})

			it("executes sendQuoteWithAffiliateAndData successfully", async function () {
				// This test verifies sendQuoteWithAffiliateAndData has the correct selector (0xa7f3b34b)
				// and can be executed via InstantLayer

				// Encode sendQuoteWithAffiliateAndData call data (note: no maxFundingRate, but has data param)
				const quoteWithDataCallData = ctx.context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliateAndData", [
					execCtx.requestSendQuote.partyBWhiteList,
					execCtx.requestSendQuote.symbolId,
					execCtx.requestSendQuote.positionType,
					execCtx.requestSendQuote.orderType,
					execCtx.requestSendQuote.price,
					execCtx.requestSendQuote.quantity,
					execCtx.requestSendQuote.cva,
					execCtx.requestSendQuote.lf,
					execCtx.requestSendQuote.partyAmm,
					execCtx.requestSendQuote.partyBmm,
					await execCtx.requestSendQuote.deadline,
					execCtx.requestSendQuote.affiliate,
					await execCtx.requestSendQuote.upnlSig,
					"0xdeadbeef", // arbitrary data bytes
				])

				// Verify the selector is correct (0xa7f3b34b)
				expect(quoteWithDataCallData.slice(0, 10)).to.equal("0xa7f3b34b")

				// Grant delegation for sendQuoteWithAffiliateAndData selector
				const selectorQuoteWithData = quoteWithDataCallData.slice(0, 10) as `0x${string}`
				await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
					account: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					delegatedSigner: ctx.context.signers.admin.address,
					selectors: [selectorQuoteWithData],
					expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
				})

				const op = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					quoteWithDataCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

				// Verify all decoded parameters are correct
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
				// Verify LibQuoteParams.decodeQuoteParams decoded these correctly:
				expect(quote.symbolId).to.equal(execCtx.requestSendQuote.symbolId)
				expect(quote.positionType).to.equal(execCtx.requestSendQuote.positionType)
				expect(quote.orderType).to.equal(execCtx.requestSendQuote.orderType)
				expect(quote.requestedOpenPrice).to.equal(execCtx.requestSendQuote.price)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
				expect(quote.lockedValues.cva).to.equal(execCtx.requestSendQuote.cva)
				expect(quote.lockedValues.lf).to.equal(execCtx.requestSendQuote.lf)
				expect(quote.lockedValues.partyAmm).to.equal(execCtx.requestSendQuote.partyAmm)
			})

			it("executes multiple operations in batch", async function () {
				const op1 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 2n, execCtx.deadline)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op2)

				await expect(ctx.context.instantLayer.executeBatch([op1, op2], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)

				expect(quote1.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote2.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote1.quantity).to.equal(execCtx.requestSendQuote.quantity)
				expect(quote2.quantity).to.equal(execCtx.requestSendQuote.quantity)
				expect(quote1.requestedOpenPrice).to.equal(execCtx.requestSendQuote.price)
				expect(quote2.requestedOpenPrice).to.equal(execCtx.requestSendQuote.price)
			})

			it("executes mixed PartyA and PartyB operations", async function () {
				const op1 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const op2 = await createPartyBLockOp(1n, execCtx.deadline)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op2)

				await expect(ctx.context.instantLayer.executeBatch([op1, op2], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

				// Verify quote was created (by PartyA) and locked (by PartyB) in same batch
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.LOCKED)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
			})
		})

		describe("executeBatch - Error Handling", function () {
			it("bubbles inner target failures with OperationFailed", async function () {
				// Try to lock a quote before creating one
				const op = await createPartyBLockOp(1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"OperationFailed",
				)
			})

			it("short-circuits on first failure", async function () {
				// First op fails (lock before send), second would succeed
				const opFail = await createPartyBLockOp(1n, execCtx.deadline)
				const opSuccess = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)

				const sigFail = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, opFail)
				const sigSuccess = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, opSuccess)

				await expect(
					ctx.context.instantLayer.executeBatch([opFail, opSuccess], [sigFail, sigSuccess], [[], []], [[], []]),
				).to.be.revertedWithCustomError(ctx.context.instantLayer, "OperationFailed")
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// FLEX FIELDS
	// ════════════════════════════════════════════════════════════════════════════

	describe("Flex Fields", function () {
		let execCtx: ExecutionTestContext

		async function setupFlexContext(): Promise<ExecutionTestContext> {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
			const symmioAddress = ctx.context.diamond

			await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
			await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
			await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("testAccount")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 100)

			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(accounts[0].accountAddress, decimal(30n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).internalTransfer(accounts[0].accountAddress, decimal(1000n))

			const selectorQuote = ctx.quoteCallData.slice(0, 10)
			await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
				account: { addr: accounts[0].accountAddress, isPartyB: false },
				delegatedSigner: ctx.context.signers.admin.address,
				selectors: [selectorQuote],
				expiryTimestamp: await getBlockTimestamp(100n),
			})

			await ctx.context.accountManager.connect(ctx.partyA1.signer)._call(accounts[0].accountAddress, [ctx.bindToPartyBCallData])
			await ctx.context.symbolControlFacet.whitelistSymbolType(ctx.context.symmioPartyB.getAddress(), 1)

			return { ...ctx, accounts, symmioAddress, deadline }
		}

		beforeEach(async function () {
			execCtx = await setupFlexContext()
		})

		describe("modifier == msg.sender", function () {
			it("should execute operation with flex field filled by operator (msg.sender) and apply the new value", async function () {
				// The sendQuoteWithAffiliate calldata has a `quantity` parameter.
				// We'll mark it as a flex field and have the operator (admin, who is msg.sender) fill it
				// with a DIFFERENT value to prove the fill actually modifies the calldata.
				// Params: partyBWhiteList(dynamic), symbolId, positionType, orderType, price, quantity, ...
				// partyBWhiteList is dynamic so it's a pointer at offset 0.
				// symbolId at offset 32, positionType at 64, orderType at 96, price at 128, quantity at 160.
				const quantityOffset = 160 // byte offset of quantity param (after selector)
				const newQuantity = decimal(77n) // different from requestSendQuote.quantity

				// Create operation with a flex field on the quantity parameter
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Fill the quantity field with a DIFFERENT value from the original calldata
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newQuantity])

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).not.to.be.reverted

				// Verify the NEW fill value was applied — not the original calldata value
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quantity).to.equal(newQuantity)
				expect(quote.quantity).to.not.equal(execCtx.requestSendQuote.quantity)
			})
		})

		describe("modifier != msg.sender (signature required)", function () {
			it("should execute when filler signs the fill value and apply the new value", async function () {
				const quantityOffset = 160
				const newQuantity = decimal(88n) // different from requestSendQuote.quantity

				// modifier is user2 (not the operator/admin who calls executeBatch)
				const modifierSigner = execCtx.context.signers.user2
				const modifierAddress = await modifierSigner.getAddress()

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: modifierAddress }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newQuantity])

				// Compute the operation hash to sign the fill
				const opHash = await ctx.context.instantLayer.getOperationHash(op)

				// Modifier signs the fill authorization
				const modifierSig = await modifierSigner.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash,
					fieldIndex: 0,
					value: quantityValue,
				})

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [[modifierSig]])).not.to.be.reverted

				// Verify the filler's new value was applied — not the original calldata value
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quantity).to.equal(newQuantity)
				expect(quote.quantity).to.not.equal(execCtx.requestSendQuote.quantity)
			})

			it("should revert when filler signature is invalid", async function () {
				const quantityOffset = 160
				const modifierAddress = await execCtx.context.signers.user2.getAddress()

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: modifierAddress }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// Use a wrong signer for the modifier signature (hedger instead of user2)
				const opHash = await ctx.context.instantLayer.getOperationHash(op)
				const wrongModifierSig = await execCtx.context.signers.hedger.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash,
					fieldIndex: 0,
					value: quantityValue,
				})

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [[wrongModifierSig]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidFlexFillerSignature",
				)
			})
		})

		describe("Multi-use operations", function () {
			it("should allow executing the same flex operation multiple times with correct state", async function () {
				const quantityOffset = 160
				const fillQuantity = decimal(42n)

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 0, // unlimited
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [fillQuantity])

				// Execute twice with the same operation
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).not.to.be.reverted

				// Verify both quotes were created with the flex-filled quantity
				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)
				expect(quote1.quantity).to.equal(fillQuantity)
				expect(quote2.quantity).to.equal(fillQuantity)
			})

			it("should respect maxUses limit", async function () {
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 2,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// First two succeed
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).not.to.be.reverted

				// Third fails
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"MaxUsesExceeded",
				)
			})
		})

		describe("Multiple fields with different modifiers", function () {
			it("should allow different fillers for different fields and apply both values", async function () {
				const quantityOffset = 160 // quantity param
				const priceOffset = 128 // price param

				const modifier1 = execCtx.context.signers.admin // msg.sender, no sig needed
				const modifier2 = execCtx.context.signers.user2

				const newPrice = decimal(777n)
				const newQuantity = decimal(33n)

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [
						{ offset: priceOffset, length: 32, authorizedFlexFiller: modifier1.address },
						{ offset: quantityOffset, length: 32, authorizedFlexFiller: await modifier2.getAddress() },
					],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				const priceValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newPrice])
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newQuantity])

				// modifier2 signs their field
				const opHash = await ctx.context.instantLayer.getOperationHash(op)
				const modifier2Sig = await modifier2.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash,
					fieldIndex: 1,
					value: quantityValue,
				})

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[priceValue, quantityValue]], [["0x", modifier2Sig]])).not.to.be.reverted

				// Verify both fillers' values were applied
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.requestedOpenPrice).to.equal(newPrice)
				expect(quote.quantity).to.equal(newQuantity)
			})
		})

		describe("Validation", function () {
			it("should revert when fill values length mismatches flex fields", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 160, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Provide no fill values for 1 flex field
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidFlexFillLength",
				)
			})

			it("should revert when fill value byte length mismatches field length", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 160, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Provide a 64-byte value for a 32-byte field
				const wrongLengthValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [1, 2])
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[wrongLengthValue]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidFlexFillValueLength",
				)
			})

			it("should revert when flex field offset is out of calldata bounds", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 99999, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const value = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1])

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[value]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"FlexFieldOutOfBounds",
				)
			})

			it("should revert when filler sigs length mismatches flex fields", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [
						{ offset: 128, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
						{ offset: 160, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
					],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const value = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1])

				// Provide 2 fill values but only 1 modifier sig
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[value, value]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"ArrayLengthMismatch",
				)
			})
		})

		describe("Zero-length flex field edge case", function () {
			it("should succeed with length:0 flex field when fill is empty (no-op field)", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 160, length: 0, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Empty fill for zero-length field — should be a no-op
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [["0x"]], [["0x"]])).not.to.be.reverted

				// Verify original calldata was used unchanged
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
				expect(quote.requestedOpenPrice).to.equal(execCtx.requestSendQuote.price)
			})
		})

		describe("Optional fill (filler keeps user value)", function () {
			it("should skip flex field injection when fill value is empty bytes", async function () {
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Pass empty bytes "0x" as fill value — filler accepts the user's original value
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [["0x"]], [["0x"]])).not.to.be.reverted

				// Verify quote was created with the original quantity from the user's calldata
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
			})

			it("should allow mixing filled and skipped flex fields in same operation", async function () {
				const priceOffset = 128
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [
						{ offset: priceOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
						{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
					],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Fill price (field 0) but skip quantity (field 1 = empty bytes)
				const priceValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.price])

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[priceValue, "0x"]], [["0x", "0x"]])).not.to.be.reverted

				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.requestedOpenPrice).to.equal(execCtx.requestSendQuote.price)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
			})
		})

		describe("Filler signature reuse on multi-use ops", function () {
			it("should allow reusing the same filler signature on multi-use operations with correct state", async function () {
				const quantityOffset = 160
				const fillerSigner = execCtx.context.signers.user2
				const fillerAddress = await fillerSigner.getAddress()
				const fillQuantity = decimal(55n)

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: fillerAddress }],
					maxUses: 0,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [fillQuantity])
				const opHash = await ctx.context.instantLayer.getOperationHash(op)

				// Filler signs once (no nonce needed)
				const fillerSig = await fillerSigner.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash,
					fieldIndex: 0,
					value: quantityValue,
				})

				// Same signature works on both executions
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [[fillerSig]])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [[fillerSig]])).not.to.be.reverted

				// Verify both quotes got the filler's value
				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)
				expect(quote1.quantity).to.equal(fillQuantity)
				expect(quote2.quantity).to.equal(fillQuantity)
			})
		})

		describe("maxUses edge cases", function () {
			it("should allow unlimited replay when maxUses=0 without flex fields", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [],
					maxUses: 0,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Execute twice — both should succeed
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

				// Verify both quotes were created
				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)
				expect(quote1.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote2.quoteStatus).to.equal(QuoteStatus.PENDING)
			})

			it("should accept different fill values each time with maxUses=0", async function () {
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 0,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// First execution with quantity A
				const quantityA = decimal(50n)
				const quantityValueA = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [quantityA])
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValueA]], [["0x"]])).not.to.be.reverted

				// Second execution with quantity B (different)
				const quantityB = decimal(75n)
				const quantityValueB = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [quantityB])
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValueB]], [["0x"]])).not.to.be.reverted

				// Verify the two quotes have different quantities
				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)
				expect(quote1.quantity).to.equal(quantityA)
				expect(quote2.quantity).to.equal(quantityB)
				expect(quote1.quantity).to.not.equal(quote2.quantity)
			})

			it("should prevent second execution with maxUses=1 even with different fill", async function () {
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// First execution succeeds
				const quantityValueA = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValueA]], [["0x"]])).not.to.be.reverted

				// Second execution with a different fill value should revert
				const quantityValueB = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [decimal(99n)])
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValueB]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"MaxUsesExceeded",
				)
			})

			it("should increment operationUsageCount correctly", async function () {
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 3,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// Execute twice
				await ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])
				await ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])

				// Read operationUsageCount and verify it equals 2
				const opHash = await ctx.context.instantLayer.getOperationHash(op)
				const usageCount = await ctx.context.instantLayer.operationUsageCount(opHash)
				expect(usageCount).to.equal(2n)
			})
		})

		describe("Nonce interaction", function () {
			it("should work with sequential nonce and flex fields", async function () {
				const quantityOffset = 160

				// First operation with nonce=1
				const op1: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				await expect(ctx.context.instantLayer.executeBatch([op1], [sig1], [[quantityValue]], [["0x"]])).not.to.be.reverted

				// Verify nonce incremented to 1
				const nonceAfterFirst = await ctx.context.instantLayer.nonces(execCtx.accounts[0].accountAddress)
				expect(nonceAfterFirst).to.equal(1n)

				// Second operation with nonce=2
				const op2: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 2n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig2 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op2)

				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2], [[quantityValue]], [["0x"]])).not.to.be.reverted

				// Verify nonce incremented to 2
				const nonceAfterSecond = await ctx.context.instantLayer.nonces(execCtx.accounts[0].accountAddress)
				expect(nonceAfterSecond).to.equal(2n)
			})

			it("should fail nonce check on second execution when nonce>0 with maxUses=0", async function () {
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 0, // unlimited uses
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// First execution succeeds — nonce goes from 0 to 1
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).not.to.be.reverted

				// Second execution of the SAME operation fails because nonce in op is 1 but expected nonce is now 2
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidNonce",
				)
			})
		})

		describe("Deadline interaction", function () {
			it("should revert with expired deadline before flex fills are processed", async function () {
				const quantityOffset = 160

				// Create a deadline that's only 10 seconds ahead
				const shortDeadline = await getBlockTimestamp(10n)

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: shortDeadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// Advance time past the deadline
				await time.increase(20)

				// Execution should revert with DeadlineExpired, not any flex-related error
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"DeadlineExpired",
				)
			})
		})

		describe("Batch array length validation", function () {
			it("should revert when fills array length mismatches signedOps", async function () {
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// 1 operation but 0 fills — should revert with ArrayLengthMismatch
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"ArrayLengthMismatch",
				)
			})

			it("should revert when flexFillerSignatures array length mismatches signedOps", async function () {
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// 1 operation, 1 fill, but 0 flexFillerSignatures — should revert with ArrayLengthMismatch
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[quantityValue]], [])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"ArrayLengthMismatch",
				)
			})
		})

		describe("Hash integrity", function () {
			it("should revert with InvalidSignature when flexFields are tampered after signing", async function () {
				const quantityOffset = 160
				// Use partyA1 (account owner) as signer — NOT admin (msg.sender) — so signature is actually verified
				const signer = execCtx.partyA1.signer

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.partyA1.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(signer, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// Tamper with the flex field offset after signing
				const tamperedOp = {
					...op,
					flexFields: [{ offset: 128, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
				}

				await expect(ctx.context.instantLayer.executeBatch([tamperedOp], [sig], [[quantityValue]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidSignature",
				)
			})

			it("should revert with InvalidSignature when authorizedFlexFiller is tampered after signing", async function () {
				const quantityOffset = 160
				const signer = execCtx.partyA1.signer

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.partyA1.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.user2.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(signer, execCtx.domain, execCtx.types, op)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// Tamper: change authorizedFlexFiller to msg.sender (admin) to bypass filler sig check
				const tamperedOp = {
					...op,
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
				}

				await expect(ctx.context.instantLayer.executeBatch([tamperedOp], [sig], [[quantityValue]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidSignature",
				)
			})

			it("should revert with InvalidSignature when flexFields are removed after signing", async function () {
				const quantityOffset = 160
				const signer = execCtx.partyA1.signer

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.partyA1.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(signer, execCtx.domain, execCtx.types, op)

				// Tamper: remove all flex fields
				const tamperedOp = { ...op, flexFields: [] }

				await expect(ctx.context.instantLayer.executeBatch([tamperedOp], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidSignature",
				)
			})

			it("should produce different hashes for different flexFields", async function () {
				const baseOp = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				// Operation with no flex fields
				const opNoFlex: InstantLayer.SignedOperationStruct = {
					...baseOp,
					flexFields: [],
				}

				// Operation with a flex field (same base params, same salt)
				const opWithFlex: InstantLayer.SignedOperationStruct = {
					...baseOp,
					flexFields: [{ offset: 160, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
				}

				const hashNoFlex = await ctx.context.instantLayer.getOperationHash(opNoFlex)
				const hashWithFlex = await ctx.context.instantLayer.getOperationHash(opWithFlex)

				expect(hashNoFlex).to.not.equal(hashWithFlex)
			})

			it("should produce different hashes for different maxUses", async function () {
				const salt = generateSalt()

				const op1: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 160, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt },
				}

				const op5: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 160, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 5,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt },
				}

				const hash1 = await ctx.context.instantLayer.getOperationHash(op1)
				const hash5 = await ctx.context.instantLayer.getOperationHash(op5)

				expect(hash1).to.not.equal(hash5)
			})
		})

		describe("Filler signature binding", function () {
			it("should revert when filler signs with wrong opHash", async function () {
				const quantityOffset = 160
				const fillerSigner = execCtx.context.signers.user2
				const fillerAddress = await fillerSigner.getAddress()

				// Create two operations with different salts (different opHashes)
				const op1: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: fillerAddress }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const op2: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: fillerAddress }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig2 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op2)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// Filler signs for op1's hash
				const op1Hash = await ctx.context.instantLayer.getOperationHash(op1)
				const fillerSig = await fillerSigner.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash: op1Hash,
					fieldIndex: 0,
					value: quantityValue,
				})

				// Try to use op1's filler signature for op2 — should revert
				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2], [[quantityValue]], [[fillerSig]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidFlexFillerSignature",
				)
			})

			it("should revert when filler signs with wrong fieldIndex", async function () {
				const priceOffset = 128
				const quantityOffset = 160
				const fillerSigner = execCtx.context.signers.user2
				const fillerAddress = await fillerSigner.getAddress()

				// Operation with 2 flex fields, both for the same filler
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [
						{ offset: priceOffset, length: 32, authorizedFlexFiller: fillerAddress },
						{ offset: quantityOffset, length: 32, authorizedFlexFiller: fillerAddress },
					],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const priceValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.price])
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				const opHash = await ctx.context.instantLayer.getOperationHash(op)

				// Filler signs for fieldIndex=1 but we provide that signature at fieldIndex=0
				const fillerSigForField1 = await fillerSigner.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash,
					fieldIndex: 1,
					value: quantityValue,
				})

				// Correct sig for field 1
				const fillerSigForField1Correct = await fillerSigner.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash,
					fieldIndex: 1,
					value: quantityValue,
				})

				// Use field1's signature at field0 position — should revert
				await expect(
					ctx.context.instantLayer.executeBatch([op], [sig], [[priceValue, quantityValue]], [[fillerSigForField1, fillerSigForField1Correct]]),
				).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidFlexFillerSignature")
			})

			it("should revert when filler signs with wrong value", async function () {
				const quantityOffset = 160
				const fillerSigner = execCtx.context.signers.user2
				const fillerAddress = await fillerSigner.getAddress()

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: fillerAddress }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const opHash = await ctx.context.instantLayer.getOperationHash(op)

				// Filler signs for value X
				const valueX = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [decimal(100n)])
				const fillerSig = await fillerSigner.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash,
					fieldIndex: 0,
					value: valueX,
				})

				// Operator provides value Y (different from what filler signed)
				const valueY = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [decimal(200n)])
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[valueY]], [[fillerSig]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidFlexFillerSignature",
				)
			})

			it("should not allow filler signature reuse across different operations", async function () {
				const quantityOffset = 160
				const fillerSigner = execCtx.context.signers.user2
				const fillerAddress = await fillerSigner.getAddress()

				// Two operations with identical params but different salts
				const salt1 = generateSalt()
				const salt2 = generateSalt()

				const op1: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: fillerAddress }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: salt1 },
				}

				const op2: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: fillerAddress }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: salt2 },
				}

				const sig2 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op2)
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [execCtx.requestSendQuote.quantity])

				// Filler signs fill for op1
				const op1Hash = await ctx.context.instantLayer.getOperationHash(op1)
				const fillerSig = await fillerSigner.signTypedData(execCtx.domain, FLEX_FILLER_AUTH_TYPES, {
					opHash: op1Hash,
					fieldIndex: 0,
					value: quantityValue,
				})

				// Try to use op1's filler signature on op2 — should revert because opHash differs
				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2], [[quantityValue]], [[fillerSig]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidFlexFillerSignature",
				)
			})
		})

		describe("Overlapping and adjacent fields", function () {
			it("should apply adjacent flex fields correctly without corruption", async function () {
				const priceOffset = 128 // price param
				const quantityOffset = 160 // quantity param

				const newPrice = decimal(500n)
				const newQuantity = decimal(50n)

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [
						{ offset: priceOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
						{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
					],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				const priceValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newPrice])
				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newQuantity])

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[priceValue, quantityValue]], [["0x", "0x"]])).not.to.be.reverted

				// Verify both values were correctly applied
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.requestedOpenPrice).to.equal(newPrice)
				expect(quote.quantity).to.equal(newQuantity)
			})

			it("should apply last write wins for overlapping flex fields", async function () {
				// First field covers 64 bytes starting at offset 128 (covers price + quantity)
				// Second field covers 32 bytes at offset 160 (just quantity)
				// Both filled by msg.sender. Second field overwrites the quantity region.
				const wideOffset = 128
				const narrowOffset = 160

				const widePrice = decimal(500n)
				const wideQuantity = decimal(50n)
				const narrowQuantity = decimal(99n)

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [
						{ offset: wideOffset, length: 64, authorizedFlexFiller: execCtx.context.signers.admin.address },
						{ offset: narrowOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
					],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Wide fill covers price (128) + quantity (160)
				const wideValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [widePrice, wideQuantity])
				// Narrow fill overwrites just quantity (160)
				const narrowValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [narrowQuantity])

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[wideValue, narrowValue]], [["0x", "0x"]])).not.to.be.reverted

				// Price should be from the wide field, quantity from the narrow (last write wins)
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.requestedOpenPrice).to.equal(widePrice)
				expect(quote.quantity).to.equal(narrowQuantity)
			})
		})

		describe("Boundary offsets", function () {
			it("should succeed with flex field at offset 0 (first parameter)", async function () {
				// The first parameter (partyBWhiteList dynamic pointer) is at offset 0
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 0, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Fill with the same value that's already there (the dynamic pointer)
				// Extract the original 32 bytes at offset 0 (after selector) from calldata
				const originalValue = "0x" + execCtx.quoteCallData.slice(10, 10 + 64)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[originalValue]], [["0x"]])).not.to.be.reverted
			})

			it("should succeed with flex field at exact end boundary", async function () {
				// calldata length in bytes = (hex length - 2) / 2 for "0x" prefix
				// After selector, the available region is calldataLength - 4 bytes
				// offset + length must be <= calldataLength - 4
				const calldataBytes = ethers.getBytes(execCtx.quoteCallData)
				const availableAfterSelector = calldataBytes.length - 4
				// Place a 32-byte field at the very end
				const endOffset = availableAfterSelector - 32

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: endOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Fill with original bytes at that offset
				const hexOffset = 10 + endOffset * 2 // 10 = "0x" + 4-byte selector in hex
				const originalValue = "0x" + execCtx.quoteCallData.slice(hexOffset, hexOffset + 64)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[originalValue]], [["0x"]])).not.to.be.reverted
			})

			it("should revert with flex field one byte past end", async function () {
				const calldataBytes = ethers.getBytes(execCtx.quoteCallData)
				const availableAfterSelector = calldataBytes.length - 4
				// offset + length = availableAfterSelector + 1 — one byte past end
				const pastEndOffset = availableAfterSelector - 31

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: pastEndOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)
				const value = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1])

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[value]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"FlexFieldOutOfBounds",
				)
			})

			it("should revert for out-of-bounds flex field even with empty fill", async function () {
				// Even with empty fill "0x", bounds check should still trigger
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 999999, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [["0x"]], [["0x"]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"FlexFieldOutOfBounds",
				)
			})
		})

		describe("All fills skipped", function () {
			it("should execute with original calldata unchanged when all fills are empty", async function () {
				const priceOffset = 128
				const quantityOffset = 160

				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [
						{ offset: priceOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
						{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address },
					],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Both fills are empty — original calldata should be used as-is
				await expect(ctx.context.instantLayer.executeBatch([op], [sig], [["0x", "0x"]], [["0x", "0x"]])).not.to.be.reverted

				// Verify quote was created with original values
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.requestedOpenPrice).to.equal(execCtx.requestSendQuote.price)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
			})
		})

		describe("TPSL scenario (requestToClosePosition)", function () {
			it("should forward MARKET_BEST_EFFORT value 2 through the unchanged close selector", async function () {
				// Step 1: Open a position via template (sendQuote → lockQuote → openPosition)
				const lockQuoteCallDataTemplate = ctx.context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [
					0,
					await getDummySingleUpnlSig(10n),
				])
				const openQuoteCallDataTemplate = ctx.context.partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
					0,
					execCtx.requestOpenQuote.filledAmount,
					execCtx.requestOpenQuote.openPrice,
					await getDummyPairUpnlAndPriceSig(10n),
				])

				await ctx.context.instantLayer.addTemplate("sendLockOpen", [
					{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
					{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
					{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
				])
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

				const sendOp = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const lockOp = createSignedOperation(
					await execCtx.context.symmioPartyB.getAddress(),
					execCtx.symmioAddress,
					lockQuoteCallDataTemplate,
					{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
					1n,
					execCtx.deadline,
				)
				const openOp = createSignedOperation(
					await execCtx.context.symmioPartyB.getAddress(),
					execCtx.symmioAddress,
					openQuoteCallDataTemplate,
					{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
					2n,
					execCtx.deadline,
				)

				const sendSig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, sendOp)
				const lockSig = await signOperation(ctx.partyB1.signer, execCtx.domain, execCtx.types, lockOp)
				const openSig = await signOperation(ctx.partyB1.signer, execCtx.domain, execCtx.types, openOp)

				await ctx.context.instantLayer.executeTemplate(templateId, [sendOp, lockOp, openOp], [sendSig, lockSig, openSig], [[], [], []], [[], [], []])

				// Verify position is open
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.OPENED)

				// Step 2: USER signs a close request with flex field on quantityToClose.
				// The TPSL bot (admin) is only the flex filler — no delegation needed.
				// requestToClosePosition(uint256 quoteId, uint256 closePrice, uint256 quantityToClose, OrderType orderType, uint256 deadline)
				// Offsets: quoteId=0, closePrice=32, quantityToClose=64, orderType=96, deadline=128
				const closeDeadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
				const closeCallData = ctx.context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					1, // quoteId
					execCtx.requestOpenQuote.openPrice, // closePrice
					0, // quantityToClose placeholder — flex filler will provide
					OrderType.MARKET_BEST_EFFORT,
					closeDeadline,
				])

				// User signs the flex op; TPSL bot (admin) is the authorizedFlexFiller
				const closeOp: InstantLayer.SignedOperationStruct = {
					signer: execCtx.partyA1.address, // USER is the signer
					target: execCtx.symmioAddress,
					callData: closeCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: 64, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 0, // unlimited — bot can trigger multiple times until deadline
					replayAttackHeader: { nonce: 0n, deadline: closeDeadline, salt: generateSalt() },
				}

				const closeSig = await signOperation(execCtx.partyA1.signer, execCtx.domain, execCtx.types, closeOp)

				// Bot fills quantityToClose with the full position quantity
				const quantityToClose = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [quote.quantity])

				await expect(ctx.context.instantLayer.executeBatch([closeOp], [closeSig], [[quantityToClose]], [["0x"]])).not.to.be.reverted

				// Verify close was requested
				const quoteAfter = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
				expect(quoteAfter.quantityToClose).to.equal(quote.quantity)
				expect(quoteAfter.orderType).to.equal(OrderType.MARKET_BEST_EFFORT)
			})
		})

		describe("Muon signature replacement in sendQuote", function () {
			it("should store market price from replacement sig when solver replaces upnlSig via flex field", async function () {
				// sendQuoteWithAffiliate has 14 params. The upnlSig (param index 13) is a dynamic struct.
				// Head layout: 14 slots × 32 bytes = 448 bytes
				// Slot 13 (offset 416) holds the offset pointer to the upnlSig data in the tail.
				//
				// The contract stores upnlSig.price as quote.marketPrice (PartyAFacetImpl.sol:124):
				//   Quote memory quote = Quote({ ..., marketPrice: upnlSig.price, ... })
				//
				// Strategy:
				// 1. Send quote with sigA (price=100e18) directly → verify quote.marketPrice == 100e18
				// 2. Send quote with sigB_placeholder (price=200e18) in calldata, but solver replaces
				//    with sigC (price=300e18) via flex fill → verify quote.marketPrice == 300e18
				// This proves the replacement sig's price is what ends up in the quote.

				const { partyAFacet } = execCtx.context
				const solverSigner = execCtx.context.signers.admin
				const priceA = decimal(100n)
				const priceB = decimal(200n) // placeholder — will be replaced
				const priceC = decimal(300n) // the replacement

				const encodeQuoteCallData = async (upnlSig: any) =>
					partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
						execCtx.requestSendQuote.partyBWhiteList,
						execCtx.requestSendQuote.symbolId,
						execCtx.requestSendQuote.positionType,
						execCtx.requestSendQuote.orderType,
						execCtx.requestSendQuote.price,
						execCtx.requestSendQuote.quantity,
						execCtx.requestSendQuote.cva,
						execCtx.requestSendQuote.lf,
						execCtx.requestSendQuote.partyAmm,
						execCtx.requestSendQuote.partyBmm,
						execCtx.requestSendQuote.maxFundingRate,
						await execCtx.requestSendQuote.deadline,
						execCtx.requestSendQuote.affiliate,
						upnlSig,
					])

				// Helper: calculate upnlSig byte region from encoded calldata
				function getUpnlSigRegion(callData: string) {
					const paramsHex = callData.slice(10) // strip "0x" + 4-byte selector
					const dataStart = Number(BigInt("0x" + paramsHex.slice(416 * 2, (416 + 32) * 2)))
					const dataLength = paramsHex.length / 2 - dataStart
					return { dataStart, dataLength }
				}

				// Helper: extract upnlSig bytes from encoded calldata
				function extractUpnlSigBytes(callData: string, dataStart: number) {
					return "0x" + callData.slice(10).slice(dataStart * 2)
				}

				// ── Step 1: Send quote directly with sigA (price=100e18) ──
				const sigA = await getDummySingleUpnlAndPriceSig(priceA)
				const callDataA = await encodeQuoteCallData(sigA)

				const opA = createSignedOperation(
					solverSigner.address,
					execCtx.symmioAddress,
					callDataA,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					0n,
					execCtx.deadline,
				)
				const eipSigA = await signOperation(solverSigner, execCtx.domain, execCtx.types, opA)

				await expect(ctx.context.instantLayer.executeBatch([opA], [eipSigA], [[]], [[]])).not.to.be.reverted

				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote1.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote1.marketPrice).to.equal(priceA) // sigA's price stored

				// ── Step 2: Send quote with sigB placeholder, solver replaces with sigC via flex fill ──
				const sigB = await getDummySingleUpnlAndPriceSig(priceB)
				const sigC = await getDummySingleUpnlAndPriceSig(priceC)

				const callDataB = await encodeQuoteCallData(sigB)
				const callDataC = await encodeQuoteCallData(sigC)

				// Verify encodings are the same length (same dynamic field structure)
				expect(callDataB.length).to.equal(callDataC.length)

				const { dataStart, dataLength } = getUpnlSigRegion(callDataB)
				const fillValueC = extractUpnlSigBytes(callDataC, dataStart)
				expect(ethers.getBytes(fillValueC).length).to.equal(dataLength)

				const flexOp: InstantLayer.SignedOperationStruct = {
					signer: solverSigner.address,
					target: execCtx.symmioAddress,
					callData: callDataB, // contains sigB (price=200e18)
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [
						{
							offset: dataStart,
							length: dataLength,
							authorizedFlexFiller: solverSigner.address,
						},
					],
					maxUses: 1,
					replayAttackHeader: { nonce: 0n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const eipSigFlex = await signOperation(solverSigner, execCtx.domain, execCtx.types, flexOp)

				// Execute: calldata has sigB but flex fill replaces with sigC
				await expect(ctx.context.instantLayer.executeBatch([flexOp], [eipSigFlex], [[fillValueC]], [["0x"]])).not.to.be.reverted

				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)
				expect(quote2.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(quote2.marketPrice).to.equal(priceC) // sigC's price stored, NOT sigB's
				expect(quote2.marketPrice).to.not.equal(priceB) // proves replacement happened
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// TEMPLATE EXECUTION
	// ════════════════════════════════════════════════════════════════════════════

	describe("Template Execution", function () {
		let execCtx: ExecutionTestContext
		let lockQuoteCallDataTemplate: string
		let openQuoteCallDataTemplate: string

		beforeEach(async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
			const symmioAddress = ctx.context.diamond

			// Create template call data (references quote ID 6 and 4 for testing templates)
			lockQuoteCallDataTemplate = ctx.context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [0, await getDummySingleUpnlSig(10n)])
			openQuoteCallDataTemplate = ctx.context.partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
				0,
				ctx.requestOpenQuote.filledAmount,
				ctx.requestOpenQuote.openPrice,
				await getDummyPairUpnlAndPriceSig(10n),
			])

			// Setup roles
			await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
			await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
			await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

			// Create account
			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("testAccount")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 100)

			// Fund account
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.symmioPartyB.grantRole(ROLES.TRUSTED_ROLE, ctx.partyA1.address)
			await ctx.context.symmioPartyB.connect(ctx.partyA1.signer)._approve(ctx.context.collateral, decimal(30n))
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(accounts[0].accountAddress, decimal(30n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).internalTransfer(accounts[0].accountAddress, decimal(1000n))

			// Setup delegation
			const selectorQuote = ctx.quoteCallData.slice(0, 10)
			await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
				account: { addr: accounts[0].accountAddress, isPartyB: false },
				delegatedSigner: ctx.context.signers.admin.address,
				selectors: [selectorQuote],
				expiryTimestamp: await getBlockTimestamp(100n),
			})

			// Bind to PartyB
			await ctx.context.accountManager.connect(ctx.partyA1.signer)._call(accounts[0].accountAddress, [ctx.bindToPartyBCallData])

			// Whitelist symbol type
			await ctx.context.symbolControlFacet.whitelistSymbolType(ctx.context.symmioPartyB.getAddress(), 1)

			// Add templates
			await ctx.context.instantLayer.addTemplate("fullTemplate", ctx.ops)
			await ctx.context.instantLayer.addTemplate("basicTemplate", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
			])

			execCtx = { ...ctx, accounts, symmioAddress, deadline }
		})

		describe("executeTemplate - Access Control", function () {
			it("reverts when caller lacks OPERATOR_ROLE", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).executeTemplate(0, [], [], [], [])).to.be.reverted
			})
		})

		describe("executeTemplate - Template Validation", function () {
			it("reverts with InvalidTemplate for unknown template ID", async function () {
				const bogusId = (await ctx.context.instantLayer.getNextTemplateId()) + 123n
				await expect(ctx.context.instantLayer.executeTemplate(bogusId, [], [], [], []))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidTemplate")
					.withArgs(bogusId)
			})

			it("reverts when template is inactive", async function () {
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n
				await ctx.context.instantLayer.setTemplateActive(templateId, false)

				const op = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"TemplateNotActive",
				)
			})

			it("reverts when operation count doesn't match template", async function () {
				await ctx.context.instantLayer.addTemplate("singleOp", [{ sourceIndices: [], insertionPoints: [1], sourceOffsets: [] }])
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [], [], [], [])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"TemplateOperationLengthMismatch",
				)
			})

			it("reverts with ArrayLengthMismatch when ops and signatures length mismatch", async function () {
				const op = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeTemplate(0, [op, op], [sig], [[], []], [[], []])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"ArrayLengthMismatch",
				)
			})
		})

		describe("executeTemplate - Result Injection", function () {
			it("reverts with MissingSourceResult when operation self-references", async function () {
				await ctx.context.instantLayer.addTemplate("selfRef", [{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] }])
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

				const op = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"MissingSourceResult",
				)
			})

			it("reverts with InvalidSourceIndex for out of bounds reference", async function () {
				await ctx.context.instantLayer.addTemplate("badRef", [{ insertionPoints: [0], sourceIndices: [1], sourceOffsets: [0] }])
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

				const op = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op], [sig], [[]], [[]]))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidSourceIndex")
					.withArgs(1)
			})

			it("reverts with InsertionPointOutOfBounds for large offset", async function () {
				const op1 = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const op2 = createSignedOperation(
					await execCtx.context.symmioPartyB.getAddress(),
					execCtx.symmioAddress,
					execCtx.lockQuoteCallData,
					{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
					1n,
					execCtx.deadline,
				)

				// Create template with insertion point beyond calldata length
				await ctx.context.instantLayer.addTemplate("oobInsert", [
					{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
					{ insertionPoints: [op1.callData.length], sourceIndices: [0], sourceOffsets: [0] },
				])
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op2)

				await expect(
					ctx.context.instantLayer.executeTemplate(templateId, [op1, op2], [sig1, sig2], [[], []], [[], []]),
				).to.be.revertedWithCustomError(ctx.context.instantLayer, "InsertionPointOutOfBounds")
			})
		})

		describe("executeTemplate - Successful Execution", function () {
			async function executeInstantOpenWithCustomVA() {
				const customSubAccount = execCtx.accounts[0].accountAddress
				const partyBAddress = await execCtx.context.symmioPartyB.getAddress()
				const virtualIsolationType = 0 // POSITION
				const symbolId = execCtx.requestSendQuote.symbolId
				const transferAmount = decimal(1000n)
				const quoteId = (await ctx.context.viewFacetQuote.getNextQuoteId()) + 1n

				const predictedVirtualAccount = await execCtx.context.alViewFacet.predictNextVirtualAccountAddress(
					customSubAccount,
					virtualIsolationType,
					symbolId,
				)

				await execCtx.context.collateral.connect(execCtx.partyA1.signer).approve(execCtx.context.diamond, ethers.MaxUint256)
				await execCtx.context.collateral.connect(execCtx.partyA1.signer).mint(execCtx.partyA1.address, transferAmount)
				await execCtx.context.accountFacet.connect(execCtx.partyA1.signer).depositFor(customSubAccount, transferAmount)
				const customSubAccountBalanceBefore = await ctx.context.viewFacet.balanceOf(customSubAccount)

				const createVirtualAccountCallData = execCtx.context.alCoreFacet.interface.encodeFunctionData("createCustomVirtualAccount", [
					customSubAccount,
					ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_CUSTOM_VA")),
					virtualIsolationType,
					symbolId,
				])
				const addMarginCallData = execCtx.context.alMarginFacet.interface.encodeFunctionData("addMargin", [ZeroAddress, transferAmount])
				const lockQuoteCallData = execCtx.context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [
					0,
					await getDummySingleUpnlSig(10n),
				])
				const openQuoteCallData = execCtx.context.partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
					0,
					execCtx.requestOpenQuote.filledAmount,
					execCtx.requestOpenQuote.openPrice,
					await getDummyPairUpnlAndPriceSig(10n),
				])

				await ctx.context.instantLayer.addTemplate(INSTANT_OPEN_WITH_CUSTOM_VA_TEMPLATE_NAME, instantOpenWithCustomVATemplateOps())
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n
				const template = await ctx.context.instantLayer.getTemplate(templateId)
				expect(template.name).to.equal(INSTANT_OPEN_WITH_CUSTOM_VA_TEMPLATE_NAME)
				expect(normalizeTemplateOps(template.operations)).to.deep.equal(instantOpenWithCustomVATemplateOps())

				const createVirtualAccountOp = createSignedOperation(
					execCtx.partyA1.address,
					execCtx.context.accountLayerDiamond,
					createVirtualAccountCallData,
					{ addr: customSubAccount, isPartyB: false },
					0n,
					execCtx.deadline,
				)
				const addMarginOp = createSignedOperation(
					execCtx.partyA1.address,
					execCtx.context.accountLayerDiamond,
					addMarginCallData,
					{ addr: customSubAccount, isPartyB: false },
					0n,
					execCtx.deadline,
				)
				const sendQuoteOp = createSignedOperation(
					execCtx.partyA1.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: predictedVirtualAccount, isPartyB: false },
					0n,
					execCtx.deadline,
				)
				const lockQuoteOp = createSignedOperation(
					partyBAddress,
					execCtx.symmioAddress,
					lockQuoteCallData,
					{ addr: partyBAddress, isPartyB: true },
					0n,
					execCtx.deadline,
				)
				const openQuoteOp = createSignedOperation(
					partyBAddress,
					execCtx.symmioAddress,
					openQuoteCallData,
					{ addr: partyBAddress, isPartyB: true },
					0n,
					execCtx.deadline,
				)

				const createVirtualAccountSig = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, createVirtualAccountOp)
				const addMarginSig = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, addMarginOp)
				const sendQuoteSig = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, sendQuoteOp)
				const lockQuoteSig = await signOperation(execCtx.partyB1.signer, execCtx.domain, execCtx.types, lockQuoteOp)
				const openQuoteSig = await signOperation(execCtx.partyB1.signer, execCtx.domain, execCtx.types, openQuoteOp)

				await expect(
					ctx.context.instantLayer.executeTemplate(
						templateId,
						[createVirtualAccountOp, addMarginOp, sendQuoteOp, lockQuoteOp, openQuoteOp],
						[createVirtualAccountSig, addMarginSig, sendQuoteSig, lockQuoteSig, openQuoteSig],
						[[], [], [], [], []],
						[[], [], [], [], []],
					),
				).not.to.be.reverted

				return {
					customSubAccount,
					customSubAccountBalanceBefore,
					predictedVirtualAccount,
					quoteId,
					transferAmount,
				}
			}

			it("executes allocateForPartyB after PartyA sends quote (partyA injected from view op)", async function () {
				const partyBAddress = await execCtx.context.symmioPartyB.getAddress()
				const partyAAccount = execCtx.accounts[0].accountAddress
				const partyBDepositAmount = decimal(5000n)
				const allocateAmount = decimal(1000n)

				await execCtx.context.collateral.connect(execCtx.context.signers.hedger).approve(execCtx.context.diamond, ethers.MaxUint256)
				await execCtx.context.collateral.connect(execCtx.context.signers.hedger).mint(execCtx.context.signers.hedger.address, partyBDepositAmount)
				await execCtx.context.accountFacet.connect(execCtx.context.signers.hedger).depositFor(partyBAddress, partyBDepositAmount)

				await ctx.context.instantLayer.addTemplate("sendQuoteThenAllocateWithPartyAFromView", [
					{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }, // sendQuote
					{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }, // getSigner (returns partyA account address)
					{ insertionPoints: [32], sourceIndices: [1], sourceOffsets: [0] }, // allocateForPartyB(amount, partyA) inject partyA
				])
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

				const sendQuoteOp = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: partyAAccount, isPartyB: false },
					0n,
					execCtx.deadline,
				)
				const getSignerCallData = execCtx.context.viewFacet.interface.encodeFunctionData("getSigner", [])
				const getSignerOp = createSignedOperation(
					execCtx.partyA1.address,
					execCtx.symmioAddress,
					getSignerCallData,
					{ addr: partyAAccount, isPartyB: false },
					0n,
					execCtx.deadline,
				)
				const allocateCallDataRaw = execCtx.context.partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [
					allocateAmount,
					ZeroAddress,
				])
				const allocateCallData = allocateCallDataRaw + "00"
				const allocateOp = createSignedOperation(
					partyBAddress,
					execCtx.symmioAddress,
					allocateCallData,
					{ addr: partyBAddress, isPartyB: true },
					0n,
					execCtx.deadline,
				)

				const sendQuoteSig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, sendQuoteOp)
				const getSignerSig = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, getSignerOp)
				const allocateSig = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, allocateOp)

				await expect(
					ctx.context.instantLayer.executeTemplate(
						templateId,
						[sendQuoteOp, getSignerOp, allocateOp],
						[sendQuoteSig, getSignerSig, allocateSig],
						[[], [], []],
						[[], [], []],
					),
				).not.to.be.reverted

				// Verify the quote was created by the first operation
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)

				// Verify partyB allocation was performed with the injected partyA address
				expect(await ctx.context.viewFacet.allocatedBalanceOfPartyB(partyBAddress, partyAAccount)).to.equal(allocateAmount)
			})

			it("executes basic template successfully", async function () {
				const op1 = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const op2 = createSignedOperation(
					await execCtx.context.symmioPartyB.getAddress(),
					execCtx.symmioAddress,
					execCtx.lockQuoteCallData,
					{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
					1n,
					execCtx.deadline,
				)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(ctx.partyB1.signer, execCtx.domain, execCtx.types, op2)

				const templateId = 1n // basicTemplate
				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op1, op2], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.LOCKED)
			})

			it("executes full workflow: send, lock, and open quote", async function () {
				const op1 = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const op2 = createSignedOperation(
					execCtx.partyA1.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					2n,
					execCtx.deadline,
				)
				const op3 = createSignedOperation(
					await execCtx.context.symmioPartyB.getAddress(),
					execCtx.symmioAddress,
					lockQuoteCallDataTemplate,
					{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
					1n,
					execCtx.deadline,
				)
				const op4 = createSignedOperation(
					await execCtx.context.symmioPartyB.getAddress(),
					execCtx.symmioAddress,
					openQuoteCallDataTemplate,
					{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
					2n,
					execCtx.deadline,
				)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op2)
				const sig3 = await signOperation(ctx.partyB1.signer, execCtx.domain, execCtx.types, op3)
				const sig4 = await signOperation(ctx.partyB1.signer, execCtx.domain, execCtx.types, op4)

				await expect(ctx.context.instantLayer.executeTemplate(0, [op1, op2, op3, op4], [sig1, sig2, sig3, sig4], [[], [], [], []], [[], [], [], []]))
					.not.to.be.reverted

				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)

				expect(quote1.quoteStatus).to.equal(QuoteStatus.OPENED)
				expect(quote2.quoteStatus).to.equal(QuoteStatus.PENDING)
			})

			it("executes InstantOpenWithCustomVA using the final template definition", async function () {
				const { customSubAccount, customSubAccountBalanceBefore, predictedVirtualAccount, quoteId, transferAmount } =
					await executeInstantOpenWithCustomVA()

				const virtualAccounts = await execCtx.context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 10)
				expect(virtualAccounts).to.deep.equal([predictedVirtualAccount])
				expect(await ctx.context.viewFacet.balanceOf(customSubAccount)).to.equal(customSubAccountBalanceBefore - transferAmount)

				const quote = await ctx.context.viewFacetQuote.getQuote(quoteId)
				expect(quote.partyA).to.equal(predictedVirtualAccount)
				expect(quote.quoteStatus).to.equal(QuoteStatus.OPENED)
				const openTradingFee = (quote.quantity * quote.requestedOpenPrice * quote.tradingFee) / 10n ** 36n
				expect(await ctx.context.viewFacet.allocatedBalanceOfPartyA(predictedVirtualAccount)).to.equal(transferAmount - openTradingFee)
			})

			it("executes InstantCloseWithParentAllocation and allocates the swept parent balance", async function () {
				const { customSubAccount, predictedVirtualAccount, quoteId } = await executeInstantOpenWithCustomVA()
				const partyBAddress = await execCtx.context.symmioPartyB.getAddress()
				await execCtx.context.controlFacet.connect(execCtx.context.signers.admin).registerHook(ZeroAddress, execCtx.context.accountLayerDiamond)

				const closeRequest = limitCloseRequestBuilder().build()
				const requestCloseCallData = execCtx.context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					quoteId,
					closeRequest.closePrice,
					closeRequest.quantityToClose,
					closeRequest.orderType,
					await closeRequest.deadline,
				])
				const fillCloseRequest = limitFillCloseRequestBuilder().build()
				const fillCloseCallData = execCtx.context.partyBPositionActionsFacet.interface.encodeFunctionData("fillCloseRequest", [
					quoteId,
					fillCloseRequest.filledAmount,
					fillCloseRequest.closedPrice,
					await getDummyPairUpnlAndPriceSig(BigInt(fillCloseRequest.price), BigInt(fillCloseRequest.upnlPartyA), BigInt(fillCloseRequest.upnlPartyB)),
				])
				const balanceOfCallData = execCtx.context.viewFacet.interface.encodeFunctionData("balanceOf", [customSubAccount])
				const allocateCallData = execCtx.context.accountFacet.interface.encodeFunctionData("allocate", [0])

				await ctx.context.instantLayer.addTemplate(INSTANT_CLOSE_WITH_PARENT_ALLOCATION_TEMPLATE_NAME, instantCloseWithParentAllocationTemplateOps())
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n
				const template = await ctx.context.instantLayer.getTemplate(templateId)
				expect(template.name).to.equal(INSTANT_CLOSE_WITH_PARENT_ALLOCATION_TEMPLATE_NAME)
				expect(normalizeTemplateOps(template.operations)).to.deep.equal(instantCloseWithParentAllocationTemplateOps())

				const requestCloseOp = createSignedOperation(
					execCtx.partyA1.address,
					execCtx.symmioAddress,
					requestCloseCallData,
					{ addr: predictedVirtualAccount, isPartyB: false },
					0n,
					execCtx.deadline,
				)
				const fillCloseOp = createSignedOperation(
					partyBAddress,
					execCtx.symmioAddress,
					fillCloseCallData,
					{ addr: partyBAddress, isPartyB: true },
					0n,
					execCtx.deadline,
				)
				const balanceOfOp = createSignedOperation(
					execCtx.partyA1.address,
					execCtx.symmioAddress,
					balanceOfCallData,
					{ addr: customSubAccount, isPartyB: false },
					0n,
					execCtx.deadline,
				)
				const allocateOp = createSignedOperation(
					execCtx.partyA1.address,
					execCtx.symmioAddress,
					allocateCallData,
					{ addr: customSubAccount, isPartyB: false },
					0n,
					execCtx.deadline,
				)

				const requestCloseSig = await signOperation(execCtx.partyA1.signer, execCtx.domain, execCtx.types, requestCloseOp)
				const fillCloseSig = await signOperation(execCtx.partyB1.signer, execCtx.domain, execCtx.types, fillCloseOp)
				const balanceOfSig = await signOperation(execCtx.partyA1.signer, execCtx.domain, execCtx.types, balanceOfOp)
				const allocateSig = await signOperation(execCtx.partyA1.signer, execCtx.domain, execCtx.types, allocateOp)

				const parentAllocatedBefore = await ctx.context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
				const virtualAllocatedBefore = await ctx.context.viewFacet.allocatedBalanceOfPartyA(predictedVirtualAccount)
				expect(await ctx.context.viewFacet.balanceOf(customSubAccount)).to.equal(0n)
				expect(virtualAllocatedBefore).to.be.gt(0n)

				await expect(
					ctx.context.instantLayer.executeTemplate(
						templateId,
						[requestCloseOp, fillCloseOp, balanceOfOp, allocateOp],
						[requestCloseSig, fillCloseSig, balanceOfSig, allocateSig],
						[[], [], [], []],
						[[], [], [], []],
					),
				).not.to.be.reverted

				const quoteAfterClose = await ctx.context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfterClose.quoteStatus).to.equal(QuoteStatus.CLOSED)

				const virtualAccountData = await execCtx.context.alViewFacet.getVirtualAccount(predictedVirtualAccount)
				expect(virtualAccountData.isExists).to.be.false
				expect(await execCtx.context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 10)).to.deep.equal([])
				expect(await ctx.context.viewFacet.allocatedBalanceOfPartyA(predictedVirtualAccount)).to.equal(0n)
				expect(await ctx.context.viewFacet.balanceOf(customSubAccount)).to.equal(0n)
				expect(await ctx.context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)).to.be.gt(parentAllocatedBefore)
			})
		})

		describe("executeTemplate - Flex Fields with Templates", function () {
			it("should apply flex field fills within template execution and verify state", async function () {
				// Use basicTemplate (index 1): sendQuote → lockQuote with result injection
				// The sendQuote op uses a flex field on the quantity parameter
				const quantityOffset = 160
				const newQuantity = decimal(66n)

				const sendQuoteOp: InstantLayer.SignedOperationStruct = {
					signer: execCtx.context.signers.admin.address,
					target: execCtx.symmioAddress,
					callData: execCtx.quoteCallData,
					signerAccount: { addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					flexFields: [{ offset: quantityOffset, length: 32, authorizedFlexFiller: execCtx.context.signers.admin.address }],
					maxUses: 1,
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				const lockQuoteOp = createSignedOperation(
					await execCtx.context.symmioPartyB.getAddress(),
					execCtx.symmioAddress,
					lockQuoteCallDataTemplate,
					{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
					1n,
					execCtx.deadline,
				)

				const sendSig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, sendQuoteOp)
				const lockSig = await signOperation(ctx.partyB1.signer, execCtx.domain, execCtx.types, lockQuoteOp)

				const quantityValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newQuantity])

				const templateId = 1n // basicTemplate
				await expect(
					ctx.context.instantLayer.executeTemplate(
						templateId,
						[sendQuoteOp, lockQuoteOp],
						[sendSig, lockSig],
						[[quantityValue], []], // flex fills for op0, empty for op1
						[["0x"], []], // filler sigs (msg.sender for op0, none for op1)
					),
				).not.to.be.reverted

				// Verify the quote was created with the flex-filled quantity AND locked via template injection
				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quantity).to.equal(newQuantity)
				expect(quote.quantity).to.not.equal(execCtx.requestSendQuote.quantity)
				expect(quote.quoteStatus).to.equal(QuoteStatus.LOCKED)
			})
		})

		describe("executeTemplate - Nonce Management", function () {
			it("increments nonces correctly for ordered execution", async function () {
				const op1 = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					1n,
					execCtx.deadline,
				)
				const op2 = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					2n,
					execCtx.deadline,
				)
				const op3 = createSignedOperation(
					execCtx.context.signers.admin.address,
					execCtx.symmioAddress,
					execCtx.quoteCallData,
					{ addr: execCtx.accounts[0].accountAddress, isPartyB: false },
					0n, // Salt-only
					execCtx.deadline,
				)
				const op4 = createSignedOperation(
					await execCtx.context.symmioPartyB.getAddress(),
					execCtx.symmioAddress,
					execCtx.lockQuoteCallData,
					{ addr: await execCtx.context.symmioPartyB.getAddress(), isPartyB: true },
					1n,
					execCtx.deadline,
				)

				await ctx.context.instantLayer.addTemplate("nonceTest", [
					{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
					{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
					{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
					{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
				])
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op2)
				const sig3 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op3)
				const sig4 = await signOperation(ctx.partyB1.signer, execCtx.domain, execCtx.types, op4)

				const partyANonceBefore = await ctx.context.instantLayer.nonces(op1.signerAccount.addr)
				const partyBNonceBefore = await ctx.context.instantLayer.nonces(op4.signerAccount.addr)
				await expect(
					ctx.context.instantLayer.executeTemplate(templateId, [op1, op2, op3, op4], [sig1, sig2, sig3, sig4], [[], [], [], []], [[], [], [], []]),
				).not.to.be.reverted
				const partyANonceAfter = await ctx.context.instantLayer.nonces(op1.signerAccount.addr)
				const partyBNonceAfter = await ctx.context.instantLayer.nonces(op4.signerAccount.addr)

				expect(partyANonceAfter).to.equal(partyANonceBefore + 2n) // Only nonces 1 and 2 consumed, 0 doesn't increment
				expect(partyBNonceAfter).to.equal(partyBNonceBefore + 1n)
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// DELEGATION
	// ════════════════════════════════════════════════════════════════════════════

	describe("Delegation", function () {
		let accountAddress: string

		beforeEach(async function () {
			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("testAccount")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 100)
			accountAddress = accounts[0].accountAddress
		})

		describe("grantDelegation", function () {
			it("grants delegation successfully", async function () {
				const selector = ctx.quoteCallData.slice(0, 10) as `0x${string}`
				const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

				await expect(
					ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: expiry,
					}),
				)
					.to.emit(ctx.context.instantLayer, "DelegationGranted")
					.withArgs(accountAddress, ctx.context.signers.admin.address, selector, expiry)

				const storedExpiry = await ctx.context.instantLayer.delegations(accountAddress, ctx.context.signers.admin.address, selector)
				expect(storedExpiry).to.equal(expiry)
			})

			it("grants multiple selectors at once", async function () {
				const selector1 = ctx.quoteCallData.slice(0, 10) as `0x${string}`
				const selector2 = ctx.lockQuoteCallData.slice(0, 10) as `0x${string}`
				const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

				await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: ctx.context.signers.admin.address,
					selectors: [selector1, selector2],
					expiryTimestamp: expiry,
				})

				expect(await ctx.context.instantLayer.delegations(accountAddress, ctx.context.signers.admin.address, selector1)).to.equal(expiry)
				expect(await ctx.context.instantLayer.delegations(accountAddress, ctx.context.signers.admin.address, selector2)).to.equal(expiry)
			})

			it("reverts when delegating to self", async function () {
				const selector = ctx.quoteCallData.slice(0, 10) as `0x${string}`

				await expect(
					ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.partyA1.address,
						selectors: [selector],
						expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
					}),
				).to.be.revertedWithCustomError(ctx.context.instantLayer, "SelfDelegation")
			})

			it("reverts when expiry is in the past", async function () {
				const selector = ctx.quoteCallData.slice(0, 10) as `0x${string}`
				const pastExpiry = (await getBlockTimestamp()) - 100n

				await expect(
					ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: pastExpiry,
					}),
				).to.be.revertedWithCustomError(ctx.context.instantLayer, "DelegationExpired")
			})

			it("reverts when caller is not account owner", async function () {
				const selector = ctx.quoteCallData.slice(0, 10) as `0x${string}`

				await expect(
					ctx.context.instantLayer.connect(ctx.partyA2.signer).grantDelegation({
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
					}),
				).to.be.revertedWithCustomError(ctx.context.instantLayer, "NotOwnerOfAccount")
			})

			it("reverts for PartyB accounts", async function () {
				const selector = ctx.quoteCallData.slice(0, 10) as `0x${string}`

				await expect(
					ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
						account: { addr: accountAddress, isPartyB: true },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
					}),
				).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidDelegation")
			})
		})

		describe("grantBatchDelegationBySig", function () {
			it("grants delegation via signature", async function () {
				const selector = ctx.quoteCallData.slice(0, 10)
				const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)
				const expiry = now + DEFAULT_EXPIRY_OFFSET
				const deadline = now + 600n

				const signedDelegation = {
					delegationInfo: {
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: expiry,
					},
					replayAttackHeader: { nonce: 1n, deadline, salt: ethers.id("unique-salt") },
				}

				const sig = await ctx.context.signers.user.signTypedData(ctx.domain, DELEGATE_TYPES, signedDelegation)

				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).grantBatchDelegationBySig(signedDelegation, sig))
					.to.emit(ctx.context.instantLayer, "DelegationGranted")
					.withArgs(accountAddress, ctx.context.signers.admin.address, selector, expiry)

				const storedExpiry = await ctx.context.instantLayer.delegations(accountAddress, ctx.context.signers.admin.address, selector as any)
				expect(storedExpiry).to.equal(expiry)

				// Verify delegation nonce was incremented
				const nonce = await ctx.context.instantLayer.delegationNonces(accountAddress)
				expect(nonce).to.equal(1n)
			})

			it("increments delegation nonce", async function () {
				const selector = ctx.quoteCallData.slice(0, 10)
				const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)

				const signedDelegation = {
					delegationInfo: {
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: now + DEFAULT_EXPIRY_OFFSET,
					},
					replayAttackHeader: { nonce: 1n, deadline: now + 600n, salt: ethers.id("nonce-test") },
				}

				const sig = await ctx.context.signers.user.signTypedData(ctx.domain, DELEGATE_TYPES, signedDelegation)

				const nonceBefore = await ctx.context.instantLayer.delegationNonces(accountAddress)
				await ctx.context.instantLayer.grantBatchDelegationBySig(signedDelegation, sig)
				const nonceAfter = await ctx.context.instantLayer.delegationNonces(accountAddress)

				expect(nonceAfter).to.equal(nonceBefore + 1n)
			})

			it("reverts with invalid nonce", async function () {
				const selector = ctx.quoteCallData.slice(0, 10)
				const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)

				const signedDelegation = {
					delegationInfo: {
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: now + DEFAULT_EXPIRY_OFFSET,
					},
					replayAttackHeader: { nonce: 5n, deadline: now + 600n, salt: ethers.id("bad-nonce") }, // Wrong nonce
				}

				const sig = await ctx.context.signers.user.signTypedData(ctx.domain, DELEGATE_TYPES, signedDelegation)

				await expect(ctx.context.instantLayer.grantBatchDelegationBySig(signedDelegation, sig)).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidNonce",
				)
			})

			it("reverts with empty selectors", async function () {
				const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)

				const signedDelegation = {
					delegationInfo: {
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [],
						expiryTimestamp: now + DEFAULT_EXPIRY_OFFSET,
					},
					replayAttackHeader: { nonce: 1n, deadline: now + 600n, salt: ethers.id("empty-selectors") },
				}

				const sig = await ctx.context.signers.user.signTypedData(ctx.domain, DELEGATE_TYPES, signedDelegation)

				await expect(ctx.context.instantLayer.grantBatchDelegationBySig(signedDelegation, sig)).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidDelegation",
				)
			})

			it("prevents replay attacks", async function () {
				const selector = ctx.quoteCallData.slice(0, 10)
				const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)

				const signedDelegation = {
					delegationInfo: {
						account: { addr: accountAddress, isPartyB: false },
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: now + DEFAULT_EXPIRY_OFFSET,
					},
					replayAttackHeader: { nonce: 1n, deadline: now + 600n, salt: ethers.id("replay-test") },
				}

				const sig = await ctx.context.signers.user.signTypedData(ctx.domain, DELEGATE_TYPES, signedDelegation)

				await ctx.context.instantLayer.grantBatchDelegationBySig(signedDelegation, sig)

				// Trying same delegation again should fail
				await expect(ctx.context.instantLayer.grantBatchDelegationBySig(signedDelegation, sig)).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidNonce",
				)
			})
		})

		describe("PartyB delegation with isPartyB=false bypass attempt", function () {
			// This test verifies that attempting to grant delegation to a PartyB address
			// while passing isPartyB=false to bypass the InvalidDelegation check will fail
			// because the onlyOwner modifier queries AccountLayer.ownerOf() which returns
			// address(0) for PartyB addresses (they are not registered as sub-accounts)

			it("reverts when trying to grant delegation with PartyB address but isPartyB=false", async function () {
				// Register PartyB first
				await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
				await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
				await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

				const partyBAddress = await ctx.context.symmioPartyB.getAddress()
				const selector = ctx.lockQuoteCallData.slice(0, 10) as `0x${string}`

				// Attempt to grant delegation with PartyB address but isPartyB=false
				// This should fail because AccountLayer.ownerOf(partyBAddress) returns address(0)
				// and the onlyOwner modifier checks if msg.sender == owner
				await expect(
					ctx.context.instantLayer.connect(ctx.partyB1.signer).grantDelegation({
						account: { addr: partyBAddress, isPartyB: false }, // Trying to bypass the check
						delegatedSigner: ctx.context.signers.admin.address,
						selectors: [selector],
						expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
					}),
				).to.be.revertedWithCustomError(ctx.context.instantLayer, "NotOwnerOfAccount")
			})

			it("even if delegation somehow existed, PartyB operations cannot use PartyA path", async function () {
				// This test demonstrates that even if a delegation were somehow stored for a PartyB address,
				// executing PartyB operations with isPartyB=false would fail because:
				// 1. The operation would be routed through AccountLayer (PartyA path)
				// 2. AccountLayer doesn't know about PartyB contracts

				// Setup
				await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
				await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
				await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

				// Create a legitimate PartyA account and send a quote first
				await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("testAccount")
				const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 100)
				const partyAAccount = accounts[0].accountAddress

				await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
				await ctx.context.collateral.connect(ctx.partyA1.signer).mint(partyAAccount, decimal(30n))
				await ctx.context.accountFacet.connect(ctx.partyA1.signer).internalTransfer(partyAAccount, decimal(1000n))
				await ctx.context.accountManager.connect(ctx.partyA1.signer)._call(partyAAccount, [ctx.bindToPartyBCallData])
				await ctx.context.symbolControlFacet.whitelistSymbolType(ctx.context.symmioPartyB.getAddress(), 1)

				// Send quote from PartyA
				const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
				const sendQuoteOp = createSignedOperation(
					ctx.partyA1.address,
					ctx.context.diamond,
					ctx.quoteCallData,
					{ addr: partyAAccount, isPartyB: false },
					1n,
					deadline,
				)
				const sendQuoteSig = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, sendQuoteOp)
				await ctx.context.instantLayer.executeBatch([sendQuoteOp], [sendQuoteSig], [[]], [[]])

				// Now try to execute PartyB operation (lockQuote) with isPartyB=false
				// This would attempt to route through AccountLayer which won't work for PartyB
				const partyBAddress = await ctx.context.symmioPartyB.getAddress()
				const lockOp = createSignedOperation(
					partyBAddress,
					ctx.context.diamond,
					ctx.lockQuoteCallData,
					{ addr: partyBAddress, isPartyB: false }, // Wrong: Using PartyA path for PartyB operation
					1n,
					deadline,
				)
				const lockSig = await signOperation(ctx.partyB1.signer, ctx.domain, ctx.types, lockOp)

				// This should fail because:
				// 1. AccountLayer.ownerOf(partyBAddress) returns address(0)
				// 2. Since signer != owner (neither is the actual owner), it checks delegation
				// 3. No delegation exists for partyBAddress as delegator
				await expect(ctx.context.instantLayer.executeBatch([lockOp], [lockSig], [[]], [[]])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidDelegation",
				)
			})

			it("PartyB operations work correctly when using isPartyB=true", async function () {
				// This test confirms that the correct way for PartyB to operate is with isPartyB=true

				// Setup
				await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
				await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
				await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

				// Create a legitimate PartyA account and send a quote first
				await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("testAccount")
				const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 100)
				const partyAAccount = accounts[0].accountAddress

				await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
				await ctx.context.collateral.connect(ctx.partyA1.signer).mint(partyAAccount, decimal(30n))
				await ctx.context.accountFacet.connect(ctx.partyA1.signer).internalTransfer(partyAAccount, decimal(1000n))
				await ctx.context.accountManager.connect(ctx.partyA1.signer)._call(partyAAccount, [ctx.bindToPartyBCallData])
				await ctx.context.symbolControlFacet.whitelistSymbolType(ctx.context.symmioPartyB.getAddress(), 1)

				// Send quote from PartyA
				const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
				const sendQuoteOp = createSignedOperation(
					ctx.partyA1.address,
					ctx.context.diamond,
					ctx.quoteCallData,
					{ addr: partyAAccount, isPartyB: false },
					1n,
					deadline,
				)
				const sendQuoteSig = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, sendQuoteOp)
				await ctx.context.instantLayer.executeBatch([sendQuoteOp], [sendQuoteSig], [[]], [[]])

				// Now execute PartyB operation with isPartyB=true (correct way)
				const partyBAddress = await ctx.context.symmioPartyB.getAddress()
				const lockOp = createSignedOperation(
					partyBAddress,
					ctx.context.diamond,
					ctx.lockQuoteCallData,
					{ addr: partyBAddress, isPartyB: true }, // Correct: Using PartyB path
					1n,
					deadline,
				)
				const lockSig = await signOperation(ctx.partyB1.signer, ctx.domain, ctx.types, lockOp)

				// This should succeed
				await expect(ctx.context.instantLayer.executeBatch([lockOp], [lockSig], [[]], [[]])).not.to.be.reverted

				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.LOCKED)
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// REVOCATION
	// ════════════════════════════════════════════════════════════════════════════

	describe("Delegation Revocation", function () {
		let delegatorAcct: InstantLayer.AccountStruct
		let delegateAddr: string
		let selA: string
		let selB: string
		let cooldown: number

		beforeEach(async function () {
			delegateAddr = ctx.context.signers.admin.address

			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("revocationTest")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 1)

			delegatorAcct = { addr: accounts[0].accountAddress, isPartyB: false }

			selA = ctx.context.partyAFacet.interface.getFunction("sendQuoteWithAffiliate").selector as `0x${string}`
			selB = ctx.context.partyBQuoteActionsFacet.interface.getFunction("lockQuote").selector as `0x${string}`

			// Grant delegation
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)
			await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
				account: delegatorAcct,
				delegatedSigner: delegateAddr,
				selectors: [selA, selB],
				expiryTimestamp: expiry,
			})

			// Set cooldown
			cooldown = 10 * 60 // 10 minutes
			await ctx.context.instantLayer.connect(ctx.context.signers.admin).setRevocationCooldown(cooldown)
		})

		describe("setRevocationCooldown", function () {
			it("updates cooldown and emits event", async function () {
				const newCooldown = 20 * 60

				await expect(ctx.context.instantLayer.setRevocationCooldown(newCooldown))
					.to.emit(ctx.context.instantLayer, "RevocationCooldownUpdated")
					.withArgs(cooldown, newCooldown)
			})

			it("reverts when cooldown is too small", async function () {
				await expect(ctx.context.instantLayer.setRevocationCooldown(30)).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidCallData")
			})

			it("reverts when cooldown is too large", async function () {
				await expect(ctx.context.instantLayer.setRevocationCooldown(31 * 24 * 3600)).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidCallData",
				)
			})

			it("reverts when caller lacks SETTER_ROLE", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).setRevocationCooldown(600)).to.be.reverted
			})
		})

		describe("initiateRevokeDelegation", function () {
			it("owner can schedule revocation", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA]))
					.to.emit(ctx.context.instantLayer, "RevocationScheduled")
					.withArgs(delegatorAcct.addr, delegateAddr, selA, anyValue)
			})

			it("delegate can schedule revocation for themselves", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.context.signers.admin).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB]))
					.to.emit(ctx.context.instantLayer, "RevocationScheduled")
					.withArgs(delegatorAcct.addr, delegateAddr, selA, anyValue)
					.and.to.emit(ctx.context.instantLayer, "RevocationScheduled")
					.withArgs(delegatorAcct.addr, delegateAddr, selB, anyValue)
			})

			it("REVOKER_ROLE can schedule revocation", async function () {
				await ctx.context.instantLayer.grantRole(ROLES.REVOKER_ROLE, ctx.context.signers.user.address)

				await expect(ctx.context.instantLayer.connect(ctx.context.signers.user).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA]))
					.to.emit(ctx.context.instantLayer, "RevocationScheduled")
					.withArgs(delegatorAcct.addr, delegateAddr, selA, anyValue)
			})

			it("reverts for unauthorized caller", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyB1.signer).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA]))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "NotOwnerOfAccount")
					.withArgs(ctx.partyB1.address, delegatorAcct.addr)
			})

			it("ignores inactive delegations", async function () {
				// Grant a short-lived delegation
				await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
					account: delegatorAcct,
					delegatedSigner: delegateAddr,
					selectors: [selB],
					expiryTimestamp: (await getBlockTimestamp()) + 12n,
				})

				await increaseTime(15) // Let selB expire

				// Should only emit for selA (active), not selB (expired)
				const tx = await ctx.context.instantLayer.connect(ctx.partyA1.signer).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB])
				const receipt = await tx.wait()
				const events = receipt?.logs.filter(
					(log: any) => log.topics[0] === ctx.context.instantLayer.interface.getEvent("RevocationScheduled").topicHash,
				)
				expect(events?.length).to.equal(1)
				expect(events?.[0]?.args?.selector).to.equal(selA)
			})
		})

		describe("finalizeRevokeDelegation", function () {
			beforeEach(async function () {
				await ctx.context.instantLayer.connect(ctx.partyA1.signer).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB])
			})

			it("reverts before cooldown expires", async function () {
				await expect(ctx.context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"RevocationCooldownNotOver",
				)
			})

			it("finalizes after cooldown and clears delegation", async function () {
				await increaseTime(cooldown + 1)

				await expect(ctx.context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB]))
					.to.emit(ctx.context.instantLayer, "DelegationSelectorRevoked")
					.withArgs(delegatorAcct.addr, delegateAddr, selA)
					.and.to.emit(ctx.context.instantLayer, "DelegationSelectorRevoked")
					.withArgs(delegatorAcct.addr, delegateAddr, selB)

				// Verify delegations are cleared
				expect(await ctx.context.instantLayer.delegations(delegatorAcct.addr, delegateAddr, selA as any)).to.equal(0)
				expect(await ctx.context.instantLayer.delegations(delegatorAcct.addr, delegateAddr, selB as any)).to.equal(0)

				// Verify pending revocation is cleared
				expect(await ctx.context.instantLayer.pendingRevocationEta(delegatorAcct.addr, delegateAddr, selA as any)).to.equal(0)
				expect(await ctx.context.instantLayer.pendingRevocationEta(delegatorAcct.addr, delegateAddr, selB as any)).to.equal(0)
			})

			it("is idempotent - calling again is no-op", async function () {
				await increaseTime(cooldown + 1)
				await ctx.context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA])

				// Second call should not revert
				await expect(ctx.context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA])).not.to.be.reverted
			})

			it("only revokes scheduled selectors", async function () {
				// Only schedule selA revocation
				await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
					account: delegatorAcct,
					delegatedSigner: delegateAddr,
					selectors: [selA, selB],
					expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
				})

				// Clear previous pending and schedule only selA
				await ctx.context.instantLayer.connect(ctx.partyA1.signer).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA])

				await increaseTime(cooldown + 1)

				// Finalize both - only selA should be revoked
				await ctx.context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB])

				expect(await ctx.context.instantLayer.delegations(delegatorAcct.addr, delegateAddr, selA as any)).to.equal(0)
				// selB was re-granted above, should still be active
				expect(await ctx.context.instantLayer.delegations(delegatorAcct.addr, delegateAddr, selB as any)).to.be.greaterThan(0)
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// VIRTUAL ACCOUNT DELEGATION
	// ════════════════════════════════════════════════════════════════════════════

	describe("Virtual Account Delegation", function () {
		let subAccountAddress: string
		let virtualAccountAddress: string
		let quoteCallDataLocal: string
		let symmioAddress: string

		beforeEach(async function () {
			symmioAddress = ctx.context.diamond

			// Setup InstantLayer
			await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
			await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
			await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

			// Create sub-account with MARKET isolation
			const subAccountData = [
				{
					name: "VIRTUAL_DELEGATION_TEST",
					metadata: ethers.keccak256(toUtf8Bytes("metadata")),
					symmioCore: ctx.context.diamond,
					isolationType: 1,
					singleVAMode: false,
				},
			]
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer).createSubAccounts(await ctx.context.accountManager.getAddress(), subAccountData)
			const accounts = await ctx.context.alViewFacet.getUserSubAccountsAddresses(ctx.partyA1.address, 0, 100)
			subAccountAddress = accounts[0]

			// Fund sub-account
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(subAccountAddress, decimal(5000n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).depositFor(subAccountAddress, decimal(3000n))

			// Bind to PartyB
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer)._call(subAccountAddress, [ctx.bindToPartyBCallData])

			// Whitelist symbol
			await ctx.context.symbolControlFacet.whitelistSymbolType(ctx.context.symmioPartyB.getAddress(), 1)

			// Create quote call data
			quoteCallDataLocal = ctx.context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
				ctx.requestSendQuote.partyBWhiteList,
				ctx.requestSendQuote.symbolId,
				ctx.requestSendQuote.positionType,
				ctx.requestSendQuote.orderType,
				ctx.requestSendQuote.price,
				ctx.requestSendQuote.quantity,
				ctx.requestSendQuote.cva,
				ctx.requestSendQuote.lf,
				ctx.requestSendQuote.partyAmm,
				ctx.requestSendQuote.partyBmm,
				ctx.requestSendQuote.maxFundingRate,
				await ctx.requestSendQuote.deadline,
				ctx.requestSendQuote.affiliate,
				await ctx.requestSendQuote.upnlSig,
			])

			// Pre-fund the VA before sending quote (since automatic transfer was removed)
			// MARKET isolation (1) -> VirtualAccountIsolationType.MARKET (1)
			const predictedVA = await ctx.context.alViewFacet.predictNextVirtualAccountAddress(subAccountAddress, 1, ctx.requestSendQuote.symbolId)
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, decimal(500n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).depositAndAllocateFor(predictedVA, decimal(500n))

			// Create virtual account by sending a quote
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer)._call(subAccountAddress, [quoteCallDataLocal])

			// Get virtual account address
			const virtualAccounts = await ctx.context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(subAccountAddress, 0, 10)
			virtualAccountAddress = virtualAccounts[0]

			// Grant delegation on parent sub-account
			const selectorQuote = quoteCallDataLocal.slice(0, 10)
			await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
				account: { addr: subAccountAddress, isPartyB: false },
				delegatedSigner: ctx.context.signers.admin.address,
				selectors: [selectorQuote],
				expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
			})
		})

		it("allows delegate to execute on virtual account using parent's delegation", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// Transfer funds to virtual account
			const internalTransferCallData = ctx.context.accountFacet.interface.encodeFunctionData("internalTransfer", [
				virtualAccountAddress,
				decimal(500n),
			])
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer)._call(subAccountAddress, [internalTransferCallData])

			// Create operation targeting virtual account
			const op = createSignedOperation(
				ctx.context.signers.admin.address,
				symmioAddress,
				quoteCallDataLocal,
				{ addr: virtualAccountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig = await signOperation(ctx.context.signers.admin, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

			const quoteIds = await ctx.context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
			expect(quoteIds.length).to.equal(2)
		})

		it("normalizes VA direct delegation grant to parent key", async function () {
			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			await expect(
				ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
					account: { addr: virtualAccountAddress, isPartyB: false },
					delegatedSigner: ctx.context.signers.user2.address,
					selectors: [selectorQuote],
					expiryTimestamp: expiry,
				}),
			)
				.to.emit(ctx.context.instantLayer, "DelegationGranted")
				.withArgs(subAccountAddress, ctx.context.signers.user2.address, selectorQuote, expiry)

			expect(await ctx.context.instantLayer.delegations(subAccountAddress, ctx.context.signers.user2.address, selectorQuote)).to.equal(expiry)
			expect(await ctx.context.instantLayer.delegations(virtualAccountAddress, ctx.context.signers.user2.address, selectorQuote)).to.equal(0)

			const transferToVa = ctx.context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccountAddress, decimal(500n)])
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer)._call(subAccountAddress, [transferToVa])

			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
			const op = createSignedOperation(
				ctx.context.signers.user2.address,
				symmioAddress,
				quoteCallDataLocal,
				{ addr: virtualAccountAddress, isPartyB: false },
				1n,
				deadline,
			)
			const sig = await signOperation(ctx.context.signers.user2, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

			const quoteIds = await ctx.context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
			expect(quoteIds.length).to.equal(2)
		})

		it("normalizes VA signed delegation grant to parent key", async function () {
			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`
			const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)
			const expiry = now + DEFAULT_EXPIRY_OFFSET
			const deadline = now + 600n

			const signedDelegation = {
				delegationInfo: {
					account: { addr: virtualAccountAddress, isPartyB: false },
					delegatedSigner: ctx.context.signers.user2.address,
					selectors: [selectorQuote],
					expiryTimestamp: expiry,
				},
				replayAttackHeader: { nonce: 1n, deadline, salt: ethers.id("va-delegation-nonce-1") },
			}
			const delegationSig = await ctx.partyA1.signer.signTypedData(ctx.domain, DELEGATE_TYPES, signedDelegation)

			await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).grantBatchDelegationBySig(signedDelegation, delegationSig))
				.to.emit(ctx.context.instantLayer, "DelegationGranted")
				.withArgs(subAccountAddress, ctx.context.signers.user2.address, selectorQuote, expiry)

			expect(await ctx.context.instantLayer.delegations(subAccountAddress, ctx.context.signers.user2.address, selectorQuote)).to.equal(expiry)
			expect(await ctx.context.instantLayer.delegations(virtualAccountAddress, ctx.context.signers.user2.address, selectorQuote)).to.equal(0)
			expect(await ctx.context.instantLayer.delegationNonces(subAccountAddress)).to.equal(1n)
			expect(await ctx.context.instantLayer.delegationNonces(virtualAccountAddress)).to.equal(0n)

			const transferToVa = ctx.context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccountAddress, decimal(500n)])
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer)._call(subAccountAddress, [transferToVa])

			const opDeadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
			const op = createSignedOperation(
				ctx.context.signers.user2.address,
				symmioAddress,
				quoteCallDataLocal,
				{ addr: virtualAccountAddress, isPartyB: false },
				1n,
				opDeadline,
			)
			const sig = await signOperation(ctx.context.signers.user2, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted
		})

		it("decodes sendQuoteWithAffiliateAndData params correctly via _handleSubAccountSendQuote", async function () {
			// This test verifies LibQuoteParams.decodeQuoteParams correctly decodes sendQuoteWithAffiliateAndData
			// by going through the SubAccount flow: _call -> selector match -> decodeQuoteParams -> _handleSubAccountSendQuote

			// Create a NEW SubAccount with POSITION isolation (each quote gets its own VA)
			const subAccountData = [
				{
					name: "sendQuoteWithDataTest",
					metadata: ethers.keccak256(toUtf8Bytes("positionIsolation")),
					symmioCore: ctx.context.diamond,
					isolationType: 2, // POSITION isolation - each quote creates a new VA
					singleVAMode: false,
				},
			]
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer).createSubAccounts(await ctx.context.accountManager.getAddress(), subAccountData)
			const subAccounts = await ctx.context.alViewFacet.getUserSubAccountsAddresses(ctx.partyA1.address, 0, 100)
			const newSubAccountAddress = subAccounts[subAccounts.length - 1] // Get the newly created one

			// Fund the sub-account
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(newSubAccountAddress, decimal(5000n))
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).depositFor(newSubAccountAddress, decimal(3000n))

			// Bind to PartyB
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer)._call(newSubAccountAddress, [ctx.bindToPartyBCallData])

			// Encode sendQuoteWithAffiliateAndData call data
			const quoteWithDataCallData = ctx.context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliateAndData", [
				ctx.requestSendQuote.partyBWhiteList,
				ctx.requestSendQuote.symbolId,
				ctx.requestSendQuote.positionType,
				ctx.requestSendQuote.orderType,
				ctx.requestSendQuote.price,
				ctx.requestSendQuote.quantity,
				ctx.requestSendQuote.cva,
				ctx.requestSendQuote.lf,
				ctx.requestSendQuote.partyAmm,
				ctx.requestSendQuote.partyBmm,
				await ctx.requestSendQuote.deadline,
				ctx.requestSendQuote.affiliate,
				await ctx.requestSendQuote.upnlSig,
				"0xdeadbeef", // arbitrary data bytes
			])

			// Verify the selector is correct (0xa7f3b34b)
			expect(quoteWithDataCallData.slice(0, 10)).to.equal("0xa7f3b34b")

			// Pre-fund the predicted VirtualAccount (POSITION isolation uses symbolId for VA prediction)
			const predictedVA = await ctx.context.alViewFacet.predictNextVirtualAccountAddress(newSubAccountAddress, 2, ctx.requestSendQuote.symbolId)
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(ctx.partyA1.address, decimal(1000n))
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, decimal(1000n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).depositAndAllocateFor(predictedVA, decimal(1000n))

			// Execute sendQuoteWithAffiliateAndData via SubAccount._call
			// This goes through: CoreFacet._call -> selector match -> LibQuoteParams.decodeQuoteParams -> _handleSubAccountSendQuote
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer)._call(newSubAccountAddress, [quoteWithDataCallData])

			// Verify a VirtualAccount was created
			const virtualAccounts = await ctx.context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(newSubAccountAddress, 0, 10)
			expect(virtualAccounts.length).to.equal(1)
			expect(virtualAccounts[0]).to.equal(predictedVA)

			// Verify the quote was created with correct parameters (proves decodeQuoteParams worked correctly)
			const quoteIds = await ctx.context.alViewFacet.getVirtualAccountQuoteIds(virtualAccounts[0], 0, 10)
			expect(quoteIds.length).to.equal(1)

			const quote = await ctx.context.viewFacetQuote.getQuote(quoteIds[0])
			expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
			// These verify LibQuoteParams.decodeQuoteParams decoded each field correctly:
			expect(quote.symbolId).to.equal(ctx.requestSendQuote.symbolId)
			expect(quote.positionType).to.equal(ctx.requestSendQuote.positionType)
			expect(quote.orderType).to.equal(ctx.requestSendQuote.orderType)
			expect(quote.requestedOpenPrice).to.equal(ctx.requestSendQuote.price)
			expect(quote.quantity).to.equal(ctx.requestSendQuote.quantity)
			expect(quote.lockedValues.cva).to.equal(ctx.requestSendQuote.cva)
			expect(quote.lockedValues.lf).to.equal(ctx.requestSendQuote.lf)
			expect(quote.lockedValues.partyAmm).to.equal(ctx.requestSendQuote.partyAmm)
		})

		it("rejects operation when delegate lacks parent's delegation", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			const op = createSignedOperation(
				ctx.context.signers.user2.address, // Not delegated
				symmioAddress,
				quoteCallDataLocal,
				{ addr: virtualAccountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig = await signOperation(ctx.context.signers.user2, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
				ctx.context.instantLayer,
				"InvalidDelegation",
			)
		})

		it("allows owner to execute on virtual account without delegation", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// Transfer funds
			const internalTransferCallData = ctx.context.accountFacet.interface.encodeFunctionData("internalTransfer", [
				virtualAccountAddress,
				decimal(500n),
			])
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer)._call(subAccountAddress, [internalTransferCallData])

			const op = createSignedOperation(
				ctx.partyA1.address,
				symmioAddress,
				quoteCallDataLocal,
				{ addr: virtualAccountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig = await signOperation(ctx.context.signers.user, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

			// Verify the quote was created on the virtual account
			const quoteIds = await ctx.context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
			expect(quoteIds.length).to.equal(2) // 1 from setup + 1 from this test
		})

		it("correctly identifies parent account for delegation", async function () {
			const virtualAccountDetail = await ctx.context.alViewFacet.getVirtualAccount(virtualAccountAddress)
			expect(virtualAccountDetail.isExists).to.be.true
			expect(virtualAccountDetail.parentAccount).to.equal(subAccountAddress)

			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`
			expect(await ctx.context.instantLayer.isDelegationActive(subAccountAddress, ctx.context.signers.admin.address, selectorQuote)).to.be.true
			expect(await ctx.context.instantLayer.isDelegationActive(virtualAccountAddress, ctx.context.signers.admin.address, selectorQuote)).to.be.false
		})

		it("resolves active delegations when queried with VA account", async function () {
			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`
			const delegations = await ctx.context.instantLayer.getActiveDelegations(
				{ addr: virtualAccountAddress, isPartyB: false },
				[ctx.context.signers.admin.address],
				[[selectorQuote]],
			)

			expect(delegations.length).to.equal(1)
			expect(delegations[0].account.addr).to.equal(virtualAccountAddress)
			expect(delegations[0].delegatedSigner).to.equal(ctx.context.signers.admin.address)
			expect(delegations[0].selectors).to.deep.equal([selectorQuote])
		})

		it("revocation on parent affects virtual account operations", async function () {
			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`

			// Set cooldown and initiate revocation
			await ctx.context.instantLayer.setRevocationCooldown(MIN_REVOCATION_COOLDOWN)
			await ctx.context.instantLayer
				.connect(ctx.partyA1.signer)
				.initiateRevokeDelegation({ addr: subAccountAddress, isPartyB: false }, ctx.context.signers.admin.address, [selectorQuote])

			await increaseTime(MIN_REVOCATION_COOLDOWN + 1)

			await ctx.context.instantLayer.finalizeRevokeDelegation({ addr: subAccountAddress, isPartyB: false }, ctx.context.signers.admin.address, [
				selectorQuote,
			])

			// Get fresh deadline after time manipulation
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			const op = createSignedOperation(
				ctx.context.signers.admin.address,
				symmioAddress,
				quoteCallDataLocal,
				{ addr: virtualAccountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig = await signOperation(ctx.context.signers.admin, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
				ctx.context.instantLayer,
				"InvalidDelegation",
			)
		})

		it("normalizes VA revocation input to parent key", async function () {
			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`

			await ctx.context.instantLayer.setRevocationCooldown(MIN_REVOCATION_COOLDOWN)

			await expect(
				ctx.context.instantLayer
					.connect(ctx.partyA1.signer)
					.initiateRevokeDelegation({ addr: virtualAccountAddress, isPartyB: false }, ctx.context.signers.admin.address, [selectorQuote]),
			)
				.to.emit(ctx.context.instantLayer, "RevocationScheduled")
				.withArgs(subAccountAddress, ctx.context.signers.admin.address, selectorQuote, anyValue)

			expect(
				await ctx.context.instantLayer.pendingRevocationEta(subAccountAddress, ctx.context.signers.admin.address, selectorQuote),
			).to.be.greaterThan(0n)
			expect(await ctx.context.instantLayer.pendingRevocationEta(virtualAccountAddress, ctx.context.signers.admin.address, selectorQuote)).to.equal(
				0n,
			)

			await increaseTime(MIN_REVOCATION_COOLDOWN + 1)

			await expect(
				ctx.context.instantLayer.finalizeRevokeDelegation({ addr: virtualAccountAddress, isPartyB: false }, ctx.context.signers.admin.address, [
					selectorQuote,
				]),
			)
				.to.emit(ctx.context.instantLayer, "DelegationSelectorRevoked")
				.withArgs(subAccountAddress, ctx.context.signers.admin.address, selectorQuote)

			expect(await ctx.context.instantLayer.delegations(subAccountAddress, ctx.context.signers.admin.address, selectorQuote)).to.equal(0)
			expect(await ctx.context.instantLayer.delegations(virtualAccountAddress, ctx.context.signers.admin.address, selectorQuote)).to.equal(0)
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// EXTERNAL TARGET ROUTING
	// ════════════════════════════════════════════════════════════════════════════

	describe("External Target Routing", function () {
		let accountAddress: string
		let mockTarget: any
		let targetAddress: string
		let deadline: bigint

		beforeEach(async function () {
			const MockInstantTarget = await ethers.getContractFactory("MockInstantTarget")
			mockTarget = await MockInstantTarget.deploy()
			targetAddress = await mockTarget.getAddress()
			await ctx.context.instantLayer.setTargetWhitelist(targetAddress, true)

			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("targetRoute")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 10)
			accountAddress = accounts[accounts.length - 1].accountAddress

			deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
		})

		function buildTargetOp(target: string, signer: string): InstantLayer.SignedOperationStruct {
			return createSignedOperation(
				signer,
				target,
				mockTarget.interface.encodeFunctionData("store", [123n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
		}

		it("executes whitelisted target and updates state", async function () {
			const op = buildTargetOp(targetAddress, ctx.partyA1.address)
			const sig = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted
			expect(await mockTarget.lastValue()).to.equal(123n)
		})

		it("reverts for non-whitelisted target", async function () {
			const MockInstantTarget = await ethers.getContractFactory("MockInstantTarget")
			const unlisted = await MockInstantTarget.deploy()

			const op = buildTargetOp(await unlisted.getAddress(), ctx.partyA1.address)
			const sig = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]]))
				.to.be.revertedWithCustomError(ctx.context.instantLayer, "TargetNotWhitelisted")
				.withArgs(await unlisted.getAddress())
		})

		it("bubbles target revert in OperationFailed", async function () {
			await mockTarget.setShouldRevert(true, "xxx")
			const op = buildTargetOp(targetAddress, ctx.partyA1.address)
			const sig = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]]))
				.to.be.revertedWithCustomError(ctx.context.instantLayer, "OperationFailed")
				.withArgs(0, anyValue)
		})

		it("allows delegated signer on whitelisted external target", async function () {
			const storeSelector = mockTarget.interface.getFunction("store").selector as `0x${string}`
			await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
				account: { addr: accountAddress, isPartyB: false },
				delegatedSigner: ctx.context.signers.admin.address,
				selectors: [storeSelector],
				expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
			})

			const op = buildTargetOp(targetAddress, ctx.context.signers.admin.address)
			const sig = await signOperation(ctx.context.signers.admin, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted
			expect(await mockTarget.lastValue()).to.equal(123n)
		})

		it("rejects delegated signer without proper selector grant", async function () {
			await ctx.context.instantLayer.connect(ctx.partyA1.signer).grantDelegation({
				account: { addr: accountAddress, isPartyB: false },
				delegatedSigner: ctx.context.signers.admin.address,
				selectors: ["0x12345678"],
				expiryTimestamp: await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET),
			})

			const op = buildTargetOp(targetAddress, ctx.context.signers.admin.address)
			const sig = await signOperation(ctx.context.signers.admin, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
				ctx.context.instantLayer,
				"InvalidDelegation",
			)
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// MIXED BATCH EXECUTION
	// ════════════════════════════════════════════════════════════════════════════

	describe("Mixed Target Batch Execution", function () {
		let accountAddress: string
		let mockTarget: any
		let targetAddress: string

		beforeEach(async function () {
			const MockInstantTarget = await ethers.getContractFactory("MockInstantTarget")
			mockTarget = await MockInstantTarget.deploy()
			targetAddress = await mockTarget.getAddress()
			await ctx.context.instantLayer.setTargetWhitelist(targetAddress, true)

			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("mixedBatch")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 10)
			accountAddress = accounts[accounts.length - 1].accountAddress

			// Setup for Symmio operations
			await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
			await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
			await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

			// Fund account
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(accountAddress, decimal(30n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).depositFor(accountAddress, decimal(20n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).internalTransfer(accountAddress, decimal(1000n))

			// Bind to PartyB
			await ctx.context.accountManager.connect(ctx.partyA1.signer)._call(accountAddress, [ctx.bindToPartyBCallData])

			// Whitelist symbol
			await ctx.context.symbolControlFacet.whitelistSymbolType(ctx.context.symmioPartyB.getAddress(), 1)
		})

		it("executes batch with both Symmio and external target operations", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			const externalOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [456n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)

			const symmioOp = createSignedOperation(
				ctx.partyA1.address,
				ctx.context.diamond,
				ctx.quoteCallData,
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, externalOp)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, symmioOp)

			await expect(ctx.context.instantLayer.executeBatch([externalOp, symmioOp], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

			expect(await mockTarget.lastValue()).to.equal(456n)
			const quote = await ctx.context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
		})

		it("fails entire batch if external target operation fails", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			await mockTarget.setShouldRevert(true, "external revert")

			const externalOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [123n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)

			const symmioOp = createSignedOperation(
				ctx.partyA1.address,
				ctx.context.diamond,
				ctx.quoteCallData,
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, externalOp)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, symmioOp)

			await expect(ctx.context.instantLayer.executeBatch([externalOp, symmioOp], [sig1, sig2], [[], []], [[], []]))
				.to.be.revertedWithCustomError(ctx.context.instantLayer, "OperationFailed")
				.withArgs(0, anyValue)
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// TEMPLATE WITH EXTERNAL TARGETS
	// ════════════════════════════════════════════════════════════════════════════

	describe("Template Execution with External Targets", function () {
		let accountAddress: string
		let mockTarget: any
		let targetAddress: string

		beforeEach(async function () {
			const MockInstantTarget = await ethers.getContractFactory("MockInstantTarget")
			mockTarget = await MockInstantTarget.deploy()
			targetAddress = await mockTarget.getAddress()
			await ctx.context.instantLayer.setTargetWhitelist(targetAddress, true)

			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("templateExternal")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 10)
			accountAddress = accounts[accounts.length - 1].accountAddress

			// Setup for Symmio
			await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
			await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
			await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

			// Fund account
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(accountAddress, decimal(30n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).depositFor(accountAddress, decimal(20n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).internalTransfer(accountAddress, decimal(1000n))

			// Bind to PartyB
			await ctx.context.accountManager.connect(ctx.partyA1.signer)._call(accountAddress, [ctx.bindToPartyBCallData])

			// Whitelist symbol
			await ctx.context.symbolControlFacet.whitelistSymbolType(ctx.context.symmioPartyB.getAddress(), 1)
		})

		it("executes template with external target operations", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			await ctx.context.instantLayer.addTemplate("externalOnly", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			])
			const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

			const op1 = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [111n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
			const op2 = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [222n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, op1)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, op2)

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [op1, op2], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

			expect(await mockTarget.lastValue()).to.equal(222n)
		})

		it("executes template with mixed Symmio and external targets", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			await ctx.context.instantLayer.addTemplate("mixedTemplate", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			])
			const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

			const externalOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [333n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
			const symmioOp = createSignedOperation(
				ctx.partyA1.address,
				ctx.context.diamond,
				ctx.quoteCallData,
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, externalOp)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, symmioOp)

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [externalOp, symmioOp], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

			expect(await mockTarget.lastValue()).to.equal(333n)
			const quote = await ctx.context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
		})

		it("successfully injects result from external target into subsequent operation", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// store(444n) returns bytes32(444n), which we inject into the next operation's calldata
			await ctx.context.instantLayer.addTemplate("injectFromExternal", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
			])
			const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

			const externalOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [444n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
			// Create a second external op that will receive the injected value
			const secondExternalOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [0n]), // placeholder, will be replaced with 444
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, externalOp)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, secondExternalOp)

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [externalOp, secondExternalOp], [sig1, sig2], [[], []], [[], []])).not.to.be
				.reverted

			// The second operation should have received 444 as its value (injected from first op's result)
			expect(await mockTarget.lastValue()).to.equal(444n)
		})

		it("extracts first value from tuple return using sourceOffset 0", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// getTuple(100, 200) returns (100, 200) - we extract first value (offset 0)
			await ctx.context.instantLayer.addTemplate("tupleFirstValue", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] }, // extract first uint256
			])
			const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

			const getTupleOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("getTuple", [100n, 200n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
			const storeOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [0n]), // placeholder
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, getTupleOp)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, storeOp)

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [getTupleOp, storeOp], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

			// Should have stored 100 (first value from tuple)
			expect(await mockTarget.lastValue()).to.equal(100n)
		})

		it("extracts second value from tuple return using sourceOffset 32", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// getTuple(100, 200) returns (100, 200) - we extract second value (offset 32)
			await ctx.context.instantLayer.addTemplate("tupleSecondValue", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [32] }, // extract second uint256
			])
			const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

			const getTupleOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("getTuple", [100n, 200n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
			const storeOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [0n]), // placeholder
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, getTupleOp)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, storeOp)

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [getTupleOp, storeOp], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

			// Should have stored 200 (second value from tuple)
			expect(await mockTarget.lastValue()).to.equal(200n)
		})

		it("extracts multiple values from same tuple using different sourceOffsets", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// getTuple returns (100, 200), we inject both into separate operations
			await ctx.context.instantLayer.addTemplate("tupleMultiExtract", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }, // getTuple
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] }, // store first value
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [32] }, // store second value
			])
			const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

			const getTupleOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("getTuple", [111n, 222n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
			const storeFirstOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [0n]),
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)
			const storeSecondOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [0n]),
				{ addr: accountAddress, isPartyB: false },
				2n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, getTupleOp)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, storeFirstOp)
			const sig3 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, storeSecondOp)

			await expect(
				ctx.context.instantLayer.executeTemplate(
					templateId,
					[getTupleOp, storeFirstOp, storeSecondOp],
					[sig1, sig2, sig3],
					[[], [], []],
					[[], [], []],
				),
			).not.to.be.reverted

			// Last store was second value (222)
			expect(await mockTarget.lastValue()).to.equal(222n)
		})

		it("extracts address from triple return using sourceOffset 32", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
			const testAddress = "0x1234567890123456789012345678901234567890"

			// getTriple returns (uint256, address, bytes32) - extract the address at offset 32
			await ctx.context.instantLayer.addTemplate("tripleAddress", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [32] }, // extract address
			])
			const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

			const getTripleOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("getTriple", [999n, testAddress, ethers.zeroPadValue("0xabcd", 32)]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
			const storeOp = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [0n]),
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, getTripleOp)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, storeOp)

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [getTripleOp, storeOp], [sig1, sig2], [[], []], [[], []])).not.to.be.reverted

			// Address is stored as uint256 representation
			expect(await mockTarget.lastValue()).to.equal(BigInt(testAddress))
		})

		it("reverts with BadSourceResultLength when sourceOffset exceeds result length", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// store returns 32 bytes, but we try to extract at offset 64
			await ctx.context.instantLayer.addTemplate("badOffset", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [64] }, // invalid offset
			])
			const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

			const storeOp1 = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [123n]),
				{ addr: accountAddress, isPartyB: false },
				0n,
				deadline,
			)
			const storeOp2 = createSignedOperation(
				ctx.partyA1.address,
				targetAddress,
				mockTarget.interface.encodeFunctionData("store", [0n]),
				{ addr: accountAddress, isPartyB: false },
				1n,
				deadline,
			)

			const sig1 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, storeOp1)
			const sig2 = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, storeOp2)

			await expect(
				ctx.context.instantLayer.executeTemplate(templateId, [storeOp1, storeOp2], [sig1, sig2], [[], []], [[], []]),
			).to.be.revertedWithCustomError(ctx.context.instantLayer, "BadSourceResultLength")
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// ACCOUNT LAYER OPERATIONS VIA INSTANT LAYER
	// ════════════════════════════════════════════════════════════════════════════

	describe("AccountLayer Operations via InstantLayer", function () {
		let subAccountAddress: string

		beforeEach(async function () {
			// Create a sub-account with MARKET isolation
			const subAccountData = [
				{
					name: "testSubAccount",
					metadata: ethers.keccak256(toUtf8Bytes("metadata")),
					symmioCore: ctx.context.diamond,
					isolationType: 1,
					singleVAMode: false,
				},
			]
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer).createSubAccounts(await ctx.context.accountManager.getAddress(), subAccountData)
			const accounts = await ctx.context.alViewFacet.getUserSubAccountsAddresses(ctx.partyA1.address, 0, 100)
			subAccountAddress = accounts[0]

			// Fund the sub-account with collateral
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(subAccountAddress, decimal(100n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).depositFor(subAccountAddress, decimal(100n))
		})

		describe("addMarginToNextVA via signature", function () {
			it("executes addMarginToNextVA when signed by account owner", async function () {
				const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
				const amount = decimal(50n)
				const isolationType = 1 // VirtualAccountIsolationType.MARKET
				const symbolId = 1

				// Encode the addMarginToNextVA call
				const addMarginCallData = ctx.context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [
					subAccountAddress,
					isolationType,
					symbolId,
					amount,
				])

				// Create signed operation targeting AccountLayerDiamond
				const op = createSignedOperation(
					ctx.partyA1.address,
					ctx.context.accountLayerDiamond,
					addMarginCallData,
					{ addr: subAccountAddress, isPartyB: false },
					1n,
					deadline,
				)

				const sig = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, op)

				// Get balance before
				const subAccountBalanceBefore = await ctx.context.viewFacet.balanceOf(subAccountAddress)

				// Execute via InstantLayer and capture the transaction
				const tx = await ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])
				const receipt = await tx.wait()

				// Parse AddMargin event to get the predicted VA address
				const addMarginEvent = receipt!.logs
					.map((log: any) => {
						try {
							return ctx.context.alMarginFacet.interface.parseLog({ topics: [...log.topics], data: log.data })
						} catch {
							return null
						}
					})
					.find((parsed: any) => parsed?.name === "AddMargin")

				expect(addMarginEvent).to.not.be.undefined
				const predictedVA = addMarginEvent!.args[0]

				// Verify sub-account balance decreased
				const subAccountBalanceAfter = await ctx.context.viewFacet.balanceOf(subAccountAddress)
				expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore - amount)

				// Verify virtual account received the funds (as allocated balance)
				const vaAllocatedBalance = await ctx.context.viewFacet.allocatedBalanceOfPartyA(predictedVA)
				expect(vaAllocatedBalance).to.equal(amount)
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// SIGNER ACCOUNT BINDING SECURITY
	// ════════════════════════════════════════════════════════════════════════════

	describe("Signer Account Binding Security", function () {
		let victimSubAccount: string
		let attackerSubAccount: string
		let attacker: typeof ctx.partyA2

		beforeEach(async function () {
			attacker = ctx.partyA2

			// Create victim's sub-account (owned by partyA1)
			const victimSubAccountData = [
				{
					name: "victimAccount",
					metadata: ethers.keccak256(toUtf8Bytes("victim")),
					symmioCore: ctx.context.diamond,
					isolationType: 1,
					singleVAMode: false,
				},
			]
			await ctx.context.alCoreFacet.connect(ctx.partyA1.signer).createSubAccounts(await ctx.context.accountManager.getAddress(), victimSubAccountData)
			const victimAccounts = await ctx.context.alViewFacet.getUserSubAccountsAddresses(ctx.partyA1.address, 0, 100)
			victimSubAccount = victimAccounts[0]

			// Create attacker's sub-account (owned by partyA2/alice)
			const attackerSubAccountData = [
				{
					name: "attackerAccount",
					metadata: ethers.keccak256(toUtf8Bytes("attacker")),
					symmioCore: ctx.context.diamond,
					isolationType: 1,
					singleVAMode: false,
				},
			]
			await ctx.context.alCoreFacet.connect(attacker.signer).createSubAccounts(await ctx.context.accountManager.getAddress(), attackerSubAccountData)
			const attackerAccounts = await ctx.context.alViewFacet.getUserSubAccountsAddresses(attacker.address, 0, 100)
			attackerSubAccount = attackerAccounts[0]

			// Fund victim's sub-account
			await ctx.context.collateral.connect(ctx.partyA1.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(ctx.partyA1.signer).mint(victimSubAccount, decimal(500n))
			await ctx.context.accountFacet.connect(ctx.partyA1.signer).depositFor(victimSubAccount, decimal(500n))
		})

		it("blocks cross-account attack via accountLayer _call target", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// Attacker encodes a malicious _call targeting the victim's account
			// This calls CoreFacet._call(victimSubAccount, [withdrawTo(attacker, 500)])
			const withdrawCallData = ctx.context.accountFacet.interface.encodeFunctionData("withdrawTo", [attacker.address, decimal(500n)])
			const maliciousCallData = ctx.context.alCoreFacet.interface.encodeFunctionData("_call", [victimSubAccount, [withdrawCallData]])

			// Attacker signs the operation with their own EOA and their own sub-account as signerAccount
			const op = createSignedOperation(
				attacker.address,
				ctx.context.accountLayerDiamond,
				maliciousCallData,
				{ addr: attackerSubAccount, isPartyB: false },
				1n,
				deadline,
			)
			const sig = await signOperation(attacker.signer, ctx.domain, ctx.types, op)

			// The operation should revert because:
			// 1. setSigner sets attacker's EOA (owner of attackerSubAccount) as globalSigner
			// 2. _call(victimSubAccount, ...) checks onlyAccountOwner(victimSubAccount)
			// 3. getSigner() returns attacker's EOA, which is NOT the owner of victimSubAccount
			// 4. Reverts with NotOwner
			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(
				ctx.context.instantLayer,
				"OperationFailed",
			)

			// Verify victim's balance is unchanged
			const victimBalance = await ctx.context.viewFacet.balanceOf(victimSubAccount)
			expect(victimBalance).to.equal(decimal(500n))
		})

		it("blocks cross-account attack via symmio target routing", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// Attacker tries to use the Symmio target path to call withdrawTo on victim's account
			// When target == symmio address, InstantLayer routes through accountLayer._call(signerAccount.addr, ...)
			// So the attacker would need signerAccount.addr = victimSubAccount
			// But _getAccountOwner(victimSubAccount) returns partyA1, not attacker
			// So setSigner sets partyA1 as globalSigner, but the EIP-712 signature must be from the signer field
			// The attacker cannot sign as partyA1, so this path also fails

			const withdrawCallData = ctx.context.accountFacet.interface.encodeFunctionData("withdrawTo", [attacker.address, decimal(500n)])

			// If attacker tries to set signerAccount to victim's account but sign with their own key
			const op = createSignedOperation(
				attacker.address,
				ctx.context.diamond, // symmio target
				withdrawCallData,
				{ addr: victimSubAccount, isPartyB: false }, // targeting victim's account
				1n,
				deadline,
			)
			const sig = await signOperation(attacker.signer, ctx.domain, ctx.types, op)

			// This should fail because _validatePartyASignature checks that the signer (attacker)
			// is either the account owner or has a valid delegation for the victim's account
			// Attacker is not the owner of victimSubAccount and has no delegation
			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.reverted

			// Verify victim's balance unchanged
			const victimBalance = await ctx.context.viewFacet.balanceOf(victimSubAccount)
			expect(victimBalance).to.equal(decimal(500n))
		})

		it("allows owner to call their own account via accountLayer target", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// Fund attacker's sub-account
			await ctx.context.collateral.connect(attacker.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(attacker.signer).mint(attackerSubAccount, decimal(200n))
			await ctx.context.accountFacet.connect(attacker.signer).depositFor(attackerSubAccount, decimal(200n))

			const balanceBefore = await ctx.context.viewFacet.balanceOf(attackerSubAccount)
			expect(balanceBefore).to.equal(decimal(200n))

			// Owner encodes a _call targeting their own account
			const withdrawCallData = ctx.context.accountFacet.interface.encodeFunctionData("withdrawTo", [attacker.address, decimal(100n)])
			const ownCallData = ctx.context.alCoreFacet.interface.encodeFunctionData("_call", [attackerSubAccount, [withdrawCallData]])

			// Owner signs operation with their own EOA and their own sub-account
			const op = createSignedOperation(
				attacker.address,
				ctx.context.accountLayerDiamond,
				ownCallData,
				{ addr: attackerSubAccount, isPartyB: false },
				1n,
				deadline,
			)
			const sig = await signOperation(attacker.signer, ctx.domain, ctx.types, op)

			// This should succeed because:
			// 1. setSigner sets attacker's EOA (owner of attackerSubAccount) as globalSigner
			// 2. _call(attackerSubAccount, ...) checks onlyAccountOwner(attackerSubAccount)
			// 3. getSigner() returns attacker's EOA, which IS the owner of attackerSubAccount
			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

			// Verify funds were withdrawn
			const balanceAfter = await ctx.context.viewFacet.balanceOf(attackerSubAccount)
			expect(balanceAfter).to.equal(decimal(100n))
		})

		it("allows owner to call their own account via accountLayer addMarginToNextVA", async function () {
			const deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)

			// Fund attacker's sub-account (using attacker as the legitimate user here)
			await ctx.context.collateral.connect(attacker.signer).approve(ctx.context.diamond, ethers.MaxUint256)
			await ctx.context.collateral.connect(attacker.signer).mint(attackerSubAccount, decimal(200n))
			await ctx.context.accountFacet.connect(attacker.signer).depositFor(attackerSubAccount, decimal(200n))

			const balanceBefore = await ctx.context.viewFacet.balanceOf(attackerSubAccount)
			expect(balanceBefore).to.equal(decimal(200n))

			// Encode addMarginToNextVA call targeting own sub-account
			const amount = decimal(50n)
			const addMarginCallData = ctx.context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [
				attackerSubAccount,
				1, // VirtualAccountIsolationType.MARKET
				1, // symbolId
				amount,
			])

			// Owner signs operation targeting AccountLayerDiamond with their own sub-account
			const op = createSignedOperation(
				attacker.address,
				ctx.context.accountLayerDiamond,
				addMarginCallData,
				{ addr: attackerSubAccount, isPartyB: false },
				1n,
				deadline,
			)
			const sig = await signOperation(attacker.signer, ctx.domain, ctx.types, op)

			// This should succeed because setSigner sets the owner as globalSigner,
			// and onlyAccountOwner confirms ownership
			await expect(ctx.context.instantLayer.executeBatch([op], [sig], [[]], [[]])).not.to.be.reverted

			// Verify sub-account balance decreased
			const balanceAfter = await ctx.context.viewFacet.balanceOf(attackerSubAccount)
			expect(balanceAfter).to.equal(balanceBefore - amount)
		})
	})
}
