// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Pausable } from "../../utils/Pausable.sol";
import { Accessibility, LibAccessibility } from "../../utils/Accessibility.sol";
import { IPartyALiquidationSnapshotFacet } from "./IPartyALiquidationSnapshotFacet.sol";
import { LibPartyALiquidationSnapshotSetup } from "../../libraries/liquidation/LibPartyALiquidationSnapshotSetup.sol";
import { LibPartyALiquidationProcess } from "../../libraries/liquidation/LibPartyALiquidationProcess.sol";
import { LiquidationSnapshotSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";

contract PartyALiquidationSnapshotFacet is Pausable, Accessibility, IPartyALiquidationSnapshotFacet {
	/// @notice Starts PartyA liquidation using a Muon-signed snapshot.
	function liquidatePartyAWithSnapshot(
		address partyA,
		LiquidationSnapshotSig memory liquidationSig
	) external whenNotLiquidationPaused notLiquidatedPartyA(partyA) onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		LibPartyALiquidationSnapshotSetup.liquidatePartyAWithSnapshot(partyA, liquidationSig);
		_emitSnapshotLiquidationStarted(partyA, liquidationSig);
	}

	/// @notice Stores Muon-signed PartyB-symbol price/funding state for an in-progress PartyA liquidation.
	function setSymbolsPriceWithSnapshot(
		address partyA,
		LiquidationSnapshotSig memory liquidationSig
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		LibPartyALiquidationSnapshotSetup.setSymbolsPriceWithSnapshot(partyA, liquidationSig);
		_emitSnapshotPrices(partyA, liquidationSig);
	}

	/// @notice Starts and fully completes PartyA liquidation in one transaction using a signed snapshot.
	function singleStepLiquidatePartyAWithSnapshot(
		address partyA,
		LiquidationSnapshotSig memory liquidationSig,
		uint256[] memory quoteIds,
		address[] memory partyBs
	) external whenNotLiquidationPaused notLiquidatedPartyA(partyA) onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		LibPartyALiquidationSnapshotSetup.startAndSetSymbolsPriceWithSnapshot(partyA, liquidationSig);
		_emitSnapshotLiquidationStarted(partyA, liquidationSig);
		_emitSnapshotPrices(partyA, liquidationSig);

		_liquidatePendingPositionsPartyAWithSnapshot(partyA);

		if (quoteIds.length > 0) {
			_liquidatePositionsPartyAWithSnapshot(partyA, quoteIds);
		}

		_requireSingleStepReadyToSettle(partyA);
		_settlePartyALiquidationWithSnapshot(partyA, partyBs);
		_requireSingleStepComplete(partyA);
	}

	/// @notice Liquidates pending positions for a PartyA liquidation started through the snapshot flow.
	function liquidatePendingPositionsPartyAWithSnapshot(
		address partyA
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		_liquidatePendingPositionsPartyAWithSnapshot(partyA);
	}

	/// @notice Liquidates open positions for a PartyA liquidation started through the snapshot flow.
	function liquidatePositionsPartyAWithSnapshot(
		address partyA,
		uint256[] memory quoteIds
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		_liquidatePositionsPartyAWithSnapshot(partyA, quoteIds);
	}

	/// @notice Settles a PartyA liquidation started through the snapshot flow.
	function settlePartyALiquidationWithSnapshot(address partyA, address[] memory partyBs) external whenNotLiquidationPaused {
		_settlePartyALiquidationWithSnapshot(partyA, partyBs);
	}

	/// @notice Resolves a dispute for a PartyA liquidation started through the snapshot flow.
	function resolveLiquidationDisputeWithSnapshot(
		address partyA,
		address[] memory partyBs,
		int256[] memory amounts,
		bool disputed
	) external onlyRole(LibAccessibility.DISPUTE_ROLE) {
		bytes memory liquidationId = LibPartyALiquidationProcess.resolveLiquidationDispute(partyA, partyBs, amounts, disputed);
		emit ResolveLiquidationDispute(partyA, partyBs, amounts, disputed, liquidationId);
	}

	function _liquidatePendingPositionsPartyAWithSnapshot(address partyA) private {
		uint256[] memory pendingQuotes = QuoteStorage.layout().partyAPendingQuotes[partyA];
		(uint256[] memory liquidatedAmounts, bytes memory liquidationId) = LibPartyALiquidationProcess.liquidatePendingPositionsPartyA(partyA);
		emit LiquidatePendingPositionsPartyA(msg.sender, partyA, pendingQuotes, liquidatedAmounts, liquidationId);
	}

	function _liquidatePositionsPartyAWithSnapshot(address partyA, uint256[] memory quoteIds) private {
		(
			bool disputed,
			uint256[] memory liquidatedAmounts,
			uint256[] memory closeIds,
			uint256[] memory averageClosedPrices,
			bytes memory liquidationId
		) = LibPartyALiquidationProcess.liquidatePositionsPartyA(partyA, quoteIds);
		emit LiquidatePositionsPartyA(msg.sender, partyA, quoteIds, liquidatedAmounts, closeIds, liquidationId);
		emit LiquidatePositionsPartyA(msg.sender, partyA, quoteIds, liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
		if (disputed) {
			emit LiquidationDisputed(partyA, liquidationId);
		}
	}

	function _settlePartyALiquidationWithSnapshot(address partyA, address[] memory partyBs) private {
		(int256[] memory settleAmounts, bytes memory liquidationId, bool fullySettled) = LibPartyALiquidationProcess.settlePartyALiquidation(
			partyA,
			partyBs
		);
		emit SettlePartyALiquidation(partyA, partyBs, settleAmounts, liquidationId);
		if (fullySettled) {
			emit FullyLiquidatedPartyA(partyA, liquidationId);
		}
	}

	function _emitSnapshotLiquidationStarted(address partyA, LiquidationSnapshotSig memory liquidationSig) private {
		emit DeferredLiquidatePartyA(
			msg.sender,
			partyA,
			AccountStorage.layout().allocatedBalances[partyA],
			liquidationSig.upnl,
			liquidationSig.totalUnrealizedLoss,
			liquidationSig.liquidationId,
			liquidationSig.liquidationBlockNumber,
			liquidationSig.liquidationTimestamp,
			liquidationSig.liquidationAllocatedBalance
		);
	}

	function _emitSnapshotPrices(address partyA, LiquidationSnapshotSig memory liquidationSig) private {
		(
			address[] memory partyBs,
			uint256[] memory symbolIds,
			uint256[] memory prices,
			int256[] memory cumulativeLongFees,
			int256[] memory cumulativeShortFees
		) = _extractSnapshotData(liquidationSig);
		emit SetSymbolsPrices(msg.sender, partyA, symbolIds, prices, liquidationSig.liquidationId);
		emit SetPartyALiquidationSnapshot(
			msg.sender,
			partyA,
			partyBs,
			symbolIds,
			prices,
			cumulativeLongFees,
			cumulativeShortFees,
			liquidationSig.liquidationId
		);
	}

	function _extractSnapshotData(
		LiquidationSnapshotSig memory liquidationSig
	)
		private
		pure
		returns (
			address[] memory partyBs,
			uint256[] memory symbolIds,
			uint256[] memory prices,
			int256[] memory cumulativeLongFees,
			int256[] memory cumulativeShortFees
		)
	{
		partyBs = new address[](liquidationSig.states.length);
		symbolIds = new uint256[](liquidationSig.states.length);
		prices = new uint256[](liquidationSig.states.length);
		cumulativeLongFees = new int256[](liquidationSig.states.length);
		cumulativeShortFees = new int256[](liquidationSig.states.length);
		for (uint256 index = 0; index < liquidationSig.states.length; index++) {
			partyBs[index] = liquidationSig.states[index].partyB;
			symbolIds[index] = liquidationSig.states[index].symbolId;
			prices[index] = liquidationSig.states[index].price;
			cumulativeLongFees[index] = liquidationSig.states[index].cumulativeLongFee;
			cumulativeShortFees[index] = liquidationSig.states[index].cumulativeShortFee;
		}
	}

	function _requireSingleStepReadyToSettle(address partyA) private view {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		require(
			quoteLayout.partyAPositionsCount[partyA] == 0 && quoteLayout.partyAPendingQuotes[partyA].length == 0,
			"LiquidationFacet: Incomplete single-step liquidation"
		);
	}

	function _requireSingleStepComplete(address partyA) private view {
		require(AccountStorage.layout().liquidationDetails[partyA].involvedPartyBCounts == 0, "LiquidationFacet: Incomplete single-step liquidation");
		require(!MAStorage.layout().liquidationStatus[partyA], "LiquidationFacet: Incomplete single-step liquidation");
	}
}
