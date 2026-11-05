import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "../models/Enums.js"
import { configureFuzzLayers, FuzzLayerUser, type FuzzLayerRoute } from "../models/FuzzLayerUser.js"
import { Hedger } from "../models/Hedger.js"
import type { RunContext } from "../models/RunContext.js"
import { TestManager } from "../models/TestManager.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { SendQuoteValidator } from "../models/validators/SendQuoteValidator.js"
import { decimal } from "../utils/Common.js"
import { executeFuzzLayerLifecycle } from "../utils/FuzzLayerCampaign.js"
import { setRandomSeed } from "../utils/RandomUtils.js"

describe("Fuzz layer flows", function () {
	let context: RunContext
	let hedger: Hedger

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		context.manager = new TestManager(context, false, "direct")
		await context.manager.start()
		await context.controlFacet.setBalanceLimitPerUser(decimal(10_000_000n))
		await configureFuzzLayers(context)
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(1_000_000n), decimal(1_000_000n))
	})

	afterEach(async function () {
		setRandomSeed(undefined)
		await context?.manager.stopAndDrain(30_000)
	})

	for (const route of ["account-layer", "instant-layer"] as const) {
		for (const [isolationType, isolation] of ["POSITION", "MARKET", "MARKET_DIRECTION", "CUSTOM"].entries()) {
			it(`funds, partially opens/closes, cleans up, and reuses ${isolation} VAs through ${route}`, async function () {
				setRandomSeed(`${route}:${isolation}`)
				const result = await executeFuzzLayerLifecycle({
					context,
					manager: context.manager,
					owner: context.signers.user,
					hedger,
					route,
					isolationType,
				})
				expect(result.quoteIds).to.have.length(3)
				expect(result.detail).to.include(`${route}; isolation=${isolationType}`)
			})
		}

		for (const vaIsolationType of [0, 1, 2, 3]) {
			it(`trades and reuses CUSTOM child VA isolation ${vaIsolationType} through ${route}`, async function () {
				setRandomSeed(`${route}:CUSTOM:${vaIsolationType}`)
				const result = await executeFuzzLayerLifecycle({
					context,
					manager: context.manager,
					owner: context.signers.user,
					hedger,
					route,
					isolationType: 3,
					vaIsolationType,
					positionType: vaIsolationType === 3 ? PositionType.SHORT : PositionType.LONG,
				})
				expect(result.quoteIds).to.have.length(3)
			})
		}

		it(`keeps ordinary ${route} actors on their sub-account through quote submission and cancellation`, async function () {
			const user = await fundedUser(route)
			const validator = new SendQuoteValidator()
			const before = await validator.before(context, { user })
			const quoteId = await user.sendQuote()
			await validator.after(context, { user, quoteId, beforeOutput: before })
			expect((await context.viewFacetQuote.getQuote(quoteId)).partyA).to.equal(user.address)
			expect(user.address).not.to.equal(user.signer.address)
			await user.requestToCancelQuote(quoteId)
			expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.CANCELED))
			expect((await user.getBalanceInfo()).allocatedBalances).to.equal(before.balanceInfoPartyA.allocatedBalances)
			await user.assertExecutionContextCleared()
		})
	}

	async function fundedUser(route: FuzzLayerRoute): Promise<FuzzLayerUser> {
		const user = new FuzzLayerUser(context, context.signers.user, route)
		await user.setup()
		await user.setBalances(decimal(10_000n), decimal(10_000n), decimal(10_000n))
		return user
	}

	it("rejects replay of both ordered and unordered signed operations", async function () {
		const user = await fundedUser("instant-layer")
		for (let index = 0; index < 2; index++) {
			await user.sendQuote()
			const { operation, signature, hash } = user.lastSignedOperation!
			expect(BigInt(operation.replayAttackHeader.nonce) === 0n).to.equal(index === 0)
			const nonceBefore = await context.instantLayer.nonces(user.address)
			const balanceBefore = await user.getBalanceInfo()
			await expect(context.instantLayer.executeBatch([operation], [signature], [[]], [[]]))
				.to.be.revertedWithCustomError(context.instantLayer, "MaxUsesExceeded")
				.withArgs(hash, 1n)
			expect(await context.instantLayer.nonces(user.address)).to.equal(nonceBefore)
			expect(await context.instantLayer.operationUsageCount(hash)).to.equal(1n)
			expect(await user.getBalanceInfo()).to.deep.equal(balanceBefore)
			await user.assertExecutionContextCleared()
		}
	})

	it("rolls back signed-operation usage and nonce when an inner layer call fails", async function () {
		const user = await fundedUser("instant-layer")
		await user.sendQuote()
		const { operation: successful } = user.lastSignedOperation!
		const nonceBefore = await context.instantLayer.nonces(user.address)
		const operation = {
			...successful,
			callData: context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [999_999n]),
			replayAttackHeader: { ...successful.replayAttackHeader, nonce: nonceBefore + 1n, salt: ethers.id("fuzz-failed-operation") },
		}
		const signature = await user.signer.signTypedData(
			{
				name: "SymmioInstantLayer",
				version: "1",
				chainId: (await ethers.provider.getNetwork()).chainId,
				verifyingContract: await context.instantLayer.getAddress(),
			},
			cloneTypes(),
			operation,
		)
		const hash = await context.instantLayer.getOperationHash(operation)
		await expect(context.instantLayer.executeBatch([operation], [signature], [[]], [[]])).to.be.revertedWithCustomError(
			context.instantLayer,
			"OperationFailed",
		)
		expect(await context.instantLayer.operationUsageCount(hash)).to.equal(0n)
		expect(await context.instantLayer.nonces(user.address)).to.equal(nonceBefore)
		await user.assertExecutionContextCleared()
	})

	it("rejects an owner signature when signed calldata has been changed", async function () {
		const user = await fundedUser("instant-layer")
		await user.sendQuote(limitQuoteRequestBuilder().build())
		const { operation, signature } = user.lastSignedOperation!
		const tampered = { ...operation, callData: context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [1n]) }
		await expect(context.instantLayer.executeBatch([tampered], [signature], [[]], [[]])).to.be.revertedWithCustomError(
			context.instantLayer,
			"InvalidSignature",
		)
		expect(await context.instantLayer.operationUsageCount(await context.instantLayer.getOperationHash(tampered))).to.equal(0n)
		await user.assertExecutionContextCleared()
	})
})
