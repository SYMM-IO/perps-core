// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ISymmioHook } from "../interfaces/ISymmioHook.sol";

interface IBindingCore {
	function completeUnbindRequest(address partyA) external;
}

/// @notice Test hook that completes a matured unbind request during onOpenPosition.
///         completeUnbindRequest is permissionless once the unbind cooldown has passed, so any hook
///         can flip a partyA's bind state in the middle of an open. Used to verify that
///         lockAndOpenPosition re-reads the binding after the open (like the sequential
///         openPosition does) instead of trusting its entry-time read.
contract UnbindDuringOpenHook is ISymmioHook {
	address public immutable symmioCore;

	constructor(address _symmioCore) {
		symmioCore = _symmioCore;
	}

	function onOpenPosition(uint256, uint256, uint256, address partyA, address) external override {
		IBindingCore(symmioCore).completeUnbindRequest(partyA);
	}

	function onClosePosition(uint256, uint256, uint256, address, address) external override {}

	function onCancelQuote(uint256, address, address) external override {}

	function onCloseExpired(uint256, address, address) external override {}

	function onFeeCharged(uint256, uint256, address, address, uint256, address, ISymmioHook.TradingFeeType) external override {}

	function onLiquidationSettled(address) external override {}
}
