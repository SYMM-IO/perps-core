// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../libraries/muon/LibMuonForceActions.sol";
import "../../libraries/muon/LibMuonSettlement.sol";
import "../../libraries/muon/LibMuonCrossSettlement.sol";
import "../../libraries/LibSettlement.sol";
import "../../libraries/LibLiquidation.sol";
import "../../libraries/LibForceSolve.sol";
import "../../libraries/LibSolvency.sol";
import "../../libraries/LibAccount.sol";
import "../../storages/QuoteStorage.sol";
import "../../storages/AccountStorage.sol";

import "../Settlement/SettlementFacetEvents.sol";

// Import the interface solely for custom error declarations. Having the errors
// in a central interface allows multiple facets and libraries to share them
// without coupling to the full implementation. See IForceActionsFacet.sol for
// the error definitions.
import "./IForceActionsFacet.sol";

library ForceActionsFacetImpl {
	using LockedValuesOps for LockedValues;

	function forceCancelQuote(uint256 quoteId) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		// Enforce that the quote is in the expected cancel pending state. Revert with
		// a custom error if not.
		if (quote.quoteStatus != QuoteStatus.CANCEL_PENDING) {
			revert ForceCloseErrors.InvalidState();
		}
		// Enforce that the force cancel cooldown has elapsed. If the current
		// timestamp has not yet surpassed the last modify timestamp plus the
		// cooldown period, revert.
		if (!(block.timestamp > quote.statusModifyTimestamp + maLayout.forceCancelCooldown)) {
			revert ForceCloseErrors.CooldownNotReached();
		}
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.CANCELED;
		accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
		accountLayout.partyBPendingLockedBalances[quote.partyB][LibAccount.partyBAllocationBucket(quote.partyB, quote.partyA)].subQuote(quote);

		// send trading Fee back to partyA
		uint256 fee = LibQuote.getOpenTradingFee(quote.id);
		accountLayout.allocatedBalances[quote.partyA] += fee;
		emit SharedEvents.BalanceChangePartyA(quote.partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);

		LibQuote.removeFromPendingQuotes(quote);
	}

	function forceCancelCloseRequest(uint256 quoteId) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		// Validate the quote is in the cancel close pending state.
		if (quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING) {
			revert ForceCloseErrors.InvalidState();
		}
		// Ensure the cancel close cooldown period has expired before proceeding.
		if (!(block.timestamp > quote.statusModifyTimestamp + maLayout.forceCancelCloseCooldown)) {
			revert ForceCloseErrors.CooldownNotReached();
		}

		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.OPENED;
		quote.requestedClosePrice = 0;
		quote.quantityToClose = 0;
	}

	// function forceClosePosition(
	// 	uint256 quoteId,
	// 	HighLowPriceSig memory sig,
	// 	SettlementSig memory settlementSig,
	// 	uint256[] memory updatedPrices
	// ) internal returns (uint256 closePrice, bool isPartyBLiquidated, int256 upnlPartyB, uint256 partyBAllocatedBalance) {
	// 	MAStorage.Layout storage maLayout = MAStorage.layout();
	// 	AccountStorage.Layout storage accountLayout = AccountStorage.layout();
	// 	SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
	// 	Quote storage quote = QuoteStorage.layout().quotes[quoteId];
	// 	// Ensure the quote is in a close pending state.
	// 	if (quote.quoteStatus != QuoteStatus.CLOSE_PENDING) {
	// 		revert ForceCloseErrors.InvalidState();
	// 	}
	// 	// The close request must not be expired relative to the deadline.
	// 	if (!(sig.endTime + maLayout.forceCloseSecondCooldown <= quote.deadline)) {
	// 		revert ForceCloseErrors.CloseRequestExpired();
	// 	}
	// 	// Only limit orders may be force closed.
	// 	if (quote.orderType != OrderType.LIMIT) {
	// 		revert ForceCloseErrors.InvalidOrderType();
	// 	}
	// 	// Enforce first stage cooldown before starting force close.
	// 	if (!(sig.startTime >= quote.statusModifyTimestamp + maLayout.forceCloseFirstCooldown)) {
	// 		revert ForceCloseErrors.CooldownNotReached();
	// 	}
	// 	// Enforce second stage cooldown before finalizing force close.
	// 	if (!(sig.endTime <= block.timestamp - maLayout.forceCloseSecondCooldown)) {
	// 		revert ForceCloseErrors.CooldownNotReached();
	// 	}
	// 	// The average price must lie within the high/low bounds.
	// 	if (!(sig.averagePrice <= sig.highest && sig.averagePrice >= sig.lowest)) {
	// 		revert ForceCloseErrors.InvalidAveragePrice();
	// 	}
	// 	if (quote.positionType == PositionType.LONG) {
	// 		// For long positions the highest observed price must exceed the requested close
	// 		// price by at least the configured gap ratio. Otherwise the requested close
	// 		// price has not been reached and we revert.
	// 		if (!(sig.highest >= quote.requestedClosePrice + (quote.requestedClosePrice * symbolLayout.forceCloseGapRatio[quote.symbolId]) / 1e18)) {
	// 			revert ForceCloseErrors.RequestedClosePriceNotReached();
	// 		}
	// 		closePrice = quote.requestedClosePrice + (quote.requestedClosePrice * maLayout.forceClosePricePenalty) / 1e18;
	// 		closePrice = closePrice > sig.averagePrice ? closePrice : sig.averagePrice; // max
	// 	} else {
	// 		// For short positions the lowest observed price must fall below the requested close
	// 		// price by at least the configured gap ratio. Otherwise we revert.
	// 		if (!(sig.lowest <= quote.requestedClosePrice - (quote.requestedClosePrice * symbolLayout.forceCloseGapRatio[quote.symbolId]) / 1e18)) {
	// 			revert ForceCloseErrors.RequestedClosePriceNotReached();
	// 		}
	// 		closePrice = quote.requestedClosePrice - (quote.requestedClosePrice * maLayout.forceClosePricePenalty) / 1e18;
	// 		closePrice = closePrice > sig.averagePrice ? sig.averagePrice : closePrice; // min
	// 	}

	// 	// If the computed close price equals the signature's average price then the
	// 	// signature period must meet the minimum length requirement. Without this
	// 	// check the force close could be based on too narrow of a price window.
	// 	if (closePrice == sig.averagePrice) {
	// 		if (!(sig.endTime - sig.startTime >= maLayout.forceCloseMinSigPeriod)) {
	// 			revert ForceCloseErrors.InvalidSignaturePeriod();
	// 		}
	// 	}

	// 	LibMuonForceActions.verifyHighLowPrice(sig, quote.partyB, quote.partyA, quote.symbolId);
	// 	if (updatedPrices.length > 0) {
	// 		LibMuonSettlement.verifySettlement(settlementSig, quote.partyA);
	// 	}
	// 	accountLayout.partyANonces[quote.partyA] += 1;
	// 	accountLayout.partyBNonces[quote.partyB][quote.partyA] += 1;

	// 	uint256 reservedBalance;
	// 	if (accountLayout.masterAccountMode[quote.partyB]) {
	// 		reservedBalance = accountLayout.partyBAllocatedBalances[quote.partyB][address(0)];
	// 	} else {
	// 		reservedBalance = accountLayout.reserveVault[quote.partyB];
	// 	}

	// 	uint256[] memory quoteIds = new uint256[](1);
	// 	uint256[] memory filledAmounts = new uint256[](1);
	// 	uint256[] memory closedPrices = new uint256[](1);
	// 	uint256[] memory marketPrices = new uint256[](1);
	// 	quoteIds[0] = quoteId;
	// 	filledAmounts[0] = quote.quantityToClose;
	// 	closedPrices[0] = closePrice;
	// 	marketPrices[0] = sig.currentPrice;
	// 	(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = LibSolvency.getAvailableBalanceAfterClosePosition(
	// 		quoteIds,
	// 		filledAmounts,
	// 		closedPrices,
	// 		marketPrices,
	// 		sig.upnlPartyB,
	// 		sig.upnlPartyA,
	// 		quote.partyB,
	// 		quote.partyA
	// 	);
	// 	// After computing the available balances ensure partyA will not become insolvent.
	// 	if (!(partyAAvailableBalance >= 0)) {
	// 		revert ForceCloseErrors.PartyAWillBeInsolvent();
	// 	}
	// 	if (partyBAvailableBalance >= 0) {
	// 		if (updatedPrices.length > 0) {
	// 			LibSettlement.settleUpnl(settlementSig, updatedPrices, msg.sender, true);
	// 		}
	// 		LibQuote.closeQuote(quote, quote.quantityToClose, closePrice);
	// 	} else if (partyBAvailableBalance + int256(reservedBalance) >= 0) {
	// 		uint256 available = uint256(-partyBAvailableBalance);
	// 		if (accountLayout.masterAccountMode[quote.partyB]) {
	// 			accountLayout.partyBAllocatedBalances[quote.partyB][address(0)] -= available;
	// 		} else {
	// 			accountLayout.reserveVault[quote.partyB] -= available;
	// 		}

	// 		accountLayout.partyBAllocatedBalances[quote.partyB][quote.partyA] += available;
	// 		emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, available, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
	// 		LibQuote.closeQuote(quote, quote.quantityToClose, closePrice);
	// 	} else {
	// 		if (accountLayout.masterAccountMode[quote.partyB]) {
	// 			accountLayout.partyBAllocatedBalances[quote.partyB][address(0)] = 0;
	// 		} else {
	// 			accountLayout.reserveVault[quote.partyB] = 0;
	// 		}
	// 		accountLayout.partyBAllocatedBalances[quote.partyB][quote.partyA] += reservedBalance;
	// 		emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, reservedBalance, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
	// 		int256 diff = (int256(quote.quantityToClose) * (int256(closePrice) - int256(sig.currentPrice))) / 1e18;
	// 		if (quote.positionType == PositionType.LONG) {
	// 			diff = diff * -1;
	// 		}
	// 		isPartyBLiquidated = true;
	// 		upnlPartyB = sig.upnlPartyB + diff;
	// 		LibLiquidation.liquidatePartyB(quote.partyB, quote.partyA, upnlPartyB, block.timestamp);
	// 	}
	// 	partyBAllocatedBalance = accountLayout.partyBAllocatedBalances[quote.partyB][quote.partyA];
	// }

	function getClosePrice(uint256 quoteId, HighLowPriceSig memory highLowPrice) internal view returns (uint256 closePrice) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		closePrice = LibForceSolve.GetClosePrice(
			quote.positionType,
			quote.requestedClosePrice,
			SymbolStorage.layout().forceCloseGapRatio[quote.symbolId],
			highLowPrice.lowest,
			highLowPrice.highest,
			highLowPrice.averagePrice,
			highLowPrice.startTime,
			highLowPrice.endTime,
			maLayout.forceClosePricePenalty,
			maLayout.forceCloseMinSigPeriod
		);
	}

	function forceCloseInit(uint256 quoteId, HighLowPriceSig memory highLowPrice) internal returns (uint256 closePrice) {
		LibForceSolve.verifyPrice(quoteId, highLowPrice);
		closePrice = getClosePrice(quoteId, highLowPrice);

		(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = LibForceSolve.getAvailableBalancesAfterClose(
			quoteId,
			highLowPrice.currentPrice,
			highLowPrice.upnlPartyA,
			highLowPrice.upnlPartyB,
			closePrice
		);

		if (!(partyAAvailableBalance >= 0)) revert ForceCloseErrors.PartyAWillBeInsolvent();

		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.partyBAvailableAfterClose = partyBAvailableBalance;
		detail.closePrice = closePrice;
		detail.inProgress = true;
	}

	function forceCloseFinalization(
		uint256 quoteId,
		uint256 closePrice,
		int256 partyBAvailableBalance,
		uint256 reservedBalance,
		int256 upnlPartyB,
		uint256 currentPrice,
		bool isMasterAccount
	) internal returns (bool isSolvent, bool isPartyBLiquidated, int256 _upnlPartyB) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		isSolvent = LibForceSolve.solveUsingAllocatedBalances(quoteId, closePrice, partyBAvailableBalance, reservedBalance, isMasterAccount);

		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.inProgress = false;

		if (isSolvent) {
			detail.partyBState = PartyBForceCloseState.SOLVED;
		} else {
			if (!isMasterAccount) {
				_upnlPartyB = LibForceSolve.liquidatePartyB(quoteId, closePrice, reservedBalance, upnlPartyB, currentPrice);
				isPartyBLiquidated = true;
				detail.partyBState = PartyBForceCloseState.LIQUIDATED;
			}
		}
	}

	function forceCloseMaster(uint256 quoteId) internal returns (bool isSolvent) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];
		(isSolvent, , ) = forceCloseFinalization(
			quoteId,
			detail.closePrice,
			detail.partyBAvailableAfterClose,
			accountLayout.partyBAllocatedBalances[QuoteStorage.layout().quotes[quoteId].partyB][address(0)],
			0,
			0,
			true
		);
	}

	function forceClose(
		uint256 quoteId,
		HighLowPriceSig memory highLowPrice
	) internal returns (uint256 closePrice, int256 upnlPartyB, bool isPartyBLiquidated) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		address partyB = quote.partyB;

		if (accountLayout.masterAccountMode[partyB]) revert ForceCloseErrors.MasterAccountModeNotEnabled();

		LibForceSolve.verifyPrice(quoteId, highLowPrice);
		closePrice = getClosePrice(quoteId, highLowPrice);

		(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = LibForceSolve.getAvailableBalancesAfterClose(
			quoteId,
			highLowPrice.currentPrice,
			highLowPrice.upnlPartyA,
			highLowPrice.upnlPartyB,
			closePrice
		);

		if (!(partyAAvailableBalance >= 0)) {
			revert ForceCloseErrors.PartyAWillBeInsolvent();
		}

		uint256 reservedBalance = accountLayout.reserveVault[partyB];
		(, isPartyBLiquidated, upnlPartyB) = forceCloseFinalization(
			quoteId,
			closePrice,
			partyBAvailableBalance,
			reservedBalance,
			highLowPrice.upnlPartyB,
			highLowPrice.currentPrice,
			false
		);
	}

	function realizeUPNL(uint256 quoteId, SettlementSig memory settlementSig, uint256[] memory updatedPrices) internal {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		uint256[] memory newPartyBsAllocatedBalances = new uint256[](1);
		address partyA = quote.partyA;

		LibMuonSettlement.verifySettlement(settlementSig, partyA);
		newPartyBsAllocatedBalances = LibSettlement.settleUpnl(settlementSig, updatedPrices, partyA, true);
		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.settlementState = UPNLSettlementState.REALIZED;
	}

	function realizeUPNLMasterAccount(
		uint256 forceCloseId,
		CrossSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyAsAllocatedBalances, address[] memory partyAs) {
		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[forceCloseId];

		if (!detail.inProgress) revert ForceCloseErrors.InvalidState();

		LibMuonCrossSettlement.verifyCrossSettlement(settlementSig);
		(newPartyAsAllocatedBalances, partyAs) = LibSettlement.crossSettleUpnl(settlementSig, updatedPrices, true);
		detail.settlementState = UPNLSettlementState.REALIZED_MASTER_ACCOUNT;
		detail.timestamp = block.timestamp;
	}

	function fetchAllocatedMasterAccount(uint256 forceCloseId, address partyB, address[] memory partyAs, uint256[] memory fetchAmounts) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[forceCloseId];

		if (!(accountLayout.masterAccountMode[partyB])) revert ForceCloseErrors.MasterAccountModeInactive();
		if (!detail.inProgress) revert ForceCloseErrors.InvalidState();

		LibSettlement.settleAllocated(partyB, partyAs, fetchAmounts);

		detail.allocatedSettlementState = AllocatedSettlementState.GATHER_ALLOCATED_MASTER_ACCOUNT;
		detail.timestamp = block.timestamp;
	}
}
