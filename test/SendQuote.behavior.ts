import { loadFixture, time } from "./helpers/network-helpers.js"
import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { QuoteStatus } from "./models/Enums.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { SendQuoteValidator } from "./models/validators/SendQuoteValidator.js"
import { decimal, getBlockTimestamp, pausePartyA } from "./utils/Common.js"
import { getDummySingleUpnlAndPriceSig } from "./utils/SignatureUtils.js"
import { ethers } from "ethers"
import { toUtf8Bytes } from "ethers";

export function shouldBehaveLikeSendQuote(): void {
	let user: User, context: RunContext

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(1200n)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1500n), this.user_allocated)
		// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
	})

	it("Should fail on paused partyA", async function () {
		await pausePartyA(context)
		await expect(user.sendQuote(limitQuoteRequestBuilder().quantity(50).cva(50).partyAmm(1).lf(100).build())).to.be.revertedWith(
			"Pausable: PartyA actions paused",
		)
	})

	//TODO : review the `PartyAFacet: Leverage can't be lower than one`
	// it("Should fail on leverage being lower than one", async function () {
	// 	await expect(user.sendQuote(limitQuoteRequestBuilder().quantity(50).cva(50).partyAmm(1).lf(100).build())).to.be.revertedWith(
	// 		"PartyAFacet: Leverage can't be lower than one",
	// 	)

	// 	await expect(
	// 		user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(0)).cva(decimal(3)).partyAmm(decimal(75)).lf(decimal(22)).build()),
	// 	).to.be.revertedWith("PartyAFacet: Leverage can't be lower than one")
	// })

	it("Should fail on invalid symbol", async function () {
		await expect(
			user.sendQuote(limitQuoteRequestBuilder().symbolId(2).quantity(decimal(0n)).cva(decimal(3n)).partyAmm(decimal(75n)).lf(decimal(22n)).build()),
		).to.be.revertedWith("PartyAFacet: Symbol is not valid")
	})

	it("Should fail on LF lower than minAcceptablePortionLF", async function () {
		await expect(
			user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(100n)).cva(decimal(1n)).partyAmm(decimal(1n)).lf(decimal(0n)).build()),
		).to.be.revertedWith("PartyAFacet: LF is not enough")
	})

	it("Should fail on quote value lower than minAcceptableQuoteValue", async function () {
		await expect(
			user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(50n)).cva(decimal(1n)).partyAmm(decimal(1n)).lf(decimal(1n)).build()),
		).to.be.revertedWith("PartyAFacet: Quote value is low")
	})

	it("Should fail when partyA is in partyBWhiteList", async function () {
		await expect(
			user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await user.getAddress()])
					.quantity(decimal(50n))
					.cva(decimal(3n))
					.partyAmm(decimal(5n))
					.lf(decimal(5n))
					.build(),
			),
		).to.be.revertedWith("PartyAFacet: Sender isn't allowed in partyBWhiteList")
	})

	it("Should fail on insufficient available balance", async function () {
		await expect(
			user.sendQuote(
				limitQuoteRequestBuilder()
					.price(decimal(16n))
					.quantity(decimal(500n))
					.cva(decimal(120n))
					.partyAmm(this.user_allocated)
					.lf(decimal(50n))
					.upnlSig(getDummySingleUpnlAndPriceSig(decimal(16n)))
					.build(),
			),
		).to.be.revertedWith("PartyAFacet: insufficient available balance")

		await expect(
			user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(1600n)).cva(decimal(250n)).partyAmm(this.user_allocated).lf(decimal(60n)).build()),
		).to.be.revertedWith("PartyAFacet: insufficient available balance")
	})

	it("Should expire", async function () {
		let qId = await user.sendQuote(limitQuoteRequestBuilder().deadline(getBlockTimestamp(100n)).build())
		await expect(context.partyAFacet.expireQuote([qId])).to.be.revertedWith("LibQuote: Quote isn't expired")
		await time.increase(1000)
		await context.partyAFacet.expireQuote([1])
		expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.be.equal(QuoteStatus.EXPIRED)
	})

	it("Should run successfully for limit", async function () {
		let validator = new SendQuoteValidator()
		const before = await validator.before(context, { user: user })
		let qId = await user.sendQuote()
		await validator.after(context, { user: user, quoteId: qId, beforeOutput: before })
	})

	it("Should run successfully for market", async function () {
		let validator = new SendQuoteValidator()
		const before = await validator.before(context, { user: user })
		let qId = await user.sendQuote(marketQuoteRequestBuilder().build())
		await validator.after(context, { user: user, quoteId: qId, beforeOutput: before })
	})

	it("Should fail on more sent quotes than the allowed range", async function () {
		let validPending = await context.viewFacet.pendingQuotesValidLength()
		while (true) {
			validPending = validPending - 1n
			await user.sendQuote()
			if (validPending == 0n) break
		}
		await expect(user.sendQuote()).to.be.revertedWith("PartyAFacet: Number of pending quotes out of range")
	})

	it("Should fail when bind to a partyB and the partyB is not in the whitelisted partyBs", async function () {
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
		await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.getAddress())
		await expect(
			user.sendQuote(
				limitQuoteRequestBuilder()
					.upnlSig(getDummySingleUpnlAndPriceSig(decimal(16n)))
					.partyBWhiteList([await context.signers.hedger2.getAddress()])
					.build(),
			),
		).to.be.revertedWith("PartyAFacet: PartyA is bound to a different PartyB")
	})

	it("Should not check the partyBsWhiteList when not bind to a partyB", async function () {
		let validator = new SendQuoteValidator()
		const before = await validator.before(context, { user: user })
		let qId = await user.sendQuote(
			limitQuoteRequestBuilder()
				.upnlSig(getDummySingleUpnlAndPriceSig(decimal(16n), decimal(-1000n)))
				.partyBWhiteList([await context.signers.hedger2.getAddress()])
				.build(),
		)
		await validator.after(context, { user: user, quoteId: qId, beforeOutput: before })
	})

	it("Should store data by sending quote with data successfully for limit", async function () {
		let validator = new SendQuoteValidator()
		const before = await validator.before(context, { user: user })
		let qId = await user.sendQuoteWithData()
		await validator.after(context, { user: user, quoteId: qId, beforeOutput: before })
		let quote = await context.viewFacetQuote.getQuote(qId)
		let text = ethers.AbiCoder.defaultAbiCoder().decode(["string"], quote.data)
		expect(text[0]).to.be.equal("hello-world")
	})

	it("should send quote with correct affiliate fee", async function () {
		await context.controlFacet.registerAffiliate(context.signers.hedger)
		await context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [17], [17])
		let validator = new SendQuoteValidator()
		const before = await validator.before(context, { user: user })
		let qId = await user.sendQuote(limitQuoteRequestBuilder().affiliate(context.signers.hedger.address).build())
		await validator.after(context, { user: user, quoteId: qId, beforeOutput: before })
	})

	it("should send quote with correct custom affiliate fee", async function () {
		await context.controlFacet.registerAffiliate(context.signers.hedger)
		await context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [18], [18])
		await context.controlFacet.setCustomAffiliateFee(
			context.signers.hedger.address,
			[context.signers.user.address],
			[1],
			[17],
			[17],
		)
		let validator = new SendQuoteValidator()
		const before = await validator.before(context, { user: user })
		let qId = await user.sendQuote(limitQuoteRequestBuilder().affiliate(context.signers.hedger.address).build())
		await validator.after(context, { user: user, quoteId: qId, beforeOutput: before })
	})

	it("Should decode new SendQuote event paramsData correctly using abi.decode", async function () {
		// Send a quote with data using the existing helper
		const qId = await user.sendQuoteWithData()

		// Get the quote from storage to verify values
		const quote = await context.viewFacetQuote.getQuote(qId)

		// Query for the new SendQuote event using queryFilter on partyAFacet
		// The new event signature: SendQuote(address indexed partyA, uint256 indexed quoteId, address[], address, bytes, bytes)
		const newEventFilter = context.partyAFacet.filters["SendQuote(address,uint256,address[],address,bytes,bytes)"]
		const events = await context.partyAFacet.queryFilter(newEventFilter())
		expect(events.length).to.be.greaterThan(0)

		// Get the most recent event
		const latestEvent = events[events.length - 1]
		const decodedEvent = latestEvent.args

		// Verify indexed params
		expect(decodedEvent.partyA).to.equal(await user.getAddress())
		expect(decodedEvent.quoteId).to.equal(qId)

		// Decode paramsData using standard ABI decoder (now that we use abi.encode instead of abi.encodePacked)
		const paramsData = decodedEvent.paramsData
		const decodedParams = ethers.AbiCoder.defaultAbiCoder().decode(
			["uint256", "uint8", "uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
			paramsData
		)

		// Verify decoded params match the quote from storage
		expect(decodedParams[0]).to.equal(quote.symbolId) // symbolId
		expect(decodedParams[1]).to.equal(BigInt(quote.positionType)) // positionType
		expect(decodedParams[2]).to.equal(BigInt(quote.orderType)) // orderType
		expect(decodedParams[3]).to.equal(quote.requestedOpenPrice) // price
		expect(decodedParams[4]).to.equal(quote.marketPrice) // marketPrice
		expect(decodedParams[5]).to.equal(quote.quantity) // quantity
		expect(decodedParams[6]).to.equal(quote.lockedValues.cva) // cva
		expect(decodedParams[7]).to.equal(quote.lockedValues.lf) // lf
		expect(decodedParams[8]).to.equal(quote.lockedValues.partyAmm) // partyAmm
		expect(decodedParams[9]).to.equal(quote.lockedValues.partyBmm) // partyBmm
		expect(decodedParams[10]).to.equal(quote.tradingFee) // tradingFee
		expect(decodedParams[11]).to.equal(quote.deadline) // deadline

		// Decode and verify custom data - the default data is encoded "hello-world"
		const eventData = decodedEvent.data
		const decodedCustomData = ethers.AbiCoder.defaultAbiCoder().decode(["string"], eventData)
		expect(decodedCustomData[0]).to.equal("hello-world")

		// Verify affiliate matches what's in the quote
		expect(decodedEvent.affiliate).to.equal(quote.affiliate)
	})

	it("Should decode new SendQuote event paramsData correctly using manual byte slicing", async function () {
		// Helper function to decode paramsData manually without ethers AbiCoder
		function decodeSendQuoteParamsDataManual(paramsData: string): {
			symbolId: bigint;
			positionType: number;
			orderType: number;
			price: bigint;
			marketPrice: bigint;
			quantity: bigint;
			cva: bigint;
			lf: bigint;
			partyAmm: bigint;
			partyBmm: bigint;
			tradingFee: bigint;
			deadline: bigint;
		} {
			// Remove 0x prefix if present
			const hex = paramsData.startsWith("0x") ? paramsData.slice(2) : paramsData;

			// With abi.encode, each value is padded to 32 bytes (64 hex chars)
			let offset = 0;
			const sliceUint256 = (): bigint => {
				const value = BigInt("0x" + hex.slice(offset, offset + 64));
				offset += 64;
				return value;
			};

			return {
				symbolId: sliceUint256(),
				positionType: Number(sliceUint256()), // uint8 padded to 32 bytes
				orderType: Number(sliceUint256()),    // uint8 padded to 32 bytes
				price: sliceUint256(),
				marketPrice: sliceUint256(),
				quantity: sliceUint256(),
				cva: sliceUint256(),
				lf: sliceUint256(),
				partyAmm: sliceUint256(),
				partyBmm: sliceUint256(),
				tradingFee: sliceUint256(),
				deadline: sliceUint256(),
			};
		}

		// Send a quote with data using the existing helper
		const qId = await user.sendQuoteWithData()

		// Get the quote from storage to verify values
		const quote = await context.viewFacetQuote.getQuote(qId)

		// Query for the new SendQuote event
		const newEventFilter = context.partyAFacet.filters["SendQuote(address,uint256,address[],address,bytes,bytes)"]
		const events = await context.partyAFacet.queryFilter(newEventFilter())
		expect(events.length).to.be.greaterThan(0)

		// Get the most recent event
		const latestEvent = events[events.length - 1]
		const decodedEvent = latestEvent.args

		// Decode paramsData using manual byte slicing
		const paramsData = decodedEvent.paramsData
		const decodedParams = decodeSendQuoteParamsDataManual(paramsData)

		// Verify decoded params match the quote from storage
		expect(decodedParams.symbolId).to.equal(quote.symbolId)
		expect(BigInt(decodedParams.positionType)).to.equal(BigInt(quote.positionType))
		expect(BigInt(decodedParams.orderType)).to.equal(BigInt(quote.orderType))
		expect(decodedParams.price).to.equal(quote.requestedOpenPrice)
		expect(decodedParams.marketPrice).to.equal(quote.marketPrice)
		expect(decodedParams.quantity).to.equal(quote.quantity)
		expect(decodedParams.cva).to.equal(quote.lockedValues.cva)
		expect(decodedParams.lf).to.equal(quote.lockedValues.lf)
		expect(decodedParams.partyAmm).to.equal(quote.lockedValues.partyAmm)
		expect(decodedParams.partyBmm).to.equal(quote.lockedValues.partyBmm)
		expect(decodedParams.tradingFee).to.equal(quote.tradingFee)
		expect(decodedParams.deadline).to.equal(quote.deadline)

		// Verify affiliate matches what's in the quote
		expect(decodedEvent.affiliate).to.equal(quote.affiliate)
	})
}
