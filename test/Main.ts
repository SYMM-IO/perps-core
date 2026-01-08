import { shouldBehaveLikeFuzzTest } from "./FuzzTest.behavior.js"
import { shouldBehaveLikeSettleAndForceClosePosition } from "./SettleAndForceClosePosition.behavior.js"
import { shouldBehaveLikeFeeDistributor } from "./FeeDistributor.behavior.js"
import { shouldBehaveLikeDiamond } from "./Diamond.behavior.js"
import { shouldBehaveLikeAccountFacet } from "./AccountFacet.behavior.js"
import { shouldBehaveLikeSendQuote } from "./SendQuote.behavior.js"
import { shouldBehaveLikeLockQuote } from "./LockQuote.behavior.js"
import { shouldBehaveLikeOpenPosition } from "./OpenPosition.behavior.js"
import { shouldBehaveLikeCancelQuote } from "./CancelQuote.behavior.js"
import { shouldBehaveLikeClosePosition } from "./ClosePosition.behavior.js"
import { shouldBehaveLikeEmergencyClosePosition } from "./EmergencyClosePosition.behavior.js"
import { shouldBehaveLikeForceClosePosition } from "./ForceClosePosition.behavior.js"
import { shouldBehaveLikeLiquidationFacet } from "./LiquidationFacet.behavior.js"
import { shouldBehaveLikeFundingRate } from "./FundingRate.behavior.js"
import { shouldBehaveLikePartyBPositionViews } from "./PartyBPositionViews.behavior.js"
import { shouldBehaveLikeSpecificScenario } from "./SpecificScenario.behavior.js"
import { shouldBehaveLikeBridgeFacet } from "./BridgeFacet.behavior.js"
import { shouldBehaveLikeMultiAccount } from "./MultiAccount.behavior.js"
import { shouldBehaveLikeControlFacet } from "./ControlFacet.behavior.js"
import { shouldBehaveLikeHooks } from "./Hooks.behavior.js"
import { shouldBehaveLikeSettlement } from "./Settlement.behavior.js"
import { shouldBehaveLikeSettlementUnified } from "./SettlementUnified.behavior.js"
import { shouldBehaveLikeClearingHouseFacet } from "./ClearingHouseFacet.behavior.js"
import { shouldBehaveLikePartyBBatchActionsFacet } from "./PartyBBatchActionsFacet.behavior.js"
import { shouldBehaveLikeInstantLayer } from "./helpers/instant-layer.behavior.js"
import { shouldBehaveLikeAccountHub } from "./AccountHub.behavior.js"
import { shouldBehaveLikeAffiliateHub } from "./AffiliateHub.behavior.js"
import { shouldBehaveLikeAccountManager } from "./AccountManager.behavior.js"
import { shouldBehaveLikeWithdrawFacet } from "./WithdrawFacet.behavior.js";
import { shouldBehaveLikeAccessControlRoleAdmins } from "./AccessControlRoleAdmins.behavior.js"
import { shouldBehaveLikeMasterAccountMigration } from "./MasterAccountMigration.behavior.js"
import { shouldBehaveLikeAggregateFunding } from "./AggregateFunding.behavior.js"

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

		describe("PartyBPositionViews", async function () {
			shouldBehaveLikePartyBPositionViews()
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

		describe("MasterAccountMigration", async function () {
			shouldBehaveLikeMasterAccountMigration()
		})

		describe("Settlement", async function () {
			shouldBehaveLikeSettlement()
		})

		describe("SettlementUnified", async function () {
			shouldBehaveLikeSettlementUnified()
		})

		describe("FeeDistributor", async function () {
			shouldBehaveLikeFeeDistributor()
		})

		describe("ClearingHouseFacet", async function () {
			shouldBehaveLikeClearingHouseFacet()
		})

		describe("PartyBBatchActionsFacet", async function () {
			shouldBehaveLikePartyBBatchActionsFacet()
		})

		describe("InstantLayer", async function () {
			shouldBehaveLikeInstantLayer()
		})

		describe("WithdrawFacet", async function () {
			shouldBehaveLikeWithdrawFacet()
		})

		describe("AccountHub", async function () {
			shouldBehaveLikeAccountHub()
		})

		describe("AffiliateHub", async function () {
			shouldBehaveLikeAffiliateHub()
		})

		describe("AccountManager", async function () {
			shouldBehaveLikeAccountManager()
		})

		describe("AggregateFunding", async function () {
			shouldBehaveLikeAggregateFunding()
		})
	} else if (process.env.TEST_MODE == "fuzz") {
		describe("FuzzTest", async function () {
			shouldBehaveLikeFuzzTest()
		})
	} else {
		throw new Error("Invalid TEST_MODE property. should be static or fuzz")
	}
})
