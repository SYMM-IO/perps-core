import { ethers, run } from "hardhat"

import { createRunContext } from "../test/models/RunContext"
import { decimal, getBlockTimestamp, getQuoteQuantity } from "../test/utils/Common"
import { runTx } from "../test/utils/TxUtils"
import { toUtf8Bytes } from "ethers"
import { User } from "../test/models/User"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder } from "../test/models/requestModels/QuoteRequest"
import { PositionType } from "../test/models/Enums"
import { Hedger } from "../test/models/Hedger"
import { limitOpenRequestBuilder } from "../test/models/requestModels/OpenRequest"

export async function initializeAndDeposit(): Promise<void> {
	const collateral = await run("deploy:stablecoin")
	const diamond = await run("deploy:diamond", {
		logData: false,
		genABI: false,
		reportGas: true,
	})
	if (process.env.DEPLOY_MULTICALL == "true") {
		await run("deploy:multicall")
	}

	const multiAccount = await run("deploy:multiAccount", {
		symmioAddress: await diamond.getAddress(),
		admin: process.env.ADMIN_PUBLIC_KEY,
	})
	const multiAccount2 = await run("deploy:multiAccount", {
		symmioAddress: await diamond.getAddress(),
		admin: process.env.ADMIN_PUBLIC_KEY,
	})

	const context = await createRunContext(
		await diamond.getAddress(),
		await collateral.getAddress(),
		await multiAccount.getAddress(),
		await multiAccount2.getAddress(),
		true,
	)

	const adminAddress = await context.signers.admin.getAddress()
	await runTx(context.controlFacet.connect(context.signers.admin).setAdmin(adminAddress))
	await runTx(context.controlFacet.connect(context.signers.admin).setCollateral(await context.collateral.getAddress()))

	const roleNames = [
		"SYMBOL_MANAGER_ROLE",
		"SETTER_ROLE",
		"PAUSER_ROLE",
		"PARTY_B_MANAGER_ROLE",
		"SUSPENDER_ROLE",
		"DISPUTE_ROLE",
		"AFFILIATE_MANAGER_ROLE",
		"LIQUIDATOR_ROLE",
	]
	for (const roleName of roleNames) {
		await runTx(context.controlFacet.connect(context.signers.admin).grantRole(adminAddress, ethers.keccak256(toUtf8Bytes(roleName))))
	}

	await runTx(
		context.controlFacet
			.connect(context.signers.admin)
			.grantRole(await context.signers.liquidator.getAddress(), ethers.keccak256(toUtf8Bytes("LIQUIDATOR_ROLE"))),
	)

	await runTx(
		context.controlFacet
			.connect(context.signers.admin)
			.addSymbol("BTCUSDT", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900),
	)

	await runTx(context.controlFacet.connect(context.signers.admin).setPendingQuotesValidLength(10))
	await runTx(context.controlFacet.connect(context.signers.admin).setLiquidatorShare(decimal(1n, 17)))
	await runTx(context.controlFacet.connect(context.signers.admin).setLiquidationTimeout(100))
	await runTx(context.controlFacet.connect(context.signers.admin).setDeallocateCooldown(120))
	await runTx(context.controlFacet.connect(context.signers.admin).setSettlementCooldown(300))
	await runTx(context.controlFacet.connect(context.signers.admin).setDeallocateDebounceTime(120))
	await runTx(context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(decimal(10000n)))
	await runTx(context.controlFacet.connect(context.signers.admin).setForceCloseCooldowns(300, 120))
	await runTx(context.controlFacet.connect(context.signers.admin).setForceCancelCooldown(300))
	await runTx(context.controlFacet.connect(context.signers.admin).setForceCancelCloseCooldown(300))
	await runTx(context.controlFacet.connect(context.signers.admin).setInvalidBridgedAmountsPool(context.signers.feeCollector.getAddress()))
	await runTx(context.controlFacet.connect(context.signers.admin).registerPartyB(context.signers.hedger.getAddress()))
	await runTx(context.controlFacet.connect(context.signers.admin).registerPartyB(context.signers.hedger2.getAddress()))
	await runTx(context.controlFacet.connect(context.signers.admin).registerAffiliate(context.multiAccount))
	await runTx(context.controlFacet.connect(context.signers.admin).registerAffiliate(context.multiAccount2!))
	await runTx(context.controlFacet.connect(context.signers.admin).setFeeCollector(context.multiAccount, context.signers.feeCollector.address))
	await runTx(context.controlFacet.connect(context.signers.admin).setFeeCollector(context.multiAccount2!, context.signers.feeCollector2.address))

	const user = new User(context, context.signers.user)
	await user.setup()
	await user.setBalances(decimal(2000n), decimal(1500n), decimal(1200n))

	const userAddress = await context.signers.user.getAddress()
	const allocated = await context.viewFacet.allocatedBalanceOfPartyA(userAddress)
	console.log("Allocated balance for user:", allocated.toString())

	const quoteIds: bigint[] = []
	quoteIds.push(await user.sendQuote())
	quoteIds.push(await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()))
	quoteIds.push(await user.sendQuote(marketQuoteRequestBuilder().build()))
	quoteIds.push(
		await user.sendQuote(
			limitQuoteRequestBuilder()
				.partyBWhiteList([await context.signers.hedger.getAddress()])
				.build(),
		),	
	)

	console.log("Sent quote ids:", quoteIds.map(id => id.toString()).join(", "))

	const hedger = new Hedger(context, context.signers.hedger)
	await hedger.setup()
	await hedger.setBalances(decimal(6000n), decimal(5000n))

	await hedger.lockQuote(quoteIds[0])

	const openQuoteId = quoteIds[1]
	await hedger.lockQuote(openQuoteId)
	const filledAmount = await getQuoteQuantity(context, openQuoteId)
	await hedger.openPosition(openQuoteId, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(decimal(1n)).price(decimal(1n, 17)).build())

	console.log("Address report:")
	console.log("  diamond:", context.diamond)
	console.log("  collateral:", await context.collateral.getAddress())
	console.log("  multiAccount:", context.multiAccount)
	console.log("  multiAccount2:", context.multiAccount2)
	console.log("  admin:", await context.signers.admin.getAddress())
	console.log("  user:", userAddress)
	console.log("  hedger:", await context.signers.hedger.getAddress())
	console.log("  hedger2:", await context.signers.hedger2.getAddress())
	console.log("  liquidator:", await context.signers.liquidator.getAddress())
}

async function main() {
	await initializeAndDeposit()
	console.log("Initialized and deposited successfully")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
