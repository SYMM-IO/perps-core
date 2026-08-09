// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBSolverFeeActionsFacet } from "./IPartyBSolverFeeActionsFacet.sol";
import { IPartyBPositionActionsFacet } from "../PartyBPositionActions/IPartyBPositionActionsFacet.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { LibSolverFee } from "../../libraries/LibSolverFee.sol";
import { LibPartyBPositionsActions } from "../../libraries/LibPartyBPositionsActions.sol";
import { QuoteStorage, Quote } from "../../storages/QuoteStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

contract PartyBSolverFeeActionsFacet is Accessibility, Pausable, IPartyBSolverFeeActionsFacet {
	/// @notice Opens a position and atomically charges the solver rate fee while preserving PartyA solvency.
	/// @dev Fee-aware overload of PartyBPositionActionsFacet.openPosition. Operational fees are charged separately
	///      via AccountFacet.chargeOperationalFee, exactly like any other registered charger.
	/// @param quoteId The ID of the quote for which the position is opened.
	/// @param filledAmount PartyB has the option to open the position with either the full amount requested by the user or a specific fraction of it.
	/// @param openedPrice The opened price for the position.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param solverFee Solver fee to charge against the quote's open solver fee rate cap.
	function openPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 solverFee
	) external whenNotPartyBOpenPositionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		_callPositionFacet(abi.encodeCall(IPartyBPositionActionsFacet.openPosition, (quoteId, filledAmount, openedPrice, upnlSig)));
		if (solverFee > 0) {
			_requireSolventAfterSolverFee(quoteId, filledAmount, 0, false, upnlSig, solverFee);
			address receiver = LibSolverFee.chargeOpenFeeIfAny(quoteId, solverFee);
			Quote storage quote = QuoteStorage.layout().quotes[quoteId];
			emit OpenSolverFeeCharged(quoteId, quote.partyA, quote.partyB, receiver, quote.symbolId, solverFee);
		}
	}

	/// @notice Fills a normal close request and atomically charges the solver rate fee while preserving PartyA solvency.
	/// @dev Fee-aware overload of PartyBPositionActionsFacet.fillCloseRequest. Operational fees are charged separately
	///      via AccountFacet.chargeOperationalFee, exactly like any other registered charger. The rate fee is charged
	///      BEFORE the close executes: a final close can fire hooks (e.g. AccountLayer virtual-account cleanup) that
	///      deallocate PartyA's entire allocated balance, which would make a post-close fee charge revert.
	/// @param quoteId The ID of the quote for which the close request is filled.
	/// @param filledAmount The filled amount for the close request.
	/// @param closedPrice The closed price for the close request.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param solverFee Solver fee to charge against the quote's close solver fee rate cap.
	function fillCloseRequest(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 solverFee
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		if (solverFee > 0) {
			_requireSolventAfterSolverFee(quoteId, filledAmount, closedPrice, true, upnlSig, solverFee);
			address receiver = LibSolverFee.chargeCloseFeeIfAny(quoteId, solverFee, filledAmount, closedPrice);
			Quote storage quote = QuoteStorage.layout().quotes[quoteId];
			emit CloseSolverFeeCharged(quoteId, quote.partyA, quote.partyB, receiver, quote.symbolId, solverFee);
		}
		_callPositionFacet(abi.encodeCall(IPartyBPositionActionsFacet.fillCloseRequest, (quoteId, filledAmount, closedPrice, upnlSig)));
	}

	/// @notice Fills a close request up to the lesser of `maxQuantity` and liquidation, atomically charging the solver rate fee.
	/// @dev Reserves room for the solver rate fee in the close-to-liquidation amount before deducting it. The amount
	///      calculation is shared with the fee-less PartyBPositionActionsFacet.fillCloseRequestToLiquidation via
	///      LibPartyBPositionsActions. Operational fees are charged separately via AccountFacet.chargeOperationalFee,
	///      like any other registered charger. The rate fee is charged before the close executes (see fillCloseRequest).
	///      Pass `type(uint256).max` as `maxQuantity` for an uncapped close-to-liquidation.
	/// @param quoteId The ID of the quote for which the close request is filled.
	/// @param maxQuantity The maximum quantity PartyB is willing to close in this transaction; caps the fill.
	/// @param closedPrice The closed price for the close request.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param solverFee Absolute solver fee sized for the liquidation-limited close; pro-rated down to the amount
	///        actually closed when `maxQuantity` caps the fill. Charged against the quote's close solver fee rate cap.
	/// @return filledAmount The actual amount that was filled.
	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 maxQuantity,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 solverFee
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) returns (uint256 filledAmount) {
		return _fillCloseRequestToLiquidation(quoteId, maxQuantity, closedPrice, upnlSig, solverFee);
	}

	/// @dev The caller passes `solverFee` as an absolute amount sized for the liquidation-limited close. When
	///      `maxQuantity` caps the fill below that amount, the fee is pro-rated to what is actually closed
	///      (`solverFee * filledAmount / uncappedAmount`) so the effective fee rate -- and therefore the close-rate
	///      cap check in LibSolverFee -- stays consistent regardless of the cap. The amount math still reserves room
	///      for the full `solverFee`, which only ever over-reserves and so keeps PartyA solvent.
	function _fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 maxQuantity,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 solverFee
	) private returns (uint256 filledAmount) {
		uint256 uncappedAmount;
		(filledAmount, uncappedAmount) = LibPartyBPositionsActions.calculateCloseToLiquidationAmount(
			quoteId,
			maxQuantity,
			closedPrice,
			upnlSig.price,
			upnlSig.upnlPartyA,
			solverFee
		);
		if (solverFee > 0) {
			// Pro-rate the absolute fee to the amount actually closed when maxQuantity caps the fill below the liquidation limit.
			uint256 chargedFee = filledAmount == uncappedAmount ? solverFee : (solverFee * filledAmount) / uncappedAmount;
			address receiver = LibSolverFee.chargeCloseFeeIfAny(quoteId, chargedFee, filledAmount, closedPrice);
			Quote storage quote = QuoteStorage.layout().quotes[quoteId];
			emit CloseSolverFeeCharged(quoteId, quote.partyA, quote.partyB, receiver, quote.symbolId, chargedFee);
		}
		_callPositionFacet(abi.encodeCall(IPartyBPositionActionsFacet.fillCloseRequest, (quoteId, filledAmount, closedPrice, upnlSig)));
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

	function _callPositionFacet(bytes memory callData) private {
		// solhint-disable-next-line avoid-low-level-calls
		(bool success, bytes memory result) = address(this).delegatecall(callData);
		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}
	}
}
