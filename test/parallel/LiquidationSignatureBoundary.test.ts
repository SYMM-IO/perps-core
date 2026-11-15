import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { Hedger } from "../models/Hedger.js"
import { User } from "../models/User.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"
import { conservationOracle } from "../utils/ConservationOracle.js"
import { partyALiquidationHash } from "../utils/LiquidationPriceBasis.js"
import { deterministicMuonKey, signMuonHash } from "../utils/MuonSignature.js"
import { getDummyLiquidationSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "../utils/SignatureUtils.js"

type Path = "legacy" | "deferred" | "snapshot"
type Shift = "left" | "right" | "all"

async function setup() {
	const context = await loadFixture(initializeFixture)
	const user = new User(context, context.signers.user)
	await user.setup()
	await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
	const hedger = new Hedger(context, context.signers.hedger)
	await hedger.setup()
	await hedger.setBalances(decimal(5000n), decimal(5000n))
	const quoteId = await user.sendQuote(
		limitQuoteRequestBuilder()
			.price(decimal(10n))
			.quantity(decimal(10n))
			.cva(decimal(40n))
			.lf(decimal(10n))
			.partyAmm(decimal(20n))
			.upnlSig(getDummySingleUpnlAndPriceSig(decimal(10n)))
			.build(),
	)
	await hedger.lockQuote(quoteId)
	await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(decimal(10n)).openPrice(decimal(10n)).price(decimal(10n)).build())
	const allocation = await context.viewFacet.allocatedBalanceOfPartyA(user.address)
	await context.accountFacet.connect(user.signer).deallocate(allocation - decimal(100n), await getDummySingleUpnlSig(0n))

	// Setup trades use the standard fixture mock. Every action under investigation below uses
	// the production verifier, with genuine test-key Schnorr and gateway ECDSA signatures.
	const verifier = await (await ethers.getContractFactory("MuonSignatureVerifier")).deploy(context.signers.admin.address)
	const key = deterministicMuonKey()
	const gateway = context.signers.admin
	await verifier.addPublicKey(key.publicKey)
	await verifier.setPublicKeyPermissions(key.publicKey, [5], true) // MuonFunction.LiquidationPartyA
	await verifier.addGatewaySigner(gateway.address)
	await verifier.setGatewaySignerPermissions(gateway.address, [5], true)
	await context.controlFacet.setMuonIds(1n)
	await context.controlFacet.setMuonConfig(300n, 300n)
	await context.controlFacet.setSignatureVerifierAddress(verifier.target)
	return { context, user, hedger, quoteId, key, gateway }
}

async function signedScenario(path: Path) {
	const fixture = await loadFixture(setup)
	const { context, user, hedger, key, gateway } = fixture
	const base = {
		...(await getDummyLiquidationSig("0x" + "22".repeat(32), -decimal(80n), [1n], [decimal(2n)], -decimal(80n), decimal(100n))),
		reqId: "0x" + "11".repeat(32),
		states: [{ partyB: hedger.address, symbolId: 1n, price: decimal(2n), cumulativeLongFee: 0n, cumulativeShortFee: 0n }],
	}
	const sign = async (sig: typeof base) => {
		const hash = await partyALiquidationHash(context, user.address, path, sig)
		return { ...sig, sigs: signMuonHash(hash, key), gatewaySignature: await gateway.signMessage(ethers.getBytes(hash)) }
	}
	const priceSig = await sign(base)
	const startSig = path === "snapshot" ? await sign({ ...base, states: [] }) : priceSig
	const legacy = context.partyALiquidationFacet.connect(context.signers.liquidator)
	const snapshot = context.partyALiquidationSnapshotFacet.connect(context.signers.liquidator)
	const start = (sig = startSig, signer = context.signers.liquidator) => {
		if (path === "snapshot") return context.partyALiquidationSnapshotFacet.connect(signer).liquidatePartyAWithSnapshot(user.address, sig)
		const facet = context.partyALiquidationFacet.connect(signer)
		return path === "legacy" ? facet.liquidatePartyA(user.address, sig) : facet.deferredLiquidatePartyA(user.address, sig)
	}
	const setPrices = (sig = priceSig) => {
		if (path === "snapshot") return snapshot.setSymbolsPriceWithSnapshot(user.address, sig)
		return path === "legacy" ? legacy.setSymbolsPrice(user.address, sig) : legacy.deferredSetSymbolsPrice(user.address, sig)
	}
	const complete = async () => {
		if (path === "snapshot") {
			await snapshot.liquidatePositionsPartyAWithSnapshot(user.address, [fixture.quoteId])
			await snapshot.settlePartyALiquidationWithSnapshot(user.address, [hedger.address])
		} else {
			await legacy.liquidatePositionsPartyA(user.address, [fixture.quoteId])
			await legacy.settlePartyALiquidation(user.address, [hedger.address])
		}
		expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		expect(await context.viewFacetQuote.partyAPositionsCount(user.address)).to.equal(0n)
		const ledger = await conservationOracle(context, { partyAs: [user.address], partyBs: [hedger.address], quoteIds: [fixture.quoteId] })
		expect(ledger.diff).to.equal(0n)
		return {
			userBalance: await context.viewFacet.balanceOf(user.address),
			userAllocation: await context.viewFacet.allocatedBalanceOfPartyA(user.address),
			hedgerBalance: await context.viewFacet.balanceOf(hedger.address),
			hedgerAllocation: await context.viewFacet.allocatedBalanceOfPartyB(hedger.address, user.address),
			liquidatorBalance: await context.viewFacet.balanceOf(context.signers.liquidator.address),
			quoteStatus: (await context.viewFacetQuote.getQuote(fixture.quoteId)).quoteStatus,
		}
	}
	return { ...fixture, startSig, priceSig, start, setPrices, complete }
}

