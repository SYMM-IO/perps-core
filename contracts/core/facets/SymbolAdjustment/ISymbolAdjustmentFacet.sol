// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PositionType } from "../../storages/QuoteStorage.sol";

interface ISymbolAdjustmentFacet {
	struct QuoteAdjustmentPreview {
		uint256 factor;
		uint256 quantity;
		uint256 openedPrice;
		uint256 initialOpenedPrice;
		uint256 requestedOpenPrice;
		uint256 marketPrice;
		uint256 closedAmount;
		uint256 avgClosedPrice;
		uint256 quantityToClose;
		uint256 requestedClosePrice;
	}

	event AdjustmentScheduled(uint256 indexed symbolId, uint256 adjustmentIndex, uint256 factor, uint256 effectiveTimestamp);
	event AdjustmentCancelled(uint256 indexed symbolId, uint256 adjustmentIndex);
	event PriceAdjustmentConfirmed(uint256 indexed symbolId, uint256 adjustmentIndex, uint256 newCumulativeFactor);
	event RestatementStarted(uint256 indexed symbolId, uint256 epoch, uint256 restatementFactor);
	event RestatementPreparationProgress(
		uint256 indexed symbolId,
		uint256 indexed epoch,
		uint256 submittedPartyBCount,
		uint256 newlyPreparedPartyBCount,
		uint256 fundingCheckpointedPartyBCount,
		uint256 totalRemainingLongAmount,
		uint256 totalRemainingShortAmount,
		uint256 pendingFundingPartyBCount
	);
	event RestatementPreparationCompleted(
		uint256 indexed symbolId,
		uint256 indexed epoch,
		uint256 totalRemainingLongAmount,
		uint256 totalRemainingShortAmount,
		uint256 pendingFundingPartyBCount
	);
	event RestatementInventoryPrepared(
		uint256 indexed symbolId,
		uint256 indexed epoch,
		address indexed partyB,
		uint256 partyBRemainingLongAmount,
		uint256 partyBRemainingShortAmount,
		uint256 totalRemainingLongAmount,
		uint256 totalRemainingShortAmount
	);
	event RestatementInventoryConsumed(
		uint256 indexed symbolId,
		uint256 indexed epoch,
		uint256 indexed quoteId,
		address partyB,
		PositionType positionType,
		uint256 consumedAmount
	);
	event RestatementFundingRestorationStarted(uint256 indexed symbolId, uint256 indexed epoch, bool finalizing, uint256 pendingPartyBs);
	event RestatementFundingRestorationProgress(
		uint256 indexed symbolId,
		uint256 indexed epoch,
		bool finalizing,
		uint256 processedPartyBs,
		uint256 remainingPartyBs
	);
	event RestatementAborted(uint256 indexed symbolId, uint256 epoch);
	event QuoteAdjusted(
		uint256 indexed quoteId,
		uint256 indexed symbolId,
		uint256 epoch,
		uint256 factor,
		uint256 oldQuantity,
		uint256 newQuantity,
		uint256 oldOpenedPrice,
		uint256 newOpenedPrice
	);
	event PendingQuoteCancelledByAdjustment(uint256 indexed quoteId, uint256 indexed symbolId);
	event RestatementFinalized(uint256 indexed symbolId, uint256 epoch);

	function scheduleAdjustment(uint256 symbolId, uint256 factor, uint256 effectiveTimestamp) external;

	function cancelAdjustment(uint256 symbolId) external;

	function confirmPriceAdjusted(uint256 symbolId) external;

	/// @notice Starts a frozen restatement and initializes bounded funding preparation.
	function startRestatement(uint256 symbolId) external;

	/// @notice Processes only the operator-supplied PartyBs for funding preparation or restoration.
	function processRestatementFunding(uint256 symbolId, address[] calldata partyBs) external;

	/// @notice Attests that Operations supplied every PartyB and starts the funding-only pass when accumulated funding is active.
	function completeRestatementFundingPreparation(uint256 symbolId) external;

	function abortRestatement(uint256 symbolId) external;

	function applyAdjustment(uint256 symbolId, uint256[] calldata quoteIds) external;

	function cancelPendingQuotes(uint256[] calldata quoteIds) external;

	function finalizeRestatement(uint256 symbolId) external;
}
