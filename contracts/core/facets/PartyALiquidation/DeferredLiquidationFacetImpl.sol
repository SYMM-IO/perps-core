// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonLiquidation } from "../../libraries/muon/LibMuonLiquidation.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LockedValues, QuoteStorage } from "../../storages/QuoteStorage.sol";
import { LiquidationType, LiquidationDetail, Price, AccountStorage } from "../../storages/AccountStorage.sol";
import { DeferredLiquidationSig } from "../../storages/MuonStorage.sol";
import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { LibLiquidation } from "../../libraries/LibLiquidation.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library DeferredLiquidationFacetImpl {
	using LockedValuesOps for LockedValues;

	/// @notice Initiates a deferred liquidation for Party A using a historical insolvency proof
	function deferredLiquidatePartyA(address partyA, DeferredLiquidationSig memory liquidationSig) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		LibMuonLiquidation.verifyDeferredLiquidationSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);

		int256 liquidationAvailableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			liquidationSig.upnl,
			liquidationSig.liquidationAllocatedBalance,
			partyA
		);
		require(liquidationAvailableBalance < 0, "LiquidationFacet: PartyA is solvent");

		int256 availableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			liquidationSig.upnl,
			accountLayout.allocatedBalances[partyA],
			partyA
		);
		if (availableBalance > 0) {
			accountLayout.allocatedBalances[partyA] -= uint256(availableBalance);
			accountLayout.partyADeferredBalance[partyA] += uint256(availableBalance);
			emit SharedEvents.BalanceChangePartyA(partyA, uint256(availableBalance), SharedEvents.BalanceChangeType.DEFERRED_BALANCE_OUT);
		}

		maLayout.liquidationStatus[partyA] = true;
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		accountLayout.liquidationDetails[partyA] = LiquidationDetail({
			liquidationId: liquidationSig.liquidationId,
			liquidationType: LiquidationType.NONE,
			upnl: liquidationSig.upnl,
			totalUnrealizedLoss: liquidationSig.totalUnrealizedLoss,
			deficit: 0,
			liquidationFee: 0,
			timestamp: liquidationSig.timestamp,
			involvedPartyBCounts: 0,
			partyAAccumulatedUpnl: 0,
			disputed: false,
			liquidationTimestamp: liquidationSig.liquidationTimestamp
		});
		accountLayout.liquidators[partyA].push(msg.sender);
	}

	/// @notice Sets symbol prices for a deferred liquidation and determines the liquidation type
	function deferredSetSymbolsPrice(address partyA, DeferredLiquidationSig memory liquidationSig) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		LibMuonLiquidation.verifyDeferredLiquidationSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");

		LiquidationDetail storage detail = accountLayout.liquidationDetails[partyA];
		require(keccak256(detail.liquidationId) == keccak256(liquidationSig.liquidationId), "LiquidationFacet: Invalid liquidationId");

		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		for (uint256 index = 0; index < liquidationSig.symbolIds.length; index++) {
			accountLayout.symbolsPrices[partyA][liquidationSig.symbolIds[index]] = Price(liquidationSig.prices[index], detail.timestamp);
		}

		int256 availableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			liquidationSig.upnl,
			accountLayout.allocatedBalances[partyA],
			partyA
		);

		LibLiquidation.determineLiquidationType(partyA, availableBalance);
	}
}
