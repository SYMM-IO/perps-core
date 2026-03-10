import { shouldBehaveLikeAccessControlRoleAdmins } from "../AccessControlRoleAdmins.behavior.js"
import { shouldBehaveLikeAccountFacet } from "../AccountFacet.behavior.js"
import { shouldBehaveLikeAccountLayer } from "../AccountLayer.behavior.js"
import { shouldBehaveLikeAccountLayerAffiliate } from "../AccountLayerAffiliate.behavior.js"
import { shouldBehaveLikeAccountManager } from "../AccountManager.behavior.js"
import { shouldBehaveLikeAggregateViews } from "../AggregateViews.behavior.js"
import { shouldBehaveLikeBridgeFacet } from "../BridgeFacet.behavior.js"
import { shouldBehaveLikeCancelQuote } from "../CancelQuote.behavior.js"
import { shouldBehaveLikeClearingHouseFacet } from "../ClearingHouseFacet.behavior.js"
import { shouldBehaveLikeClosePosition } from "../ClosePosition.behavior.js"
import { shouldBehaveLikeControlFacet } from "../ControlFacet.behavior.js"
import { shouldBehaveLikeDiamond } from "../Diamond.behavior.js"
import { shouldBehaveLikeEmergencyClosePosition } from "../EmergencyClosePosition.behavior.js"
import { shouldBehaveLikeFeeDistributor } from "../FeeDistributor.behavior.js"
import { shouldBehaveLikeForceClosePosition } from "../ForceClosePosition.behavior.js"
import { shouldBehaveLikeFundingRate } from "../FundingRate.behavior.js"
import { shouldBehaveLikeFuzzTest } from "../FuzzTest.behavior.js"
import { shouldBehaveLikeHooks } from "../Hooks.behavior.js"
import { shouldBehaveLikeLiquidationFacet } from "../LiquidationFacet.behavior.js"
import { shouldBehaveLikeLockQuote } from "../LockQuote.behavior.js"
import { shouldBehaveLikeMigration } from "../Migration.behavior.js"
import { shouldBehaveLikeMultiAccount } from "../MultiAccount.behavior.js"
import { shouldBehaveLikeOpenPosition } from "../OpenPosition.behavior.js"
import { shouldBehaveLikePartyBBatchActionsFacet } from "../PartyBBatchActionsFacet.behavior.js"
import { shouldBehaveLikePartyBEmergencyActionsFacet } from "../PartyBEmergencyActionsFacet.behavior.js"
import { shouldBehaveLikeSendQuote } from "../SendQuote.behavior.js"
import { shouldBehaveLikeSettleAndForceClosePosition } from "../SettleAndForceClosePosition.behavior.js"
import { shouldBehaveLikeSettlePartyBUpnlForLiquidation } from "../SettlePartyBUpnlForLiquidation.behavior.js"
import { shouldBehaveLikeSettlement } from "../Settlement.behavior.js"
import { shouldBehaveLikeSettlementUnified } from "../SettlementUnified.behavior.js"
import { shouldBehaveLikeSpecificScenario } from "../SpecificScenario.behavior.js"
import { shouldBehaveLikeSymmioPartyB } from "../SymmioPartyB.behavior.js"
import { shouldBehaveLikeWithdrawFacet } from "../WithdrawFacet.behavior.js"
import { shouldBehaveLikeInstantLayer } from "../helpers/instant-layer.behavior.js"

describe("UnitTests", function () {
	if (process.env.TEST_MODE == "static" || process.env.TEST_MODE == null) {
		describe("Diamond", async function () {
			shouldBehaveLikeDiamond()
		})

		describe("AccountFacet", async function () {
			shouldBehaveLikeAccountFacet()
		})

		describe("SendQuote", async function () {
			shouldBehaveLikeSendQuote()
		})

		describe("LockQuote", async function () {
			shouldBehaveLikeLockQuote()
		})

		describe("OpenPosition", async function () {
			shouldBehaveLikeOpenPosition()
		})

		describe("CancelQuote", async function () {
			shouldBehaveLikeCancelQuote()
		})

		describe("ClosePosition", async function () {
			shouldBehaveLikeClosePosition()
		})

		describe("EmergencyClosePosition", async function () {
			shouldBehaveLikeEmergencyClosePosition()
		})

		describe("ForceClosePosition", async function () {
			shouldBehaveLikeForceClosePosition()
		})

		describe("SettleAndForceClosePosition", async function () {
			shouldBehaveLikeSettleAndForceClosePosition()
		})

		describe("Liquidation", async function () {
			shouldBehaveLikeLiquidationFacet()
		})

		describe("FundingRate", async function () {
			shouldBehaveLikeFundingRate()
		})

		describe("SpecificScenario", async function () {
			shouldBehaveLikeSpecificScenario()
		})

		describe("BridgeFacet", async function () {
			shouldBehaveLikeBridgeFacet()
		})

		describe("Hooks", async function () {
			shouldBehaveLikeHooks()
		})

		describe("MultiAccount", async function () {
			shouldBehaveLikeMultiAccount()
		})

		describe("ControlFacet", async function () {
			shouldBehaveLikeControlFacet()
		})

		describe("AccessControlRoleAdmins", async function () {
			shouldBehaveLikeAccessControlRoleAdmins()
		})

		describe("Migration", async function () {
			shouldBehaveLikeMigration()
		})

		describe("Settlement", async function () {
			shouldBehaveLikeSettlement()
		})

		describe("SettlementUnified", async function () {
			shouldBehaveLikeSettlementUnified()
		})

		describe("SettlePartyBUpnlForLiquidation", async function () {
			shouldBehaveLikeSettlePartyBUpnlForLiquidation()
		})

		describe("FeeDistributor", async function () {
			shouldBehaveLikeFeeDistributor()
		})

		describe("ClearingHouseFacet", async function () {
			shouldBehaveLikeClearingHouseFacet()
		})

		describe("PartyBEmergencyActionsFacet", async function () {
			shouldBehaveLikePartyBEmergencyActionsFacet()
		})

		describe("PartyBBatchActionsFacet", async function () {
			shouldBehaveLikePartyBBatchActionsFacet()
		})

		describe("InstantLayer", async function () {
			shouldBehaveLikeInstantLayer()
		})

		describe("SymmioPartyB", async function () {
			shouldBehaveLikeSymmioPartyB()
		})

		describe("WithdrawFacet", async function () {
			shouldBehaveLikeWithdrawFacet()
		})

		describe("AccountLayer", async function () {
			shouldBehaveLikeAccountLayer()
		})

		describe("AccountLayerAffiliate", async function () {
			shouldBehaveLikeAccountLayerAffiliate()
		})

		describe("AccountManager", async function () {
			shouldBehaveLikeAccountManager()
		})

		describe("AggregateViews", async function () {
			shouldBehaveLikeAggregateViews()
		})
	} else if (process.env.TEST_MODE == "fuzz") {
		describe("FuzzTest", async function () {
			shouldBehaveLikeFuzzTest()
		})
	} else {
		throw new Error("Invalid TEST_MODE property. should be static or fuzz")
	}
})
