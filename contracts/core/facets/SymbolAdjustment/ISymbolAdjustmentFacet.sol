// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SymbolAdjustment } from "../../storages/SymbolAdjustmentStorage.sol";

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
	event RestatementStarted(uint256 indexed symbolId, uint256 epoch, uint256 cumulativeFactor);
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

	function startRestatement(uint256 symbolId) external;

	function abortRestatement(uint256 symbolId) external;

	function applyAdjustment(uint256 symbolId, uint256[] calldata quoteIds) external;

	function cancelPendingQuotes(uint256[] calldata quoteIds) external;

	function finalizeRestatement(uint256 symbolId) external;

	function getSymbolAdjustment(uint256 symbolId) external view returns (SymbolAdjustment memory);

	function getCumulativeFactor(uint256 symbolId) external view returns (uint256);

	function getProspectiveCumulativeFactor(uint256 symbolId) external view returns (uint256);

	function previewQuoteAdjustment(uint256 symbolId, uint256 quoteId) external view returns (QuoteAdjustmentPreview memory preview);

	function isSymbolFrozen(uint256 symbolId) external view returns (bool);

	function getRestatementState(uint256 symbolId) external view returns (bool restating, uint256 epoch);

	function getQuoteRestatedEpoch(uint256 quoteId) external view returns (uint256);
}
