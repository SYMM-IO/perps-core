import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture, time } from "../helpers/network-helpers.js"
import { Hedger } from "../models/Hedger.js"
import { User } from "../models/User.js"
import { limitCloseRequestBuilder } from "../models/requestModels/CloseRequest.js"
import { decimal } from "../utils/Common.js"
import { deterministicMuonKey, signMuonHash } from "../utils/MuonSignature.js"

describe("Hardening F-001: batch signature array boundaries", function () {
	async function setup(close: boolean) {
		const context = await loadFixture(initializeFixture)
		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(5000n), decimal(2000n), decimal(1000n))
		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))
		const quoteIds: bigint[] = []
		for (let i = 0; i < 2; i++) {
			const id = await user.sendQuote()
			await hedger.lockQuote(id)
			if (close) {
				await hedger.openPosition(id)
				await user.requestToClosePosition(id, limitCloseRequestBuilder().build())
			}
			quoteIds.push(BigInt(id))
		}
		const verifier = await (await ethers.getContractFactory("MuonSignatureVerifier")).deploy(context.signers.admin.address)
		const key = deterministicMuonKey()
		const gateway = context.signers.admin
		await verifier.addPublicKey(key.publicKey)
		await verifier.setPublicKeyPermissions(key.publicKey, [0], true)
		await verifier.addGatewaySigner(gateway.address)
		await verifier.setGatewaySignerPermissions(gateway.address, [0], true)
		await context.controlFacet.setMuonIds(1n)
		await context.controlFacet.setMuonConfig(300n, 300n)
		await context.controlFacet.setSignatureVerifierAddress(verifier.target)
		const timestamp = BigInt(await time.latest())
		const prices = [decimal(1n), decimal(1n)]
		const hashFor = (ids: bigint[], values: bigint[]) =>
			ethers.solidityPackedKeccak256(
				[
					"uint256",
					"bytes",
					"address",
					"address",
					"address",
					"uint256",
					"uint256",
					"int256",
					"int256",
					"uint256[]",
					"uint256[]",
					"uint256",
					"uint256",
				],
				[1n, "0x0001", context.diamond, hedger.address, user.address, nonceB, nonceA, 0n, 0n, ids, values, timestamp, chainId],
			)
		const nonceB = await context.viewFacet.nonceOfPartyB(hedger.address, user.address)
		const nonceA = await context.viewFacet.nonceOfPartyA(user.address)
		const chainId = (await ethers.provider.getNetwork()).chainId
		const hash = hashFor(quoteIds, prices)
		const signature = {
			reqId: "0x0001",
			timestamp,
			prices,
			symbolIds: [1n, 1n],
			upnlPartyA: 0n,
			upnlPartyB: 0n,
			sigs: signMuonHash(hash, key),
			gatewaySignature: await gateway.signMessage(ethers.getBytes(hash)),
		}
		const execute = (ids: bigint[], sig = signature) =>
			close
				? context.partyBBatchActionsFacet.connect(hedger.signer).fillCloseRequests(
						ids,
						ids.map(() => decimal(100n)),
						ids.map(() => decimal(1n)),
						sig,
					)
				: context.partyBBatchActionsFacet.connect(hedger.signer).openPositions(
						ids,
						ids.map(() => decimal(100n)),
						ids.map(() => decimal(1n)),
						sig,
					)
		return { context, quoteIds, prices, signature, hashFor, execute }
	}

	for (const close of [false, true]) {
		const action = close ? "close" : "open"
		it(`rejects a genuine two-quote signature repartitioned into one quote and three prices during ${action}`, async function () {
			const { context, quoteIds, prices, signature, hashFor, execute } = await setup(close)
			const shiftedPrices = [quoteIds[1], ...prices]
			expect(hashFor([quoteIds[0]], shiftedPrices)).to.equal(hashFor(quoteIds, prices))
			await expect(execute([quoteIds[0]], { ...signature, prices: shiftedPrices })).to.be.revertedWith("PartyBFacet: Invalid length")
			// The rejected payload must not consume counters or mutate either quote: the original signed batch still succeeds.
			await expect(execute(quoteIds)).to.not.be.reverted
			expect((await context.viewFacetQuote.getQuote(quoteIds[0])).quoteStatus).to.equal(close ? 7n : 4n)
		})

		it(`accepts the matching arrays with real TSS and gateway signatures during ${action}`, async function () {
			const { quoteIds, execute } = await setup(close)
			await expect(execute(quoteIds)).to.not.be.reverted
		})
	}
})