function repartition<T extends { reqId: string; liquidationId: string }>(sig: T, shift: Shift): T {
	if (shift === "left") return { ...sig, reqId: sig.reqId.slice(0, -2), liquidationId: "0x" + sig.reqId.slice(-2) + sig.liquidationId.slice(2) }
	if (shift === "right") return { ...sig, reqId: sig.reqId + sig.liquidationId.slice(2, 4), liquidationId: "0x" + sig.liquidationId.slice(4) }
	return { ...sig, reqId: sig.reqId + sig.liquidationId.slice(2), liquidationId: "0x" }
}

// No new signature is made after repartition. All three verifier paths must reject
// altered field boundaries while accepting the original 32-byte liquidation ID.
describe("PartyA liquidation signature ID boundary", function () {
	for (const path of ["legacy", "deferred", "snapshot"] as const) {
		it(`${path}: rejects an unprivileged caller and independently altered PnL with real signatures`, async function () {
			const { context, user, startSig, start } = await signedScenario(path)
			await expect(start(startSig, context.signers.user2)).to.be.revertedWith("Accessibility: Must have role")
			await expect(start({ ...startSig, upnl: startSig.upnl - 1n })).to.be.revertedWith("MuonSignatureVerifier: TSS not verified")
			expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
			await expect(start()).to.not.be.reverted
			expect((await user.getLiquidatedStateOfPartyA()).liquidationId).to.equal(startSig.liquidationId)
		})

		for (const shift of ["left", "right", "all"] as const) {
			it(`${path}/${shift}: rejects a repartitioned ID under unchanged real signatures`, async function () {
				const honest = await signedScenario(path)
				await honest.start()
				await honest.setPrices()
				const expected = await honest.complete()

				const { context, user, startSig, priceSig, start, setPrices, complete } = await signedScenario(path)
				const shiftedStart = repartition(startSig, shift)
				const shiftedPrices = repartition(priceSig, shift)
				expect(ethers.dataLength(startSig.reqId)).to.equal(32)
				expect(ethers.dataLength(startSig.liquidationId)).to.equal(32)
				expect(ethers.dataLength(shiftedStart.reqId)).to.equal(shift === "left" ? 31 : shift === "right" ? 33 : 64)
				expect(ethers.dataLength(shiftedStart.liquidationId)).to.equal(shift === "left" ? 33 : shift === "right" ? 31 : 0)
				for (const [original, shifted] of [
					[startSig, shiftedStart],
					[priceSig, shiftedPrices],
				]) {
					expect(shifted.liquidationId).to.not.equal(original.liquidationId)
					expect(shifted.sigs).to.deep.equal(original.sigs)
					expect(shifted.gatewaySignature).to.equal(original.gatewaySignature)
					expect(await partyALiquidationHash(context, user.address, path, shifted)).to.equal(
						await partyALiquidationHash(context, user.address, path, original),
					)
				}
				await expect(start(shiftedStart)).to.be.revertedWith("LibMuon: Invalid liquidationId length")
				expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
				expect(await context.viewFacetQuote.partyAPositionsCount(user.address)).to.equal(1n)
				await start()
				await expect(setPrices(shiftedPrices)).to.be.revertedWith("LibMuon: Invalid liquidationId length")
				await setPrices()
				expect(await complete()).to.deep.equal(expected)
			})
		}
	}
})
