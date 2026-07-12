// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonLiquidation } from "../muon/LibMuonLiquidation.sol";
import { LibMuon } from "../muon/LibMuon.sol";
import { LibPartyALiquidationSnapshotGuards } from "./LibPartyALiquidationSnapshotGuards.sol";
import { LibPartyALiquidationShared } from "./LibPartyALiquidationShared.sol";
import { LibSymbolAdjustment } from "../LibSymbolAdjustment.sol";
import { AccountStorage, Price } from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { DeferredLiquidationSig, LiquidationSig } from "../../storages/MuonStorage.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library LibPartyALiquidationLegacySetup {
	/// @notice Verifies insolvency and initiates the legacy liquidation process for Party A.
	function liquidatePartyA(address partyA, LiquidationSig memory liquidationSig) public {
		_requireLegacyPartyALiquidationAllowed();
		LibMuonLiquidation.verifyLiquidationSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);
		require(
			block.timestamp <= liquidationSig.timestamp + LibMuon.getUpnlValidTime(MuonFunction.LiquidationPartyA),
			"LiquidationFacet: Expired signature"
		);
		require(QuoteStorage.layout().partyAPositionsCount[partyA] > 0, "LiquidationFacet: PartyA has no open positions");
		LibPartyALiquidationShared.startPartyALiquidation(
			partyA,
			liquidationSig.liquidationId,
			liquidationSig.upnl,
			liquidationSig.totalUnrealizedLoss,
			liquidationSig.timestamp,
			liquidationSig.timestamp,
			AccountStorage.layout().allocatedBalances[partyA]
		);
	}

	/// @notice Verifies historical insolvency and initiates the legacy deferred liquidation process for Party A.
	function deferredLiquidatePartyA(address partyA, DeferredLiquidationSig memory liquidationSig) public {
		_requireLegacyPartyALiquidationAllowed();
		LibMuonLiquidation.verifyDeferredLiquidationSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);
		LibPartyALiquidationShared.startPartyALiquidation(
			partyA,
			liquidationSig.liquidationId,
			liquidationSig.upnl,
			liquidationSig.totalUnrealizedLoss,
			liquidationSig.timestamp,
			liquidationSig.liquidationTimestamp,
			liquidationSig.liquidationAllocatedBalance
		);
	}

	/// @notice Sets symbol prices for a legacy liquidation.
	function setSymbolsPrice(address partyA, LiquidationSig memory liquidationSig) public {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		LibMuonLiquidation.verifyLiquidationSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		LibPartyALiquidationSnapshotGuards.requirePartyBSymbolSnapshotPricingDisabled(accountLayout, partyA);
		// Legacy price-setting relies on Muon's unique liquidationId to bind prices and timestamp to the started liquidation.
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		LibPartyALiquidationShared.validateLiquidationPriceSetup(partyA, liquidationSig.liquidationId);
		uint256 liquidationTimestamp = accountLayout.liquidationDetails[partyA].timestamp;
		for (uint256 index = 0; index < liquidationSig.symbolIds.length; index++) {
			LibSymbolAdjustment.requireNotFrozen(liquidationSig.symbolIds[index]);
			accountLayout.symbolsPrices[partyA][liquidationSig.symbolIds[index]] = Price(liquidationSig.prices[index], liquidationTimestamp);
		}
	}

	/// @notice Sets symbol prices for a legacy deferred liquidation.
	function deferredSetSymbolsPrice(address partyA, DeferredLiquidationSig memory liquidationSig) public {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		LibMuonLiquidation.verifyDeferredLiquidationSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		LibPartyALiquidationSnapshotGuards.requirePartyBSymbolSnapshotPricingDisabled(accountLayout, partyA);
		// Legacy price-setting relies on Muon's unique liquidationId to bind prices and timestamp to the started liquidation.
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		LibPartyALiquidationShared.validateLiquidationPriceSetup(partyA, liquidationSig.liquidationId);
		uint256 liquidationTimestamp = accountLayout.liquidationDetails[partyA].timestamp;
		for (uint256 index = 0; index < liquidationSig.symbolIds.length; index++) {
			LibSymbolAdjustment.requireNotFrozen(liquidationSig.symbolIds[index]);
			accountLayout.symbolsPrices[partyA][liquidationSig.symbolIds[index]] = Price(liquidationSig.prices[index], liquidationTimestamp);
		}
	}

	function _requireLegacyPartyALiquidationAllowed() private view {
		require(!GlobalAppStorage.layout().legacyPartyALiquidationDeprecated, "LiquidationFacet: Legacy liquidation deprecated");
	}
}
