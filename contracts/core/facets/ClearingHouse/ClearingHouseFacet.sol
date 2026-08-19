// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";

import { Pausable } from "../../utils/Pausable.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { ClearingHouseSettlement, IClearingHouseFacet } from "./IClearingHouseFacet.sol";
import { ClearingHouseFacetImpl } from "./ClearingHouseFacetImpl.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibHook } from "../../libraries/LibHook.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage, CrossLiquidationDetail, PartyATakeoverDetail } from "../../storages/ClearingHouseStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";

contract ClearingHouseFacet is Pausable, Accessibility, IClearingHouseFacet {
	/// @dev Special allocation key used to pull from partyAReimbursement in an explicit settlement.
	address private constant REIMBURSEMENT_KEY = address(1);

	/// @notice Initiates clearing house liquidation for a cross-margin PartyB.
	/// @param partyB The address of Party B.
	/// @param liquidationId Unique identifier for the liquidation event.
	/// @param upnl PartyB's unrealized profit and loss.
	/// @param timestamp Timestamp of the liquidation.
	function liquidateCrossPartyB(
		address partyB,
		bytes memory liquidationId,
		int256 upnl,
		uint256 timestamp
	) external whenNotLiquidationPaused notCrossLiquidatedPartyB(partyB) onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		ClearingHouseFacetImpl.liquidateCrossPartyB(partyB, liquidationId, upnl, timestamp);
		emit LiquidateCrossPartyB(msg.sender, partyB, liquidationId, upnl, timestamp);
	}

	/// @notice Takes over a stuck PartyA liquidation.
	/// @dev Can only be called when partyA is already being liquidated.
	///      Clears the disputed flag, liquidation fee, and liquidators array.
	///      Prevents normal liquidation functions from running.
	/// @param partyA The address of Party A.
	function takeoverPartyALiquidation(address partyA) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		bytes memory liquidationId = ClearingHouseFacetImpl.takeoverPartyALiquidation(partyA);
		emit TakeoverPartyALiquidation(partyA, liquidationId, block.timestamp);
	}

	/// @notice Deprecated unclassified Clearing House debit interface.
	/// @dev Kept only so an upgrade can replace and disable the old Diamond selector.
	function deallocateForClearingHouse(
		address,
		address[] memory,
		address[] memory,
		uint256[] memory
	) external view whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		revert("ClearingHouseFacet: Use explicit settlement");
	}

	/// @notice Deprecated unclassified Clearing House credit interface.
	/// @dev Kept only so an upgrade can replace and disable the old Diamond selector.
	function distributeForClearingHouse(
		address,
		address[] memory,
		address[] memory,
		uint256[] memory
	) external view whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		revert("ClearingHouseFacet: Use explicit settlement");
	}

	/// @notice Applies explicit signed Clearing House settlement values for both debits and credits.
	/// @dev Values are from each account's perspective. Contributions sharing an account/allocation key are netted
	///      once per economic class, producing typed funding, PnL, or platform-fee
	///      balance-change events while their per-market values remain observable in ClearingHouseSettlementComponent.
	function applyClearingHouseSettlement(
		address subject,
		ClearingHouseSettlement[] memory settlements
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		_validateClearingHouseSettlements(settlements);
		_applyClearingHouseSettlement(subject, settlements);
	}

	/// @dev One O(n) pass emits every component and nets each account/allocation group once per economic
	///      class. Positive class totals are credited before negative totals are debited, then the final
	///      pool check proves conservation. Any failure reverts both mutations and the emitted logs.
	function _applyClearingHouseSettlement(address subject, ClearingHouseSettlement[] memory settlements) private {
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();
		bool isCross = chLayout.crossLiquidationDetails[subject].inProgress;
		require(isCross || chLayout.partyATakeoverDetails[subject].inProgress, "ClearingHouseFacet: No active liquidation");

		uint256 totalDebits;
		uint256 totalCredits;
		int256 accountRealizedPnl;
		int256 accountFunding;
		int256 accountPlatformFee;
		for (uint256 i = 0; i < settlements.length; i++) {
			ClearingHouseSettlement memory settlement = settlements[i];
			accountRealizedPnl += settlement.realizedPnl;
			accountFunding += settlement.funding;
			accountPlatformFee += settlement.platformFee;
			emit ClearingHouseSettlementComponent(
				subject,
				settlement.account,
				settlement.symbolId,
				settlement.allocationKey,
				settlement.realizedPnl,
				settlement.funding,
				settlement.platformFee
			);
			if (_isLastAccountSettlement(settlements, i, settlement)) {
				(uint256 accountDebits, uint256 accountCredits) = _applyAccountSettlement(
					isCross,
					subject,
					settlement.account,
					settlement.allocationKey,
					accountRealizedPnl,
					accountFunding,
					accountPlatformFee
				);
				totalDebits += accountDebits;
				totalCredits += accountCredits;
				emit ClearingHouseAccountSettlement(
					subject,
					settlement.account,
					settlement.allocationKey,
					accountRealizedPnl + accountFunding + accountPlatformFee
				);
				accountRealizedPnl = 0;
				accountFunding = 0;
				accountPlatformFee = 0;
			}
		}

		if (isCross) {
			CrossLiquidationDetail storage detail = chLayout.crossLiquidationDetails[subject];
			detail.deallocatedPool += totalDebits;
			require(detail.deallocatedPool >= totalCredits, "ClearingHouseFacet: Insufficient pool balance");
			detail.deallocatedPool -= totalCredits;
		} else {
			PartyATakeoverDetail storage detail = chLayout.partyATakeoverDetails[subject];
			detail.deallocatedPool += totalDebits;
			require(detail.deallocatedPool >= totalCredits, "ClearingHouseFacet: Insufficient pool balance");
			detail.deallocatedPool -= totalCredits;
		}
	}

	/// @dev Applies one account/allocation group's net funding, PnL, and fees independently so
	///      the emitted balance-change reasons match the declared components. Credits precede debits
	///      so one positive class can fund another class's negative movement without transient underflow.
	function _applyAccountSettlement(
		bool isCross,
		address subject,
		address account,
		address allocationKey,
		int256 realizedPnl,
		int256 funding,
		int256 platformFee
	) private returns (uint256 debits, uint256 credits) {
		if (realizedPnl > 0) {
			uint256 amount = uint256(realizedPnl);
			_creditClearingHouseAccount(
				account,
				allocationKey,
				amount,
				SharedEvents.BalanceChangeType.REALIZED_PNL_IN,
				SharedEvents.ReimbursementChangeType.REALIZED_PNL_IN
			);
			credits += amount;
		}
		if (funding > 0) {
			uint256 amount = uint256(funding);
			_creditClearingHouseAccount(
				account,
				allocationKey,
				amount,
				SharedEvents.BalanceChangeType.FUNDING_FEE_IN,
				SharedEvents.ReimbursementChangeType.FUNDING_FEE_IN
			);
			credits += amount;
		}
		if (platformFee > 0) {
			uint256 amount = uint256(platformFee);
			_creditClearingHouseAccount(
				account,
				allocationKey,
				amount,
				SharedEvents.BalanceChangeType.PLATFORM_FEE_IN,
				SharedEvents.ReimbursementChangeType.PLATFORM_FEE_IN
			);
			credits += amount;
		}
		if (realizedPnl < 0) {
			uint256 amount = SignedMath.abs(realizedPnl);
			_debitClearingHouseAccount(
				isCross,
				subject,
				account,
				allocationKey,
				amount,
				SharedEvents.BalanceChangeType.REALIZED_PNL_OUT,
				SharedEvents.ReimbursementChangeType.REALIZED_PNL_OUT
			);
			debits += amount;
		}
		if (funding < 0) {
			uint256 amount = SignedMath.abs(funding);
			_debitClearingHouseAccount(
				isCross,
				subject,
				account,
				allocationKey,
				amount,
				SharedEvents.BalanceChangeType.FUNDING_FEE_OUT,
				SharedEvents.ReimbursementChangeType.FUNDING_FEE_OUT
			);
			debits += amount;
		}
		if (platformFee < 0) {
			uint256 amount = SignedMath.abs(platformFee);
			_debitClearingHouseAccount(
				isCross,
				subject,
				account,
				allocationKey,
				amount,
				SharedEvents.BalanceChangeType.PLATFORM_FEE_OUT,
				SharedEvents.ReimbursementChangeType.PLATFORM_FEE_OUT
			);
			debits += amount;
		}
	}

	function _debitClearingHouseAccount(
		bool isCross,
		address subject,
		address account,
		address allocationKey,
		uint256 amount,
		SharedEvents.BalanceChangeType balanceChangeType,
		SharedEvents.ReimbursementChangeType reimbursementChangeType
	) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		bool isPartyA = isCross ? account != subject : account == subject;

		if (isPartyA) {
			if (allocationKey == address(0)) {
				require(accountLayout.allocatedBalances[account] >= amount, "ClearingHouseFacet: Insufficient allocated balance");
				LibAccount.decreasePartyAAllocatedBalance(account, amount, balanceChangeType);
			} else if (!isCross && allocationKey == REIMBURSEMENT_KEY) {
				require(accountLayout.partyAReimbursement[account] >= amount, "ClearingHouseFacet: Insufficient reimbursement");
				LibAccount.decreasePartyAReimbursement(account, amount, reimbursementChangeType);
			} else {
				revert("ClearingHouseFacet: Invalid allocation key for partyA");
			}
		} else {
			require(accountLayout.partyBAllocatedBalances[account][allocationKey] >= amount, "ClearingHouseFacet: Insufficient allocated balance");
			LibAccount.decreasePartyBAllocatedBalance(account, allocationKey, amount, balanceChangeType);
		}
	}

	function _creditClearingHouseAccount(
		address account,
		address allocationKey,
		uint256 amount,
		SharedEvents.BalanceChangeType balanceChangeType,
		SharedEvents.ReimbursementChangeType reimbursementChangeType
	) private {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		if (maLayout.partyBStatus[account]) {
			LibAccount.increasePartyBAllocatedBalance(account, allocationKey, amount, balanceChangeType);
		} else if (maLayout.liquidationStatus[account]) {
			require(allocationKey == address(0), "ClearingHouseFacet: Invalid allocation key for partyA");
			LibAccount.increasePartyAReimbursement(account, amount, reimbursementChangeType);
		} else {
			require(allocationKey == address(0), "ClearingHouseFacet: Invalid allocation key for partyA");
			LibAccount.increasePartyAAllocatedBalance(account, amount, balanceChangeType);
		}
	}

	function _isLastAccountSettlement(
		ClearingHouseSettlement[] memory settlements,
		uint256 index,
		ClearingHouseSettlement memory settlement
	) private pure returns (bool) {
		return
			index + 1 == settlements.length ||
			settlements[index + 1].account != settlement.account ||
			settlements[index + 1].allocationKey != settlement.allocationKey;
	}

	function _isSettlementOrderedAfter(ClearingHouseSettlement memory previous, ClearingHouseSettlement memory current) private pure returns (bool) {
		if (previous.account != current.account) return uint160(previous.account) < uint160(current.account);
		if (previous.allocationKey != current.allocationKey) return uint160(previous.allocationKey) < uint160(current.allocationKey);
		return previous.symbolId < current.symbolId;
	}

	function _validateClearingHouseSettlements(ClearingHouseSettlement[] memory settlements) private view {
		require(settlements.length > 0, "ClearingHouseFacet: Empty settlement");

		uint256 lastSymbolId = SymbolStorage.layout().lastId;
		for (uint256 i = 0; i < settlements.length; i++) {
			ClearingHouseSettlement memory settlement = settlements[i];
			require(settlement.account != address(0), "ClearingHouseFacet: Zero account");
			require(settlement.realizedPnl != 0 || settlement.funding != 0 || settlement.platformFee != 0, "ClearingHouseFacet: Empty component");
			if (settlement.symbolId == 0) {
				require(settlement.realizedPnl == 0 && settlement.funding == 0, "ClearingHouseFacet: Missing market");
			} else {
				require(settlement.symbolId <= lastSymbolId, "ClearingHouseFacet: Invalid symbol");
			}
			if (i > 0) {
				ClearingHouseSettlement memory previous = settlements[i - 1];
				require(
					previous.account != settlement.account ||
						previous.allocationKey != settlement.allocationKey ||
						previous.symbolId != settlement.symbolId,
					"ClearingHouseFacet: Duplicate market"
				);
				require(_isSettlementOrderedAfter(previous, settlement), "ClearingHouseFacet: Unsorted settlement");
			}
		}
	}

	/// @notice Liquidates pending positions during clearing house liquidation.
	/// @dev Works for both cross PartyB liquidation and PartyA takeover.
	///      For cross PartyB: counterparties are the partyAs to process.
	///      For PartyA takeover: counterparties are ignored (processes all pending).
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover).
	/// @param counterparties The counterparties to process (only used for cross PartyB).
	function liquidatePendingPositionsForClearingHouse(
		address subject,
		address[] memory counterparties
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		uint256[] memory liquidatedAmounts = ClearingHouseFacetImpl.liquidatePendingPositionsForClearingHouse(subject, counterparties);
		emit LiquidatePendingPositionsForClearingHouse(subject, counterparties, liquidatedAmounts);
	}

	/// @notice Liquidates open positions during clearing house liquidation.
	/// @dev Works for both cross PartyB liquidation and PartyA takeover.
	///      Prices are provided directly without Muon signature verification.
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover).
	/// @param quoteIds The quote IDs to liquidate.
	/// @param prices The prices to use for liquidation.
	/// @param closeSolverFees User-approved close solver fees supplied by the Clearing House for each quote.
	function liquidatePositionsForClearingHouse(
		address subject,
		uint256[] memory quoteIds,
		uint256[] memory prices,
		uint256[] memory closeSolverFees
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		(uint256[] memory liquidatedAmounts, uint256[] memory closeIds) = ClearingHouseFacetImpl.liquidatePositionsForClearingHouse(
			subject,
			quoteIds,
			prices,
			closeSolverFees
		);
		emit LiquidatePositionsForClearingHouse(subject, quoteIds, liquidatedAmounts, closeIds, prices);
	}

	/// @notice Closes open positions for an affiliate that is being wound down.
	/// @dev The affiliate must have a shutdown timestamp scheduled and reached.
	///      This uses the normal close accounting path, not liquidation escrow accounting.
	///      CLEARING_HOUSE_ROLE is trusted to provide the shutdown settlement prices.
	/// @param affiliate The affiliate/frontend whose positions are being closed.
	/// @param quoteIds The affiliate quote IDs to close fully.
	/// @param prices The close prices for each quote.
	function closeAffiliatePositions(
		address affiliate,
		uint256[] memory quoteIds,
		uint256[] memory prices
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		uint256[] memory closedAmounts = ClearingHouseFacetImpl.closeAffiliatePositions(affiliate, quoteIds, prices);
		emit CloseAffiliatePositions(affiliate, quoteIds, closedAmounts, prices);
	}

	/// @notice Settles the clearing house liquidation for PartyA takeover.
	/// @dev Only applicable to PartyA takeover flow. Clears all liquidation state.
	/// @param partyA The address of Party A.
	/// @param settledPartyBs PartyBs whose settlement states need cleanup
	///        (includes partyBs processed by normal flow before takeover).
	function settlePartyATakeover(
		address partyA,
		address[] memory settledPartyBs
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		bytes memory liquidationId = ClearingHouseFacetImpl.settlePartyATakeover(partyA, settledPartyBs);
		LibHook.callLiquidationSettledHooks(partyA);
		emit SettlePartyATakeover(partyA, liquidationId);
	}

	/// @notice Settles the clearing house liquidation for a cross PartyB.
	/// @dev Only applicable to cross PartyB liquidation flow.
	///      Supports pagination: call with finalize=false to fire hooks for batches of settled partyAs,
	///      then call with finalize=true on the last batch to complete the settlement.
	/// @param partyB The address of Party B.
	/// @param settledPartyAs The partyAs whose liquidation hooks should be called in this batch.
	/// @param finalize Whether to finalize the settlement (checks all positions closed and funds distributed).
	function settleCrossPartyBLiquidation(
		address partyB,
		address[] memory settledPartyAs,
		bool finalize
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		ClearingHouseFacetImpl.settleCrossPartyBLiquidation(partyB, settledPartyAs, finalize);
		if (finalize) {
			emit SettleCrossPartyBLiquidation(partyB);
		}
	}

	/// @notice Distributes pending fees from the liquidation escrow created during LATE/OVERDUE PartyA liquidation settlement.
	/// @dev Supports both partyA-style addresses (allocatedBalances) and partyBs (partyBAllocatedBalances).
	/// @param partyA The partyA whose liquidation escrow to distribute from.
	/// @param receivers The addresses to distribute to.
	/// @param allocationKeys The allocation keys for each receiver (used for partyB receivers).
	/// @param amounts The amounts to distribute.
	function distributeFromLiquidationEscrow(
		address partyA,
		address[] memory receivers,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) external onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		ClearingHouseFacetImpl.distributeFromLiquidationEscrow(partyA, receivers, allocationKeys, amounts);
		emit DistributeFromLiquidationEscrow(partyA, receivers, allocationKeys, amounts);
	}

	/// @notice Applies a soft liquidation penalty to a Party B by deducting from their allocated and/or deposit balances.
	/// @param partyB The address of Party B being penalized.
	/// @param partyA The address of Party A associated with the penalty.
	/// @param penaltyFromAllocated The penalty amount to deduct from partyB's allocated balance.
	/// @param penaltyFromBalance The penalty amount to deduct from partyB's available balance.
	function softPartyBLiquidation(
		address partyB,
		address partyA,
		uint256 penaltyFromAllocated,
		uint256 penaltyFromBalance
	) external onlyRole(LibAccessibility.SOFT_LIQUIDATOR_ROLE) {
		ClearingHouseFacetImpl.softPartyBLiquidation(partyB, partyA, penaltyFromAllocated, penaltyFromBalance);
		emit SoftPartyBLiquidation(partyB, partyA, penaltyFromAllocated, penaltyFromBalance);
	}
}
