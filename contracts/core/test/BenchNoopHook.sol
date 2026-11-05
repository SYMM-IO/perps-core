// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ISymmioHook } from "../interfaces/ISymmioHook.sol";

/// @notice Minimal no-op hook used only by gas benchmarks to measure the lower bound
///         of external hook-call overhead (cold account access + call + dispatch).
contract BenchNoopHook is ISymmioHook {
	function onOpenPosition(uint256, uint256, uint256, address, address) external override {}

	function onClosePosition(uint256, uint256, uint256, address, address) external override {}

	function onCancelQuote(uint256, address, address) external override {}

	function onCloseExpired(uint256, address, address) external override {}

	function onFeeCharged(uint256, uint256, address, address, uint256, address, ISymmioHook.TradingFeeType) external override {}

	function onLiquidationSettled(address) external override {}
}
