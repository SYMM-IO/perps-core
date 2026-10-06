// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPartyBExecutionFacet } from "./IPartyBExecutionFacet.sol";
import { IPartyBQuoteActionsFacet } from "../PartyBQuoteActions/IPartyBQuoteActionsFacet.sol";
import { IPartyBPositionActionsFacet } from "../PartyBPositionActions/IPartyBPositionActionsFacet.sol";
import { PartyBPositionActionsFacetImpl } from "../PartyBPositionActions/PartyBPositionActionsFacetImpl.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { LibSolverFee } from "../../libraries/LibSolverFee.sol";
import { LibPartyBPositionsActions } from "../../libraries/LibPartyBPositionsActions.sol";
import { LibPartiesEvents } from "../../libraries/LibPartiesEvents.sol";
import { QuoteStorage, Quote, SolverFeeEntry, SolverFeeType } from "../../storages/QuoteStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { SingleUpnlSig, PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

/// @notice Where the solver executes trades: fee-aware open, combined lock+open, and close fills.
/// @dev Normal trade actions run the underlying facet function through a self-delegatecall. The
///      fee-aware close-to-liquidation action uses the same internal close implementation so it can
///      pass the manager-configured PartyA shortfall without exposing that allowance in an external ABI.
///      Solver fees ride execution as tagged lists: each amount routes to the receiver resolved for its
///      tag, the total is charged atomically, and the user-approved caps in SolverFeeState bound it.
///      Empty fee arrays mean no fee. Operational fees are charged separately via AccountFacet.
contract PartyBExecutionFacet is Accessibility, Pausable, IPartyBExecutionFacet {
	/// @notice Opens a position and atomically charges the tagged solver fees while preserving PartyA solvency.
	/// @param quoteId The ID of the quote for which the position is opened.
	/// @param filledAmount PartyB has the option to open the position with either the full amount requested by the user or a specific fraction of it.
	/// @param openedPrice The opened price for the position.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param solverFees Tagged solver fee entries charged against the quote's open solver fee rate cap (empty = no fee).
	function openPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata solverFees
	) external whenNotPartyBOpenPositionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		_openPositionWithFees(quoteId, filledAmount, openedPrice, upnlSig, solverFees);
	}

	/// @notice Locks a pending quote and opens the position in one call, atomically charging the tagged solver fees.
	/// @dev Gas-optimized replacement for a separate lockQuote + openPosition (one signed operation instead of
	///      two in an InstantLayer template). Both legs are the real facet functions, so state transitions,
	///      events, and event order are identical to the sequential flow -- including openPosition's post-hook
	///      binding re-read and solvency check.
	/// @param quoteId The ID of the quote to lock and open.
	/// @param filledAmount PartyB has the option to open the position with either the full amount requested by the user or a specific fraction of it.
	/// @param openedPrice The opened price for the position.
	/// @param lockSig The Muon signature containing the single UPNL value used to lock the quote.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data used to open the position.
	/// @param solverFees Tagged solver fee entries charged against the quote's open solver fee rate cap (empty = no fee).
	function lockAndOpenPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		SingleUpnlSig memory lockSig,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata solverFees
	) external whenNotPartyBOpenPositionsPaused onlyPartyB notLiquidated(quoteId) {
		_callFacet(abi.encodeCall(IPartyBQuoteActionsFacet.lockQuote, (quoteId, lockSig)));
		_openPositionWithFees(quoteId, filledAmount, openedPrice, upnlSig, solverFees);
	}

	/// @notice Fills a normal close request and atomically charges the tagged solver fees while preserving PartyA solvency.
	/// @dev The fees are charged BEFORE the close executes: a final close can fire hooks (e.g. AccountLayer
	///      virtual-account cleanup) that deallocate PartyA's entire allocated balance, which would make a
	///      post-close fee charge revert.
	/// @param quoteId The ID of the quote for which the close request is filled.
	/// @param filledAmount The filled amount for the close request.
	/// @param closedPrice The closed price for the close request.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param solverFees Tagged solver fee entries charged against the quote's close solver fee rate cap (empty = no fee).
	function fillCloseRequest(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata solverFees
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		if (solverFees.length > 0) {
			_requireSolventAfterSolverFee(quoteId, filledAmount, closedPrice, true, upnlSig, _sum(solverFees));
			address[] memory receivers = LibSolverFee.chargeCloseSolverFees(quoteId, solverFees, filledAmount, closedPrice);
			_emitSolverFeesCharged(quoteId, SolverFeeType.CLOSE, solverFees, receivers);
		}
		_callFacet(abi.encodeCall(IPartyBPositionActionsFacet.fillCloseRequest, (quoteId, filledAmount, closedPrice, upnlSig)));
	}

	/// @notice Fills a close request up to the lesser of `maxFillAmount` and the configured close-to-liquidation boundary, atomically charging the tagged solver fees.
	/// @dev Includes the solver's maxFillAmount-based total fee rate in the close-to-liquidation amount before deducting it. The amount
	///      calculation is shared with the fee-less PartyBPositionActionsFacet.fillCloseRequestToLiquidation via
	///      LibPartyBPositionsActions. The fees are charged before the close executes (see fillCloseRequest).
	///      Each entry's amount is quoted for `maxFillAmount`; if the protocol closes less, every entry is
	///      pro-rated to the executed quantity and entries that round to zero are skipped.
	/// @param quoteId The ID of the quote for which the close request is filled.
	/// @param maxFillAmount The maximum amount PartyB is willing to close in this transaction; a smaller cap may leave PartyA solvent.
	///        For MARKET_BEST_EFFORT it must be at least the full requested quantity and never caps the fill.
	/// @param closedPrice The closed price for the close request.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param maxSolverFees Tagged solver fee entries quoted for `maxFillAmount` and the most that can be charged; pro-rated down
	///        when the protocol executes less. Charged against the quote's close solver fee rate cap (empty = no fee).
	/// @return filledAmount The actual amount that was filled.
	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 maxFillAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata maxSolverFees
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) returns (uint256 filledAmount) {
		return _fillCloseRequestToLiquidation(quoteId, maxFillAmount, closedPrice, upnlSig, maxSolverFees);
	}

	/// @dev Runs the real openPosition through the diamond, then charges the tagged solver fees on top.
	///      Shared by openPosition and lockAndOpenPosition so fee semantics cannot diverge between them.
	function _openPositionWithFees(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata solverFees
	) private {
		_callFacet(abi.encodeCall(IPartyBPositionActionsFacet.openPosition, (quoteId, filledAmount, openedPrice, upnlSig)));
		if (solverFees.length > 0) {
			_requireSolventAfterSolverFee(quoteId, filledAmount, 0, false, upnlSig, _sum(solverFees));
			address[] memory receivers = LibSolverFee.chargeOpenSolverFees(quoteId, solverFees);
			_emitSolverFeesCharged(quoteId, SolverFeeType.OPEN, solverFees, receivers);
		}
	}

	/// @dev The caller quotes each entry's amount for `maxFillAmount`. If the liquidation boundary or the
	///      remaining-value fallback reduces the fill, each fee is pro-rated to what is actually closed
	///      (`amount * filledAmount / maxFillAmount`) and zero-rounded entries are dropped. The planner uses
	///      the single-floor prorated total for every candidate amount, so per-entry flooring can only charge less.
	///      This applies uniformly to LIMIT and MARKET_BEST_EFFORT; MARKET_BEST_EFFORT only forbids a `maxFillAmount`
	///      below the full requested quantity (enforced by the planner), not the proration itself.
	function _fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 maxFillAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata maxSolverFees
	) private returns (uint256 filledAmount) {
		LibPartyBPositionsActions.CloseToLiquidationPlan memory plan = LibPartyBPositionsActions.calculateCloseToLiquidationPlan(
			quoteId,
			maxFillAmount,
			closedPrice,
			upnlSig.price,
			upnlSig.upnlPartyA,
			_sum(maxSolverFees)
		);
		filledAmount = plan.filledAmount;
		require(filledAmount > 0, "PartyBFacet: Cannot close any amount");
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		if (maxSolverFees.length > 0) {
			SolverFeeEntry[] memory chargedFees = _prorateFees(maxSolverFees, filledAmount, maxFillAmount);
			if (chargedFees.length > 0) {
				address[] memory receivers = LibSolverFee.chargeCloseSolverFees(quoteId, chargedFees, filledAmount, closedPrice);
				_emitSolverFeesCharged(quoteId, SolverFeeType.CLOSE, chargedFees, receivers);
			}
		}

		LibPartyBPositionsActions.prepareCloseToLiquidationFill(quoteId, filledAmount);
		uint256 actualShortfall = PartyBPositionActionsFacetImpl.fillCloseRequestWithAllowedShortfall(
			quoteId,
			filledAmount,
			closedPrice,
			upnlSig,
			plan.allowedShortfall
		);
		LibPartiesEvents.emitPartyALiquidationOvershootUsedIfAny(quote, quoteId, plan.effectiveRate, plan.allowedShortfall, actualShortfall);
		LibPartiesEvents.emitFillCloseRequest(quoteLayout, quote, quoteId, filledAmount, closedPrice);
	}

	/// @dev The solver quotes each fee for maxFillAmount; any smaller execution keeps the same per-entry fee rate.
	///      Entries that floor to zero after proration are dropped so the charge lib's positive-amount rule holds.
	function _prorateFees(
		SolverFeeEntry[] calldata maxSolverFees,
		uint256 filledAmount,
		uint256 maxFillAmount
	) private pure returns (SolverFeeEntry[] memory chargedFees) {
		chargedFees = new SolverFeeEntry[](maxSolverFees.length);
		uint256 count;
		for (uint256 i = 0; i < maxSolverFees.length; i++) {
			uint256 chargedFee =
				filledAmount == maxFillAmount ? maxSolverFees[i].amount : Math.mulDiv(maxSolverFees[i].amount, filledAmount, maxFillAmount);
			if (chargedFee == 0) continue;
			chargedFees[count] = SolverFeeEntry({ amount: chargedFee, tag: maxSolverFees[i].tag });
			count++;
		}
		assembly {
			mstore(chargedFees, count)
		}
	}

	/// @dev One event per charged fee so indexers can attribute each tagged amount to its resolved receiver.
	function _emitSolverFeesCharged(uint256 quoteId, SolverFeeType feeType, SolverFeeEntry[] memory entries, address[] memory receivers) private {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		for (uint256 i = 0; i < entries.length; i++) {
			emit SolverFeeCharged(quoteId, quote.partyA, quote.partyB, receivers[i], quote.symbolId, feeType, entries[i].amount, entries[i].tag);
		}
	}

	function _sum(SolverFeeEntry[] calldata entries) private pure returns (uint256 total) {
		for (uint256 i = 0; i < entries.length; i++) {
			total += entries[i].amount;
		}
	}

	/// @dev Requires PartyA to stay solvent after the position change AND the solver fee deduction.
	///      Mirrors the bound-mode exemption used by the core PartyB paths: when PartyA is bound to this
	///      PartyB and the PartyB is bindable, Muon/solvency checks are skipped by protocol design.
	/// @param closedPrice Only used when `isClose` is true.
	function _requireSolventAfterSolverFee(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		bool isClose,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 solverFeeAmount
	) private view {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		if (
			TradingModeStorage.layout().bindState[quote.partyA].partyB == quote.partyB && TradingModeStorage.layout().isPartyBBindable[quote.partyB]
		) {
			return;
		}

		uint256[] memory quoteIds = new uint256[](1);
		uint256[] memory filledAmounts = new uint256[](1);
		uint256[] memory marketPrices = new uint256[](1);
		quoteIds[0] = quoteId;
		filledAmounts[0] = filledAmount;
		marketPrices[0] = upnlSig.price;

		int256 partyBAvailableBalance;
		int256 partyAAvailableBalance;
		if (isClose) {
			uint256[] memory closedPrices = new uint256[](1);
			closedPrices[0] = closedPrice;
			(partyBAvailableBalance, partyAAvailableBalance) = LibSolvency.getAvailableBalanceAfterClosePosition(
				quoteIds,
				filledAmounts,
				closedPrices,
				marketPrices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				quote.partyB,
				quote.partyA
			);
		} else {
			(partyBAvailableBalance, partyAAvailableBalance) = LibSolvency.getAvailableBalanceAfterOpenPosition(
				quoteIds,
				filledAmounts,
				marketPrices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				quote.partyB,
				quote.partyA
			);
		}
		require(partyBAvailableBalance >= 0, "LibSolvency: Available balance is lower than zero");
		require(partyAAvailableBalance >= int256(solverFeeAmount), "SolverFee: PartyA will be insolvent after solver fee");
	}

	/// @dev Runs a sibling facet function through the diamond so its modifiers, guards, and events execute verbatim.
	function _callFacet(bytes memory callData) private {
		// solhint-disable-next-line avoid-low-level-calls
		(bool success, bytes memory result) = address(this).delegatecall(callData);
		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}
	}
}
