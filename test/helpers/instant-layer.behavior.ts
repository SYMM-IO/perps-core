import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs"
import { loadFixture, time } from "./network-helpers.js"
import { expect } from "chai"
import { ZeroAddress, toUtf8Bytes, TypedDataDomain } from "ethers"
import { ethers } from "./hardhat-connection.js"

import type { InstantLayer } from "../../src/types/index.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { QuoteStatus } from "../models/Enums.js"
import { Hedger } from "../models/Hedger.js"
import { RunContext } from "../models/RunContext.js"
import { User } from "../models/User.js"
import { limitOpenRequestBuilder, OpenRequest } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder, QuoteRequest } from "../models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "../utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "../utils/SignatureUtils.js"
import { cloneTypes, DELEGATE_TYPES } from "./instantLayerEIP712Types.js"

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
		replayAttackHeader: { nonce, deadline, salt: generateSalt() },
	}
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

		await context.instantLayer.setAccountHub(context.accountLayerDiamond)

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
				await expect(ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address])).not.to.be.reverted

				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB1.address)).to.be.true
				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB2.address)).to.be.false
			})

			it("registers multiple PartyBs in single call", async function () {
				await expect(ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address, ctx.partyB2.address])).not.to.be.reverted

				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB1.address)).to.be.true
				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB2.address)).to.be.true
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

			it("handles empty array without reverting", async function () {
				await expect(ctx.context.instantLayer.registerPartyBs([])).to.be.revertedWithCustomError(ctx.context.instantLayer, "EmptyArray")
			})

			it("allows registering same PartyB twice (idempotent)", async function () {
				await ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address])
				await expect(ctx.context.instantLayer.registerPartyBs([ctx.partyB1.address])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"PartyBAlreadyRegistered",
				)
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
				await expect(ctx.context.instantLayer.unregisterPartyB(ctx.partyB1.address)).not.to.be.reverted
				expect(await ctx.context.instantLayer.registeredPartyBs(ctx.partyB1.address)).to.be.false
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

			it("allows unregistering non-registered PartyB (no-op)", async function () {
				await expect(ctx.context.instantLayer.unregisterPartyB(ctx.partyB2.address)).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"PartyBNotRegistered",
				)
			})
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// ACCOUNT HUB CONFIGURATION
	// ════════════════════════════════════════════════════════════════════════════

	describe("AccountHub Configuration", function () {
		describe("setAccountHub", function () {
			it("reverts when caller lacks SETTER_ROLE", async function () {
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).setAccountHub(ctx.partyB1.address)).to.be.reverted
			})

			it("updates accountHub address", async function () {
				const hubAddress = ctx.context.accountLayerDiamond
				await expect(ctx.context.instantLayer.setAccountHub(hubAddress)).not.to.be.reverted
				expect(await ctx.context.instantLayer.accountHub()).to.equal(hubAddress)
			})

			it("reverts when setting to zero address", async function () {
				await expect(ctx.context.instantLayer.setAccountHub(ZeroAddress)).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"UnregisteredAccountHub",
				)
			})

			it("emits AccountHubUpdated event", async function () {
				const newHub = ethers.Wallet.createRandom().address
				const oldHub = await ctx.context.instantLayer.accountHub()

				await expect(ctx.context.instantLayer.setAccountHub(newHub)).to.emit(ctx.context.instantLayer, "AccountHubUpdated").withArgs(oldHub, newHub)
			})

			it("auto-whitelists new accountHub as target", async function () {
				const newHub = ethers.Wallet.createRandom().address
				await ctx.context.instantLayer.setAccountHub(newHub)
				expect(await ctx.context.instantLayer.whitelistedTargets(newHub)).to.be.true
			})

			it("removes whitelist from old accountHub", async function () {
				const hub1 = ctx.context.accountLayerDiamond
				const hub2 = ethers.Wallet.createRandom().address

				await ctx.context.instantLayer.setAccountHub(hub1)
				expect(await ctx.context.instantLayer.whitelistedTargets(hub1)).to.be.true

				await ctx.context.instantLayer.setAccountHub(hub2)
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
				await expect(ctx.context.instantLayer.addTemplate(name, ctx.ops)).not.to.be.reverted

				const templateId = (await ctx.context.instantLayer.nextTemplateId()) - 1n
				const template = await ctx.context.instantLayer.getTemplate(templateId)

				expect(template.name).to.equal(name)
				expect(template.active).to.be.true
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
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).executeBatch([], [])).to.be.revertedWith(/access/i)
			})
		})

		describe("executeBatch - Input Validation", function () {
			it("reverts with empty batch", async function () {
				await expect(ctx.context.instantLayer.executeBatch([], [])).to.be.revertedWithCustomError(ctx.context.instantLayer, "EmptyBatch")
			})

			it("reverts when ops and signatures length mismatch", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [])).to.be.revertedWithCustomError(ctx.context.instantLayer, "ArrayLengthMismatch")

				await expect(ctx.context.instantLayer.executeBatch([op, op], [sig])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"ArrayLengthMismatch",
				)
			})
		})

		describe("executeBatch - Deadline Validation", function () {
			it("reverts when deadline has passed", async function () {
				const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 100
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, BigInt(deadline))
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				// Operation should succeed before deadline
				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted

				// Advance time past deadline
				await time.increase(100)

				// Create new operation with same expired deadline
				const op2 = { ...op, replayAttackHeader: { ...op.replayAttackHeader, salt: generateSalt() } }
				const sig2 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op2)

				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2])).to.be.revertedWithCustomError(ctx.context.instantLayer, "DeadlineExpired")
			})
		})

		describe("executeBatch - Signature Validation", function () {
			it("reverts with invalid signature for PartyB", async function () {
				const op = await createPartyBLockOp(1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.hedger2, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidSignature")
			})

			it("reverts when delegate lacks selector grant for partyA", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.user2.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.user2, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidDelegation")
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
				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted
			})
		})

		describe("executeBatch - Replay Protection", function () {
			it("prevents replay attacks", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"OperationAlreadyExecuted",
				)
			})

			it("reverts with invalid nonce for ordered execution", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted
				// Nonce should be 2, not 3
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 3n, execCtx.deadline)
				const sig2 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op2)

				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2])).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidNonce")
			})

			it("allows unordered batch execution with nonce=0", async function () {
				const op1 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 0n, execCtx.deadline)
				const op3 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 2n, execCtx.deadline)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op2)
				const sig3 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op3)

				// Execute with mixed nonces (1, 0, 2)
				await expect(ctx.context.instantLayer.executeBatch([op1, op2, op3], [sig1, sig2, sig3])).not.to.be.reverted
			})

			it("allows unordered single execution with nonce=0", async function () {
				const op1 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 0n, execCtx.deadline)
				const op3 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 2n, execCtx.deadline)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op2)
				const sig3 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op3)

				// Execute with mixed nonces (1, 0, 2)
				await expect(ctx.context.instantLayer.executeBatch([op1], [sig1])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op2], [sig2])).not.to.be.reverted
				await expect(ctx.context.instantLayer.executeBatch([op3], [sig3])).not.to.be.reverted
			})
		})

		describe("executeBatch - PartyB Validation", function () {
			it("reverts with unregistered PartyB", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: execCtx.partyB2.address,
					target: execCtx.symmioAddress,
					callData: execCtx.lockQuoteCallData,
					signerAccount: { addr: execCtx.partyB2.address, isPartyB: true },
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}
				const sig = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(ctx.context.instantLayer, "UnregisteredPartyB")
			})

			it("reverts when signer and account mismatch for PartyB", async function () {
				const op: InstantLayer.SignedOperationStruct = {
					signer: await execCtx.context.symmioPartyB.getAddress(),
					target: execCtx.symmioAddress,
					callData: execCtx.lockQuoteCallData,
					signerAccount: { addr: execCtx.partyB2.address, isPartyB: true },
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}
				const sig = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig]))
					.to.be.revertedWithCustomError(ctx.context.instantLayer, "MismatchSignerAndAccount")
					.withArgs(await execCtx.context.symmioPartyB.getAddress(), execCtx.partyB2.address)
			})

			it("allows PartyB to skip signature when executing their own operations", async function () {
				// First create a quote so PartyB has something to lock
				const sendQuoteOp = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sendQuoteSig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, sendQuoteOp)
				await ctx.context.instantLayer.executeBatch([sendQuoteOp], [sendQuoteSig])

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
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				// Encode executeBatch call with empty signature
				const executeBatchCallData = ctx.context.instantLayer.interface.encodeFunctionData("executeBatch", [[lockOp], ["0x"]])

				// PartyB calls InstantLayer.executeBatch via _multicastCall (msg.sender = PartyB contract)
				// This should succeed because PartyB is executing their own operation, so signature is skipped
				await expect(ctx.context.symmioPartyB.connect(ctx.context.signers.hedger)._multicastCall([instantLayerAddress], [executeBatchCallData])).not.to
					.be.reverted

				// Verify the quote was locked
				const quoteAfter = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.LOCKED)
			})

			it("still requires signature when PartyB is not the executor", async function () {
				// First create a quote so PartyB has something to lock
				const sendQuoteOp = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sendQuoteSig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, sendQuoteOp)
				await ctx.context.instantLayer.executeBatch([sendQuoteOp], [sendQuoteSig])

				// Create PartyB lock operation with empty signature
				const partyBAddress = await ctx.context.symmioPartyB.getAddress()
				const lockOp: InstantLayer.SignedOperationStruct = {
					signer: partyBAddress,
					target: execCtx.symmioAddress,
					callData: execCtx.lockQuoteCallData,
					signerAccount: { addr: partyBAddress, isPartyB: true },
					replayAttackHeader: { nonce: 1n, deadline: execCtx.deadline, salt: generateSalt() },
				}

				// Admin (not PartyB) calls executeBatch with empty signature - should fail
				// Because msg.sender != signer, signature verification is required
				await expect(ctx.context.instantLayer.executeBatch([lockOp], ["0x"])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InvalidSignature",
				)
			})
		})

		describe("executeBatch - Operation Execution", function () {
			it("executes single operation successfully", async function () {
				const op = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted

				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.requestedOpenPrice).to.equal(execCtx.requestSendQuote.price)
				expect(quote.quantity).to.equal(execCtx.requestSendQuote.quantity)
				expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)
			})

			it("executes multiple operations in batch", async function () {
				const op1 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 2n, execCtx.deadline)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op2)

				await expect(ctx.context.instantLayer.executeBatch([op1, op2], [sig1, sig2])).not.to.be.reverted

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

				await expect(ctx.context.instantLayer.executeBatch([op1, op2], [sig1, sig2])).not.to.be.reverted

				const quote = await ctx.context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.equal(QuoteStatus.LOCKED)
			})

			it("emits BatchExecuted event", async function () {
				const op1 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)
				const op2 = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.partyA1.address, 2n, execCtx.deadline)
				const op3 = await createPartyBLockOp(1n, execCtx.deadline)

				const sig1 = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, op1)
				const sig2 = await signOperation(execCtx.context.signers.user, execCtx.domain, execCtx.types, op2)
				const sig3 = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op3)

				await expect(ctx.context.instantLayer.executeBatch([op1, op2, op3], [sig1, sig2, sig3]))
					.to.emit(ctx.context.instantLayer, "BatchExecuted")
					.withArgs(execCtx.context.signers.admin.address, 3)
			})
		})

		describe("executeBatch - Error Handling", function () {
			it("bubbles inner target failures with OperationFailed", async function () {
				// Try to lock a quote before creating one
				const op = await createPartyBLockOp(1n, execCtx.deadline)
				const sig = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, op)

				await expect(ctx.context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(ctx.context.instantLayer, "OperationFailed")
			})

			it("short-circuits on first failure", async function () {
				// First op fails (lock before send), second would succeed
				const opFail = await createPartyBLockOp(1n, execCtx.deadline)
				const opSuccess = createPartyASendQuoteOp(execCtx.accounts[0].accountAddress, execCtx.context.signers.admin.address, 1n, execCtx.deadline)

				const sigFail = await signOperation(execCtx.context.signers.hedger, execCtx.domain, execCtx.types, opFail)
				const sigSuccess = await signOperation(execCtx.context.signers.admin, execCtx.domain, execCtx.types, opSuccess)

				await expect(ctx.context.instantLayer.executeBatch([opFail, opSuccess], [sigFail, sigSuccess])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"OperationFailed",
				)
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
				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).executeTemplate(0, [], [])).to.be.reverted
			})
		})

		describe("executeTemplate - Template Validation", function () {
			it("reverts with InvalidTemplate for unknown template ID", async function () {
				const bogusId = (await ctx.context.instantLayer.getNextTemplateId()) + 123n
				await expect(ctx.context.instantLayer.executeTemplate(bogusId, [], []))
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

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op], [sig])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"TemplateNotActive",
				)
			})

			it("reverts when operation count doesn't match template", async function () {
				await ctx.context.instantLayer.addTemplate("singleOp", [{ sourceIndices: [], insertionPoints: [1], sourceOffsets: [] }])
				const templateId = (await ctx.context.instantLayer.getNextTemplateId()) - 1n

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [], [])).to.be.revertedWithCustomError(
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

				await expect(ctx.context.instantLayer.executeTemplate(0, [op, op], [sig])).to.be.revertedWithCustomError(
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

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op], [sig])).to.be.revertedWithCustomError(
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

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op], [sig]))
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

				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op1, op2], [sig1, sig2])).to.be.revertedWithCustomError(
					ctx.context.instantLayer,
					"InsertionPointOutOfBounds",
				)
			})
		})

		describe("executeTemplate - Successful Execution", function () {
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
				const allocateCallDataRaw = execCtx.context.partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [allocateAmount, ZeroAddress])
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
					ctx.context.instantLayer.executeTemplate(templateId, [sendQuoteOp, getSignerOp, allocateOp], [sendQuoteSig, getSignerSig, allocateSig]),
				).not.to.be.reverted

				expect(await ctx.context.viewFacet.allocatedBalanceOfPartyB(partyBAddress, partyAAccount)).to.equal(allocateAmount)
			})

			it("executes basic template and emits OperationsExecuted", async function () {
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
				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op1, op2], [sig1, sig2]))
					.to.emit(ctx.context.instantLayer, "OperationsExecuted")
					.withArgs(templateId, execCtx.context.signers.admin.address)

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

				await expect(ctx.context.instantLayer.executeTemplate(0, [op1, op2, op3, op4], [sig1, sig2, sig3, sig4])).not.to.be.reverted

				const quote1 = await ctx.context.viewFacetQuote.getQuote(1)
				const quote2 = await ctx.context.viewFacetQuote.getQuote(2)

				expect(quote1.quoteStatus).to.equal(QuoteStatus.OPENED)
				expect(quote2.quoteStatus).to.equal(QuoteStatus.PENDING)
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
				await expect(ctx.context.instantLayer.executeTemplate(templateId, [op1, op2, op3, op4], [sig1, sig2, sig3, sig4])).not.to.be.reverted
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

				await expect(ctx.context.instantLayer.connect(ctx.partyA1.signer).grantBatchDelegationBySig(signedDelegation, sig)).not.to.be.reverted

				const storedExpiry = await ctx.context.instantLayer.delegations(accountAddress, ctx.context.signers.admin.address, selector as any)
				expect(storedExpiry).to.equal(expiry)
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
			// because the onlyOwner modifier queries AccountHub.ownerOf() which returns
			// address(0) for PartyB addresses (they are not registered as sub-accounts)

			it("reverts when trying to grant delegation with PartyB address but isPartyB=false", async function () {
				// Register PartyB first
				await ctx.context.instantLayer.registerPartyBs([ctx.context.symmioPartyB])
				await ctx.context.symmioPartyB.grantRole(ROLES.SETTER_ROLE, await ctx.context.signers.admin.getAddress())
				await ctx.context.symmioPartyB.setSigner(ctx.partyB1.signer)

				const partyBAddress = await ctx.context.symmioPartyB.getAddress()
				const selector = ctx.lockQuoteCallData.slice(0, 10) as `0x${string}`

				// Attempt to grant delegation with PartyB address but isPartyB=false
				// This should fail because AccountHub.ownerOf(partyBAddress) returns address(0)
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
				// 1. The operation would be routed through AccountHub (PartyA path)
				// 2. AccountHub doesn't know about PartyB contracts

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
				await ctx.context.instantLayer.executeBatch([sendQuoteOp], [sendQuoteSig])

				// Now try to execute PartyB operation (lockQuote) with isPartyB=false
				// This would attempt to route through AccountHub which won't work for PartyB
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
				// 1. AccountHub.ownerOf(partyBAddress) returns address(0)
				// 2. Since signer != owner (neither is the actual owner), it checks delegation
				// 3. No delegation exists for partyBAddress as delegator
				await expect(ctx.context.instantLayer.executeBatch([lockOp], [lockSig])).to.be.revertedWithCustomError(
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
				await ctx.context.instantLayer.executeBatch([sendQuoteOp], [sendQuoteSig])

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
				await expect(ctx.context.instantLayer.executeBatch([lockOp], [lockSig])).not.to.be.reverted

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

			await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted

			const quoteIds = await ctx.context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
			expect(quoteIds.length).to.equal(2)
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

			await expect(ctx.context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidDelegation")
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

			await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted
		})

		it("correctly identifies parent account for delegation", async function () {
			const virtualAccountDetail = await ctx.context.alViewFacet.getVirtualAccount(virtualAccountAddress)
			expect(virtualAccountDetail.isExists).to.be.true
			expect(virtualAccountDetail.parentAccount).to.equal(subAccountAddress)

			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`
			expect(await ctx.context.instantLayer.isDelegationActive(subAccountAddress, ctx.context.signers.admin.address, selectorQuote)).to.be.true
			expect(await ctx.context.instantLayer.isDelegationActive(virtualAccountAddress, ctx.context.signers.admin.address, selectorQuote)).to.be.false
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

			await expect(ctx.context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidDelegation")
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

			await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted
			expect(await mockTarget.lastValue()).to.equal(123n)
		})

		it("reverts for non-whitelisted target", async function () {
			const MockInstantTarget = await ethers.getContractFactory("MockInstantTarget")
			const unlisted = await MockInstantTarget.deploy()

			const op = buildTargetOp(await unlisted.getAddress(), ctx.partyA1.address)
			const sig = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig]))
				.to.be.revertedWithCustomError(ctx.context.instantLayer, "TargetNotWhitelisted")
				.withArgs(await unlisted.getAddress())
		})

		it("bubbles target revert in OperationFailed", async function () {
			await mockTarget.setShouldRevert(true, "xxx")
			const op = buildTargetOp(targetAddress, ctx.partyA1.address)
			const sig = await signOperation(ctx.partyA1.signer, ctx.domain, ctx.types, op)

			await expect(ctx.context.instantLayer.executeBatch([op], [sig]))
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

			await expect(ctx.context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted
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

			await expect(ctx.context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(ctx.context.instantLayer, "InvalidDelegation")
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

			await expect(ctx.context.instantLayer.executeBatch([externalOp, symmioOp], [sig1, sig2])).not.to.be.reverted

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

			await expect(ctx.context.instantLayer.executeBatch([externalOp, symmioOp], [sig1, sig2]))
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

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [op1, op2], [sig1, sig2]))
				.to.emit(ctx.context.instantLayer, "OperationsExecuted")
				.withArgs(templateId, ctx.context.signers.admin.address)

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

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [externalOp, symmioOp], [sig1, sig2])).not.to.be.reverted

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

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [externalOp, secondExternalOp], [sig1, sig2])).not.to.be.reverted

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

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [getTupleOp, storeOp], [sig1, sig2])).not.to.be.reverted

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

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [getTupleOp, storeOp], [sig1, sig2])).not.to.be.reverted

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
				ctx.context.instantLayer.executeTemplate(templateId, [getTupleOp, storeFirstOp, storeSecondOp], [sig1, sig2, sig3]),
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

			await expect(ctx.context.instantLayer.executeTemplate(templateId, [getTripleOp, storeOp], [sig1, sig2])).not.to.be.reverted

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
				ctx.context.instantLayer.executeTemplate(templateId, [storeOp1, storeOp2], [sig1, sig2]),
			).to.be.revertedWithCustomError(ctx.context.instantLayer, "BadSourceResultLength")
		})
	})

	// ════════════════════════════════════════════════════════════════════════════
	// ACCOUNT LAYER OPERATIONS VIA INSTANT LAYER
	// ════════════════════════════════════════════════════════════════════════════

	describe("AccountLayer Operations via InstantLayer", function () {
		let subAccountAddress: string

		beforeEach(async function () {
			// Create a sub-account
			await ctx.context.accountManager.connect(ctx.partyA1.signer).addAccount("testSubAccount")
			const accounts = await ctx.context.accountManager.getAccounts(ctx.partyA1.address, 0, 100)
			subAccountAddress = accounts[0].accountAddress

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
				const tx = await ctx.context.instantLayer.executeBatch([op], [sig])
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
}
