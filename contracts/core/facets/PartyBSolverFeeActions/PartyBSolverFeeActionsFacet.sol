// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBSolverFeeActionsFacet } from "./IPartyBSolverFeeActionsFacet.sol";
import { IPartyBPositionActionsFacet } from "../PartyBPositionActions/IPartyBPositionActionsFacet.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { LibSolverFee } from "../../libraries/LibSolverFee.sol";
import { LibPartyBPositionsActions } from "../../libraries/LibPartyBPositionsActions.sol";
import { QuoteStorage, Quote } from "../../storages/QuoteStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

contract PartyBSolverFeeActionsFacet is Accessibility, Pausable, IPartyBSolverFeeActionsFacet {
	/// @notice Opens a position and atomically charges capped solver fees while preserving PartyA solvency after the fee.
	/// @dev Fee-aware overload of PartyBPositionActionsFacet.openPosition.
	/// @param quoteId The ID of the quote for which the position is opened.
	/// @param filledAmount PartyB has the option to open the position with either the full amount requested by the user or a specific fraction of it.
	/// @param openedPrice The opened price for the position.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param operationalFee Fixed operational fee to charge against the quote-level operational fee cap.
	/// @param solverFee Solver fee to charge against the quote's open solver fee rate cap.
	function openPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 operationalFee,
		uint256 solverFee
	) external whenNotPartyBOpenPositionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		uint256 totalSolverFeeAmount = operationalFee + solverFee;

		_delegateToDiamond(abi.encodeCall(IPartyBPositionActionsFacet.openPosition, (quoteId, filledAmount, openedPrice, upnlSig)));

		if (totalSolverFeeAmount > 0) {
			_requirePartyASolventAfterSolverFee(quoteId, filledAmount, 0, false, upnlSig, totalSolverFeeAmount);
			LibSolverFee.chargeOpenFees(quoteId, operationalFee, solverFee);
			_emitFeesCharged(quoteId, operationalFee, solverFee, false);
		}
	}

	/// @notice Fills a normal close request and atomically charges capped solver fees while preserving PartyA solvency after the fee.
	/// @dev Fee-aware overload of PartyBPositionActionsFacet.fillCloseRequest. Fees are charged BEFORE the close
	///      executes: a final close can fire hooks (e.g. AccountLayer virtual-account cleanup) that deallocate
	///      PartyA's entire allocated balance, which would make a post-close fee charge revert.
	/// @param quoteId The ID of the quote for which the close request is filled.
	/// @param filledAmount The filled amount for the close request.
	/// @param closedPrice The closed price for the close request.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param operationalFee Fixed operational fee to charge against the quote-level operational fee cap.
	/// @param solverFee Solver fee to charge against the quote's close solver fee rate cap.
	function fillCloseRequest(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 operationalFee,
		uint256 solverFee
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		uint256 totalSolverFeeAmount = operationalFee + solverFee;

		if (totalSolverFeeAmount > 0) {
			_requirePartyASolventAfterSolverFee(quoteId, filledAmount, closedPrice, true, upnlSig, totalSolverFeeAmount);
			LibSolverFee.chargeCloseFees(quoteId, operationalFee, solverFee, filledAmount, closedPrice);
			_emitFeesCharged(quoteId, operationalFee, solverFee, true);
		}

		_delegateToDiamond(abi.encodeCall(IPartyBPositionActionsFacet.fillCloseRequest, (quoteId, filledAmount, closedPrice, upnlSig)));
	}

	/// @notice Fills a close request up to liquidation and atomically charges capped solver fees.
	/// @dev This method reserves room for `operationalFee + solverFee` in the close-to-liquidation amount before
	///      deducting the fees from PartyA allocated balance. The amount calculation is shared with the legacy
	///      PartyBPositionActionsFacet.fillCloseRequestToLiquidation via LibPartyBPositionsActions. Fees are
	///      charged BEFORE the close executes (see fillCloseRequest).
	/// @param quoteId The ID of the quote for which the close request is filled.
	/// @param closedPrice The closed price for the close request.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @param operationalFee Fixed operational fee to charge against the quote-level operational fee cap.
	/// @param solverFee Solver fee to charge against the quote's close solver fee rate cap.
	/// @return filledAmount The actual amount that was filled.
	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 operationalFee,
		uint256 solverFee
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) returns (uint256 filledAmount) {
		uint256 totalSolverFeeAmount = operationalFee + solverFee;
		filledAmount = LibPartyBPositionsActions.calculateCloseToLiquidationAmount(
			quoteId,
			closedPrice,
			upnlSig.price,
			upnlSig.upnlPartyA,
			totalSolverFeeAmount
		);

		if (totalSolverFeeAmount > 0) {
			LibSolverFee.chargeCloseFees(quoteId, operationalFee, solverFee, filledAmount, closedPrice);
			_emitFeesCharged(quoteId, operationalFee, solverFee, true);
		}

		_delegateToDiamond(abi.encodeCall(IPartyBPositionActionsFacet.fillCloseRequest, (quoteId, filledAmount, closedPrice, upnlSig)));
	}

	/// @dev Requires PartyA to stay solvent after the position change AND the solver fee deduction.
	///      Mirrors the bound-mode exemption used by the core PartyB paths: when PartyA is bound to this
	///      PartyB and the PartyB is bindable, Muon/solvency checks are skipped by protocol design.
	/// @param closedPrice Only used when `isClose` is true.
	function _requirePartyASolventAfterSolverFee(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		bool isClose,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 totalSolverFeeAmount
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
		require(partyAAvailableBalance >= int256(totalSolverFeeAmount), "SolverFee: PartyA will be insolvent after solver fee");
	}

	function _delegateToDiamond(bytes memory callData) private {
		// solhint-disable-next-line avoid-low-level-calls
		(bool success, bytes memory result) = address(this).delegatecall(callData);
		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}
	}

	function _emitFeesCharged(uint256 quoteId, uint256 operationalFee, uint256 solverFee, bool isClose) private {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		if (operationalFee > 0) {
			emit OperationalFeeCharged(
				quoteId,
				quote.partyA,
				quote.partyB,
				LibAccount.getOperationalFeeReceiver(quote.partyB),
				quote.symbolId,
				operationalFee
			);
		}
		if (solverFee > 0) {
			if (isClose) {
				emit CloseSolverFeeCharged(quoteId, quote.partyA, quote.partyB, quote.symbolId, solverFee);
			} else {
				emit OpenSolverFeeCharged(quoteId, quote.partyA, quote.partyB, quote.symbolId, solverFee);
			}
		}
	}
}
