// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, LockedValues, PositionType, OrderType, QuoteStatus, SolverFeeState } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { AffiliateStorage } from "../storages/AffiliateStorage.sol";
import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibQuote } from "./LibQuote.sol";
import { LibQuoteClose } from "./LibQuoteClose.sol";
import { LibQuoteFunding } from "./LibQuoteFunding.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibSolvency } from "./LibSolvency.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibHook } from "./LibHook.sol";
import { LibSymbolAdjustment } from "./LibSymbolAdjustment.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";

library LibPartyBPositionsActions {
	using LockedValuesOps for LockedValues;

	/// @notice Validates and fills a close request by checking state, expiry, price, and amount constraints.
	function fillCloseRequest(uint256 quoteId, uint256 filledAmount, uint256 closedPrice) internal {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		LibSymbolAdjustment.requireNotFrozen(quote.symbolId);
		require(
			quote.quoteStatus == QuoteStatus.CLOSE_PENDING || quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"PartyBFacet: Invalid state"
		);
		require(block.timestamp <= quote.deadline, "PartyBFacet: Quote is expired");
		if (quote.positionType == PositionType.LONG) {
			require(closedPrice >= quote.requestedClosePrice, "PartyBFacet: Closed price isn't valid");
		} else {
			require(closedPrice <= quote.requestedClosePrice, "PartyBFacet: Closed price isn't valid");
		}
		if (quote.orderType == OrderType.LIMIT) {
			require(quote.quantityToClose >= filledAmount, "PartyBFacet: Invalid filledAmount");
		} else {
			require(quote.quantityToClose == filledAmount, "PartyBFacet: Invalid filledAmount");
		}
		LibQuoteClose.closeQuote(quote.id, filledAmount, closedPrice);
	}

	/// @notice Opens a position by filling a locked quote, handling partial fills and fee collection.
	function openPosition(uint256 quoteId, uint256 filledAmount, uint256 openedPrice) internal returns (uint256 currentId) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		require(SymbolStorage.layout().symbols[quote.symbolId].isValid, "PartyBFacet: Symbol is not valid");
		LibSymbolAdjustment.requireNotFrozen(quote.symbolId);
		require(quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING, "PartyBFacet: Invalid state");
		require(block.timestamp <= quote.deadline, "PartyBFacet: Quote is expired");

		bool _instantOpenMode = GlobalAppStorage.layout().instantOpenMode;
		if (_instantOpenMode) {
			require(quote.quantity == filledAmount, "PartyBFacet: InstantOpen requires full fill");
		}

		uint256 quoteFeeBeforeOpen = LibQuote.getOpenTradingFee(quote.id);
		uint256 remainingQuoteFee = 0;

		address feeCollector = LibAccount.getFeeCollector(quote.affiliate);
		if (quote.orderType == OrderType.LIMIT) {
			require(quote.quantity >= filledAmount && filledAmount > 0, "PartyBFacet: Invalid filledAmount");
			accountLayout.balances[feeCollector] += (filledAmount * quote.requestedOpenPrice * quote.tradingFee) / 1e36;
		} else {
			require(quote.quantity == filledAmount, "PartyBFacet: Invalid filledAmount");
			accountLayout.balances[feeCollector] += (filledAmount * quote.marketPrice * quote.tradingFee) / 1e36;
		}
		if (quote.positionType == PositionType.LONG) {
			require(openedPrice <= quote.requestedOpenPrice, "PartyBFacet: Opened price isn't valid");
		} else {
			require(openedPrice >= quote.requestedOpenPrice, "PartyBFacet: Opened price isn't valid");
		}

		quote.openedPrice = openedPrice;
		quote.initialOpenedPrice = openedPrice;
		quote.statusModifyTimestamp = block.timestamp;

		LibQuoteFunding.updateAccumulatedPaidFunding(quoteId);
		if (!_instantOpenMode) {
			LibQuote.removeFromPendingQuotes(quote);
		}
		quote.lastFundingPaymentTimestamp = block.timestamp;

		if (quote.quantity == filledAmount) {
			if (!_instantOpenMode) {
				accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
				LibAccount.subFromPartyBPendingLockedBalances(quote);
			}
			quote.lockedValues.mul(openedPrice).div(quote.requestedOpenPrice);

			// check locked values
			require(
				quote.lockedValues.totalForPartyA() >= SymbolStorage.layout().symbols[quote.symbolId].minAcceptableQuoteValue,
				"PartyBFacet: Quote value is low"
			);
		}
		// partially fill
		else {
			currentId = ++quoteLayout.lastId;
			QuoteStatus newStatus;
			if (quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
				newStatus = QuoteStatus.CANCELED;
			} else {
				newStatus = QuoteStatus.PENDING;
				quoteLayout.partyAPendingQuotes[quote.partyA].push(currentId);
			}
			LockedValues memory filledLockedValues = LockedValues(
				(quote.lockedValues.cva * filledAmount) / quote.quantity,
				(quote.lockedValues.lf * filledAmount) / quote.quantity,
				(quote.lockedValues.partyAmm * filledAmount) / quote.quantity,
				(quote.lockedValues.partyBmm * filledAmount) / quote.quantity
			);
			LockedValues memory appliedFilledLockedValues = filledLockedValues;
			appliedFilledLockedValues = appliedFilledLockedValues.mulMem(openedPrice);
			appliedFilledLockedValues = appliedFilledLockedValues.divMem(quote.requestedOpenPrice);
			// check that opened position is not minor position
			require(
				appliedFilledLockedValues.totalForPartyA() >= SymbolStorage.layout().symbols[quote.symbolId].minAcceptableQuoteValue,
				"PartyBFacet: Quote value is low"
			);
			// check that new pending position is not minor position
			require(
				newStatus == QuoteStatus.CANCELED ||
					(quote.lockedValues.totalForPartyA() - filledLockedValues.totalForPartyA()) >=
						SymbolStorage.layout().symbols[quote.symbolId].minAcceptableQuoteValue,
				"PartyBFacet: Quote value is low"
			);

			Quote memory q = Quote({
				id: currentId,
				partyBsWhiteList: quote.partyBsWhiteList,
				symbolId: quote.symbolId,
				positionType: quote.positionType,
				orderType: quote.orderType,
				openedPrice: 0,
				initialOpenedPrice: 0,
				requestedOpenPrice: quote.requestedOpenPrice,
				marketPrice: quote.marketPrice,
				quantity: quote.quantity - filledAmount,
				closedAmount: 0,
				lockedValues: LockedValues(0, 0, 0, 0),
				initialLockedValues: LockedValues(0, 0, 0, 0),
				maxFundingRate: quote.maxFundingRate,
				partyA: quote.partyA,
				partyB: address(0),
				quoteStatus: newStatus,
				avgClosedPrice: 0,
				requestedClosePrice: 0,
				parentId: quote.id,
				createTimestamp: quote.createTimestamp,
				statusModifyTimestamp: block.timestamp,
				quantityToClose: 0,
				lastFundingPaymentTimestamp: 0,
				deadline: quote.deadline,
				tradingFee: quote.tradingFee,
				affiliate: quote.affiliate,
				accumulatedPaidFunding: 0,
				closeFee: quote.closeFee,
				data: quote.data
			});

			quoteLayout.quoteIdsOf[quote.partyA].push(currentId);
			quoteLayout.quotes[currentId] = q;
			_splitSolverFeeState(quoteLayout, quote.id, currentId);
			Quote storage newQuote = quoteLayout.quotes[currentId];
			remainingQuoteFee = LibQuote.getOpenTradingFee(newQuote.id);

			if (newStatus == QuoteStatus.CANCELED) {
				// send trading Fee back to partyA
				LibAccount.refundOpenTradingFee(newQuote.id, newQuote.partyA);

				// part of quote has been filled and part of it has been canceled
				accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
			} else {
				accountLayout.pendingLockedBalances[quote.partyA].sub(filledLockedValues);
			}
			// update partyB pending locked balances
			LibAccount.subFromPartyBPendingLockedBalances(quote);

			newQuote.lockedValues = quote.lockedValues.sub(filledLockedValues);
			newQuote.initialLockedValues = newQuote.lockedValues;
			quote.quantity = filledAmount;
			quote.lockedValues = appliedFilledLockedValues;
		}
		// lock with amount of filledAmount
		accountLayout.lockedBalances[quote.partyA].addQuote(quote);
		LibAccount.addToPartyBLockedBalances(quote);

		// check leverage (is in 18 decimals)
		require(
			(quote.quantity * quote.openedPrice) / quote.lockedValues.totalForPartyA() <= SymbolStorage.layout().symbols[quote.symbolId].maxLeverage,
			"PartyBFacet: Leverage is high"
		);

		quoteLayout.partyBPositionsCount[quote.partyB][address(0)] += 1;
		quote.quoteStatus = QuoteStatus.OPENED;
		LibQuote.addToOpenPositions(quoteId);

		uint256 openFee = quote.orderType == OrderType.LIMIT
			? (filledAmount * quote.requestedOpenPrice * quote.tradingFee) / 1e36
			: (filledAmount * quote.marketPrice * quote.tradingFee) / 1e36;
		if (!_instantOpenMode) {
			LibAccount.realizeOpenTradingFee(quote.partyA, quoteFeeBeforeOpen - remainingQuoteFee);
		}
		{
			address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
			address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];

			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(ISymmioHook.onOpenPosition, (quoteId, filledAmount, openedPrice, quote.partyA, quote.partyB)),
				quoteId
			);
			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(
					ISymmioHook.onFeeCharged,
					(quoteId, openFee, quote.partyA, quote.partyB, quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.OPEN)
				),
				quoteId
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(ISymmioHook.onOpenPosition, (quoteId, filledAmount, openedPrice, quote.partyA, quote.partyB)),
				quoteId
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(
					ISymmioHook.onFeeCharged,
					(quoteId, openFee, quote.partyA, quote.partyB, quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.OPEN)
				),
				quoteId
			);
		}

		emit SharedEvents.TradeVolumeRecorded(
			quote.id,
			(filledAmount * quote.openedPrice) / 1e18,
			quote.partyA,
			quote.partyB,
			quote.symbolId,
			quote.affiliate,
			SharedEvents.TradeVolumeType.OPEN
		);
		emit SharedEvents.TradingFeeCharged(
			quote.id,
			openFee,
			quote.partyA,
			quote.partyB,
			quote.symbolId,
			quote.affiliate,
			SharedEvents.TradingFeeType.OPEN
		);
	}

	/// @notice Validates a close-to-liquidation request and computes the amount that keeps PartyA at the
	///         liquidation edge, reserving room for `solverFeeAmount` (pass 0 for the legacy fee-less path).
	///         Shared by PartyBPositionActionsFacetImpl and PartyBSolverFeeActionsFacet so the validation
	///         and rounding rules cannot diverge between the two close-to-liquidation paths.
	/// @dev Does NOT verify the Muon signature or any party's solvency; callers remain responsible for that.
	/// @param maxQuantity Ceiling on the close amount. The result is capped to `maxQuantity` and never exceeds it,
	///        even when keeping PartyA solvent would require closing more. When the cap binds the result can leave
	///        PartyA below the liquidation edge; the caller's solvency check then reverts (see
	///        PartyBPositionActionsFacetImpl). Pass `type(uint256).max` for the uncapped (legacy) path.
	/// @return filledAmount The close amount after applying both the liquidation limit and the `maxQuantity` cap.
	/// @return uncappedAmount The close amount the liquidation limit alone would allow, before the `maxQuantity`
	///         cap; equals `filledAmount` when the cap does not bind. Fee-aware callers use the
	///         `filledAmount / uncappedAmount` ratio to pro-rate an absolute solver fee to the amount actually closed.
	function calculateCloseToLiquidationAmount(
		uint256 quoteId,
		uint256 maxQuantity,
		uint256 closedPrice,
		uint256 marketPrice,
		int256 upnlPartyA,
		uint256 solverFeeAmount
	) internal view returns (uint256 filledAmount, uint256 uncappedAmount) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();

		require(
			quote.quoteStatus == QuoteStatus.CLOSE_PENDING || quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"PartyBFacet: Invalid state"
		);
		require(block.timestamp <= quote.deadline, "PartyBFacet: Quote is expired");

		// Validate closed price based on position type
		if (quote.positionType == PositionType.LONG) {
			require(closedPrice >= quote.requestedClosePrice, "PartyBFacet: Closed price isn't valid");
		} else {
			require(closedPrice <= quote.requestedClosePrice, "PartyBFacet: Closed price isn't valid");
		}

		// Only applicable for LIMIT orders - MARKET orders must be filled completely
		require(quote.orderType == OrderType.LIMIT, "PartyBFacet: Only LIMIT orders supported");

		// Calculate max close amount that keeps PartyA at liquidation threshold
		(uint256 maxCloseAmount, bool canCloseAll) = LibSolvency.calculateMaxCloseAmountToLiquidation(
			quoteId,
			closedPrice,
			marketPrice,
			upnlPartyA,
			solverFeeAmount
		);

		if (canCloseAll) {
			// Full close is safe
			filledAmount = quote.quantityToClose;
		} else {
			// Need to close partial amount
			filledAmount = maxCloseAmount;
		}

		// Liquidation-limited amount before the maxQuantity cap, so fee-aware callers can pro-rate an absolute fee.
		uncappedAmount = filledAmount;

		if (filledAmount > maxQuantity) {
			filledAmount = maxQuantity;
		}

		// Re-check minAcceptableQuoteValue only when the close was reduced below the requested amount -- a partial close
		// (maxCloseAmount) or a maxQuantity cap creates a new remaining position. A full fill of the requested amount was
		// already validated against minAcceptableQuoteValue at request time.
		if (filledAmount < quote.quantityToClose) {
			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			// Match LibQuoteClose rounding for remaining locked values
			uint256 remainingCva = quote.lockedValues.cva - ((quote.lockedValues.cva * filledAmount) / openAmount);
			uint256 remainingLf = quote.lockedValues.lf - ((quote.lockedValues.lf * filledAmount) / openAmount);
			uint256 remainingPartyAmm = quote.lockedValues.partyAmm - ((quote.lockedValues.partyAmm * filledAmount) / openAmount);
			uint256 remainingLockedValue = remainingCva + remainingLf + remainingPartyAmm;
			require(
				remainingLockedValue == 0 || remainingLockedValue >= symbolLayout.symbols[quote.symbolId].minAcceptableQuoteValue,
				"PartyBFacet: Remaining quote value is low"
			);
		}

		require(filledAmount > 0, "PartyBFacet: Cannot close any amount");
		require(filledAmount <= quote.quantityToClose, "PartyBFacet: Invalid filledAmount");
	}

	/// @notice On a partial open, the child (remainder) quote inherits the same solver-fee rate caps as the opened
	///         quote. Rate caps are notional-relative, so they are copied unchanged rather than split pro-rata; the
	///         opened state already holds these caps from quote creation.
	function _splitSolverFeeState(QuoteStorage.Layout storage quoteLayout, uint256 openedQuoteId, uint256 childQuoteId) private {
		SolverFeeState storage openedState = quoteLayout.solverFeeStates[openedQuoteId];
		SolverFeeState storage childState = quoteLayout.solverFeeStates[childQuoteId];
		childState.openRateCap = openedState.openRateCap;
		childState.closeRateCap = openedState.closeRateCap;
	}
}
