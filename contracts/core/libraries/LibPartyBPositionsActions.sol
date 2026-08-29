// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { QuoteStorage, Quote, LockedValues, PositionType, OrderType, QuoteStatus, SolverFeeState } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { AffiliateStorage } from "../storages/AffiliateStorage.sol";
import { LibExecutionContext } from "./LibExecutionContext.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibQuote } from "./LibQuote.sol";
import { LibQuoteClose } from "./LibQuoteClose.sol";
import { LibQuoteFunding } from "./LibQuoteFunding.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibSolvency } from "./LibSolvency.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibHook } from "./LibHook.sol";
import { LibLiquidationCushion } from "./LibLiquidationCushion.sol";
import { LibSymbolAdjustment } from "./LibSymbolAdjustment.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";
import { LibSymbol } from "./LibSymbol.sol";

library LibPartyBPositionsActions {
	using LockedValuesOps for LockedValues;

	struct CloseToLiquidationPlan {
		uint256 filledAmount;
		uint256 zeroRateAmount;
		uint256 effectiveRate;
		uint256 allowedShortfall;
		bool canCloseAll;
	}

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

		bool _instantOpenMode = LibExecutionContext.isInstantOpenMode();
		if (_instantOpenMode) {
			require(quote.quantity == filledAmount, "PartyBFacet: InstantOpen requires full fill");
		}

		uint256 quoteFeeBeforeOpen = LibQuote.getReservedOpenTradingFee(quote, LibQuote.quoteOpenAmount(quote));
		// Snapshot the reserved fee before openedPrice is written, after which the request-time basis is unrecoverable.
		uint256 reservedOpenFee = LibQuote.getReservedOpenTradingFee(quote, filledAmount);
		uint256 remainingQuoteFee = 0;
		if (quote.orderType == OrderType.LIMIT) {
			require(quote.quantity >= filledAmount && filledAmount > 0, "PartyBFacet: Invalid filledAmount");
		} else {
			require(quote.quantity == filledAmount, "PartyBFacet: Invalid filledAmount");
		}
		if (quote.positionType == PositionType.LONG) {
			require(openedPrice <= quote.requestedOpenPrice, "PartyBFacet: Opened price isn't valid");
		} else {
			require(openedPrice >= quote.requestedOpenPrice, "PartyBFacet: Opened price isn't valid");
		}

		quote.openedPrice = openedPrice;
		quote.initialOpenedPrice = openedPrice;
		quote.statusModifyTimestamp = block.timestamp;
		// Charge on the price PartyB actually filled at. Settling the difference here, before the caller's
		// solvency check, is what lets an unaffordable shortfall revert the whole open.
		uint256 executedOpenFee = LibQuote.getExecutedOpenTradingFee(quote, filledAmount);
		LibAccount.applyOpenTradingFeeDelta(quote.partyA, reservedOpenFee, executedOpenFee);

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
			remainingQuoteFee = LibQuote.getReservedOpenTradingFee(newQuote, LibQuote.quoteOpenAmount(newQuote));

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
			if (newStatus != QuoteStatus.CANCELED) {
				require(
					newQuote.lockedValues.lf >= LibSymbol.requiredNotionalLF(newQuote.symbolId, newQuote.quantity, newQuote.requestedOpenPrice),
					"PartyBFacet: Notional LF is not enough"
				);
			}
			quote.quantity = filledAmount;
			quote.lockedValues = appliedFilledLockedValues;
		}
		require(
			quote.lockedValues.lf >= LibSymbol.requiredNotionalLF(quote.symbolId, quote.quantity, quote.openedPrice),
			"PartyBFacet: Notional LF is not enough"
		);
		// lock with amount of filledAmount
		accountLayout.lockedBalances[quote.partyA].addQuote(quote);
		LibAccount.addToPartyBLockedBalances(quote);

		// check leverage (is in 18 decimals)
		require(
			(quote.quantity * quote.openedPrice) / quote.lockedValues.totalForPartyA() <= SymbolStorage.layout().symbols[quote.symbolId].maxLeverage,
			"PartyBFacet: Leverage is high"
		);

		accountLayout.balances[LibAccount.getFeeCollector(quote.affiliate)] += executedOpenFee;
		quoteLayout.partyBPositionsCount[quote.partyB][address(0)] += 1;
		quote.quoteStatus = QuoteStatus.OPENED;
		LibQuote.addToOpenPositions(quoteId);

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
					(quoteId, executedOpenFee, quote.partyA, quote.partyB, quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.OPEN)
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
					(quoteId, executedOpenFee, quote.partyA, quote.partyB, quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.OPEN)
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
			executedOpenFee,
			quote.partyA,
			quote.partyB,
			quote.symbolId,
			quote.affiliate,
			SharedEvents.TradingFeeType.OPEN
		);
	}

	/// @notice Validates a close-to-liquidation request and builds the shared execution plan.
	/// @dev Does NOT verify the Muon signature or any party's solvency; callers remain responsible for that.
	///      The boundary search is bounded by `min(maxFillAmount, quantityToClose)` inside LibSolvency, so `filledAmount`
	///      already respects the caller's ceiling before the remaining-value fallback runs.
	function calculateCloseToLiquidationPlan(
		uint256 quoteId,
		uint256 maxFillAmount,
		uint256 closedPrice,
		uint256 marketPrice,
		int256 upnlPartyA,
		uint256 maxSolverFee
	) internal view returns (CloseToLiquidationPlan memory plan) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

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

		plan.effectiveRate = LibLiquidationCushion.rate(quote.partyB, quote.symbolId);
		LibSolvency.CloseToLiquidationInputs memory inputs = LibSolvency.CloseToLiquidationInputs({
			closedPrice: closedPrice,
			marketPrice: marketPrice,
			upnlPartyA: upnlPartyA,
			maxSolverFee: maxSolverFee,
			maxFillAmount: maxFillAmount,
			cushionRate: plan.effectiveRate
		});
		// A caller cap smaller than the boundary may leave PartyA solvent; the fill is simply the tighter of the two limits.
		(plan.filledAmount, plan.canCloseAll) = LibSolvency.calculateMaxCloseAmountToLiquidation(quoteId, inputs);
		if (plan.effectiveRate == 0) {
			plan.zeroRateAmount = plan.filledAmount;
		}
		require(plan.filledAmount <= quote.quantityToClose, "PartyBFacet: Invalid filledAmount");

		if (!_remainingQuoteValueIsValid(quote, plan.filledAmount)) {
			// The zero-rate amount is only needed when the configured-rate amount enters the invalid remainder band.
			if (plan.effectiveRate != 0) {
				inputs.cushionRate = 0;
				(plan.zeroRateAmount, ) = LibSolvency.calculateMaxCloseAmountToLiquidation(quoteId, inputs);
			}
			if (plan.filledAmount > plan.zeroRateAmount && _remainingQuoteValueIsValid(quote, plan.zeroRateAmount)) {
				plan.filledAmount = plan.zeroRateAmount;
			} else {
				revert("PartyBFacet: Remaining quote value is low");
			}
		}

		plan.allowedShortfall = LibLiquidationCushion.allowedShortfallAfterClose(quote, plan.filledAmount, plan.effectiveRate);
	}

	/// @notice Matches the remaining-position check performed by LibQuoteClose for partial close-request fills.
	function _remainingQuoteValueIsValid(Quote storage quote, uint256 filledAmount) private view returns (bool) {
		// Filling the whole pending close request creates no new intermediate remainder. Any position left open after
		// that requested close was already checked when PartyA created the request, so only a partial fill needs this check.
		if (filledAmount == quote.quantityToClose) return true;

		uint256 openAmount = LibQuote.quoteOpenAmount(quote);
		uint256 remainingLockedValue =
			quote.lockedValues.cva -
				Math.mulDiv(quote.lockedValues.cva, filledAmount, openAmount) +
				quote.lockedValues.lf -
				Math.mulDiv(quote.lockedValues.lf, filledAmount, openAmount) +
				quote.lockedValues.partyAmm -
				Math.mulDiv(quote.lockedValues.partyAmm, filledAmount, openAmount);
		uint256 minAcceptableQuoteValue = SymbolStorage.layout().symbols[quote.symbolId].minAcceptableQuoteValue;
		return remainingLockedValue == 0 || remainingLockedValue >= minAcceptableQuoteValue;
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
