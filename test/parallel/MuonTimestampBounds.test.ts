import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture, time } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"
import { User } from "../models/User.js"
import { decimal } from "../utils/Common.js"
import { getDummySingleUpnlSig, getDummySingleUpnlWithPendingBalanceSig } from "../utils/SignatureUtils.js"

describe("Muon timestamp bounds", function () {
	let context: RunContext
	let user: User

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(500n), decimal(200n), decimal(100n))
		await context.controlFacet.connect(context.signers.admin).setMuonConfig(60, 60)
	})

	for (const { category, functionId, method } of [
		{ category: "AccountManagement", functionId: 1, method: "deallocate" as const },
		{ category: "RemoveMargin", functionId: 7, method: "safeDeallocate" as const },
	]) {
		describe(category, function () {
			async function signature(timestamp: bigint) {
				const sig = method === "deallocate" ? await getDummySingleUpnlSig() : await getDummySingleUpnlWithPendingBalanceSig()
				return { ...sig, timestamp }
			}

			async function check(timestamp: bigint) {
				return context.accountFacet.connect(user.signer)[method].staticCall(1n, (await signature(timestamp)) as any)
			}

			it("rejects a signature one second after the executing block without changing balances or nonce", async function () {
				const executingTimestamp = BigInt(await time.latest()) + 10n
				const sig = await signature(executingTimestamp + 1n)
				const balances = await user.getBalanceInfo()
				const nonce = await context.viewFacet.nonceOfPartyA(user.address)
				await time.setNextBlockTimestamp(executingTimestamp)
				await expect(context.accountFacet.connect(user.signer)[method](1n, sig as any, { gasLimit: 1_000_000 })).to.be.revertedWith(
					"LibMuon: Expired signature",
				)
				expect(await user.getBalanceInfo()).to.deep.equal(balances)
				expect(await context.viewFacet.nonceOfPartyA(user.address)).to.equal(nonce)
			})

			it("rejects a maximum-uint timestamp with the freshness error instead of an arithmetic panic", async function () {
				await expect(check(ethers.MaxUint256)).to.be.revertedWith("LibMuon: Expired signature")
			})

			it("accepts the current timestamp and exact expiry boundary but rejects one second older", async function () {
				const now = BigInt(await time.latest())
				await expect(check(now)).not.to.be.reverted
				await expect(check(now - 60n)).not.to.be.reverted
				await expect(check(now - 61n)).to.be.revertedWith("LibMuon: Expired signature")
			})

			it("enforces a shorter category window without allowing future timestamps", async function () {
				await context.controlFacet.connect(context.signers.admin).setMuonFunctionUpnlValidTime(functionId, 30)
				const now = BigInt(await time.latest())
				await expect(check(now - 30n)).not.to.be.reverted
				await expect(check(now - 31n)).to.be.revertedWith("LibMuon: Expired signature")
				await expect(check(now + 30n)).to.be.revertedWith("LibMuon: Expired signature")
			})

			it("supports a longer category window and clearing back to global inheritance", async function () {
				await context.controlFacet.connect(context.signers.admin).setMuonFunctionUpnlValidTime(functionId, 90)
				let now = BigInt(await time.latest())
				await expect(check(now - 90n)).not.to.be.reverted
				await expect(check(now - 91n)).to.be.revertedWith("LibMuon: Expired signature")
				await context.controlFacet.connect(context.signers.admin).setMuonFunctionUpnlValidTime(functionId, 0)
				now = BigInt(await time.latest())
				await expect(check(now - 60n)).not.to.be.reverted
				await expect(check(now - 61n)).to.be.revertedWith("LibMuon: Expired signature")
			})

			it("allows only the current block timestamp when the inherited global window is zero", async function () {
				await context.controlFacet.connect(context.signers.admin).setMuonConfig(0, 0)
				const now = BigInt(await time.latest())
				await expect(check(now)).not.to.be.reverted
				await expect(check(now - 1n)).to.be.revertedWith("LibMuon: Expired signature")
				await expect(check(now + 1n)).to.be.revertedWith("LibMuon: Expired signature")
			})

			it("checks age without overflowing when the configured validity window is maximum uint", async function () {
				await context.controlFacet.connect(context.signers.admin).setMuonConfig(ethers.MaxUint256, 60)
				await expect(check(1n)).not.to.be.reverted
				await expect(check(ethers.MaxUint256)).to.be.revertedWith("LibMuon: Expired signature")
			})
		})
	}
})
