// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibAccount } from "../LibAccount.sol";
import { SharedEvents } from "../SharedEvents.sol";
import { AccountStorage, LiquidationDetail, LiquidationType } from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";

library LibPartyALiquidationShared {
	function startPartyALiquidation(
		address partyA,
		bytes memory liquidationId,
		int256 upnl,
		int256 totalUnrealizedLoss,
		uint256 timestamp,
		uint256 liquidationTimestamp,
		uint256 liquidationAllocatedBalance
	) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		int256 availableBalance = LibAccount.partyAAvailableBalanceForLiquidation(upnl, accountLayout.allocatedBalances[partyA], partyA);
		if (availableBalance > 0) {
			LibAccount.decreasePartyAAllocatedBalance(partyA, uint256(availableBalance), SharedEvents.BalanceChangeType.DEFERRED_BALANCE_OUT);
			accountLayout.partyADeferredBalance[partyA] += uint256(availableBalance);
		}

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		int256 liquidationAvailableBalance = LibAccount.partyAAvailableBalanceForLiquidation(upnl, liquidationAllocatedBalance, partyA);
		require(liquidationAvailableBalance < 0, "LiquidationFacet: PartyA is solvent");

		maLayout.liquidationStatus[partyA] = true;
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		accountLayout.liquidationDetails[partyA] = LiquidationDetail({
			liquidationId: liquidationId,
			liquidationType: LiquidationType.NONE,
			upnl: upnl,
			totalUnrealizedLoss: totalUnrealizedLoss,
			deficit: 0,
			liquidationFee: 0,
			timestamp: timestamp,
			involvedPartyBCounts: 0,
			partyAAccumulatedUpnl: 0,
			disputed: false,
			liquidationTimestamp: liquidationTimestamp
		});
		accountLayout.liquidators[partyA].push(msg.sender);

		// Classify liquidation severity and cap the liquidator fee.
		LiquidationDetail storage detail = accountLayout.liquidationDetails[partyA];
		uint256 availableBalanceShortfall = uint256(-liquidationAvailableBalance);
		uint256 lockedLf = accountLayout.lockedBalances[partyA].lf;
		uint256 lockedCva = accountLayout.lockedBalances[partyA].cva;
		uint256 lockedLfAndCva = lockedLf + lockedCva;
		if (availableBalanceShortfall < lockedLf) {
			uint256 remainingLf = lockedLf - availableBalanceShortfall;
			uint256 maxLf = maLayout.maxLiquidationProfitPerPosition * QuoteStorage.layout().partyAPositionsCount[partyA];
			if (remainingLf > maxLf) {
				accountLayout.balances[maLayout.liquidationInsuranceVault] += remainingLf - maxLf;
				remainingLf = maxLf;
			}
			detail.liquidationType = LiquidationType.NORMAL;
			detail.liquidationFee = remainingLf;
		} else if (availableBalanceShortfall <= lockedLfAndCva) {
			uint256 deficit = availableBalanceShortfall - lockedLf;
			detail.liquidationType = LiquidationType.LATE;
			detail.deficit = deficit;
		} else {
			uint256 deficit = availableBalanceShortfall - lockedLfAndCva;
			detail.liquidationType = LiquidationType.OVERDUE;
			detail.deficit = deficit;
		}
	}

	function validateLiquidationPriceSetup(address partyA, bytes memory liquidationId) internal view {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		LiquidationDetail storage detail = accountLayout.liquidationDetails[partyA];
		// Bind price setup to the liquidation that was started earlier; legacy and snapshot price steps must not reuse another Muon payload.
		require(keccak256(detail.liquidationId) == keccak256(liquidationId), "LiquidationFacet: Invalid liquidationId");
		// Once open-position liquidation creates PartyB settlement buckets, re-pricing would corrupt the pending settlement state.
		require(detail.involvedPartyBCounts == 0, "LiquidationFacet: Positions already liquidated");
	}
}
