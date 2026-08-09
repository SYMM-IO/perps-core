// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";
import { AffiliateStorage } from "../storages/AffiliateStorage.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";

/// @title LibHook
/// @notice Library for safely calling hooks with signer protection
/// @dev Clears the signer before calling hooks to prevent hooks from impersonating users
library LibHook {
	/// @dev Reverts when a hook fails.
	error HookReverted(address hook, bytes4 selector, uint256 quoteId, bytes reason);

	/// @notice Safely calls a hook with signer cleared
	/// @dev Clears signer before call to prevent impersonation attacks, restores after
	/// @param hook The hook contract address
	/// @param data The encoded function call data
	/// @param quoteId The quote ID for event emission on failure
	function safeCall(address hook, bytes memory data, uint256 quoteId) internal {
		if (hook == address(0)) return;

		// Save and clear signer before external call to prevent hook from impersonating user
		address previousSigner = GlobalAppStorage.layout().signer;
		GlobalAppStorage.layout().signer = address(0);

		(bool success, bytes memory reason) = hook.call(data);

		// NOTE: We intentionally revert on hook failures for now to avoid inconsistency
		if (!success) {
			revert HookReverted(hook, bytes4(data), quoteId, reason);
		}

		// Restore signer after hook call
		GlobalAppStorage.layout().signer = previousSigner;
	}

	/// @notice Calls onCancelQuote on both affiliate and system hooks.
	/// @param quoteId The ID of the cancelled quote.
	/// @param partyA The address of Party A.
	/// @param partyB The address of Party B.
	/// @param affiliate The affiliate address for hook resolution.
	function callCancelQuoteHooks(uint256 quoteId, address partyA, address partyB, address affiliate) internal {
		address affiliateHook = AffiliateStorage.layout().affiliateHooks[affiliate];
		address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
		safeCall(affiliateHook, abi.encodeCall(ISymmioHook.onCancelQuote, (quoteId, partyA, partyB)), quoteId);
		safeCall(systemHook, abi.encodeCall(ISymmioHook.onCancelQuote, (quoteId, partyA, partyB)), quoteId);
	}

	/// @notice Calls onLiquidationSettled on the system hook only (no quote context, so affiliate is unknown).
	/// @param partyA The address of Party A whose liquidation was settled.
	function callLiquidationSettledHooks(address partyA) internal {
		address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
		safeCall(systemHook, abi.encodeCall(ISymmioHook.onLiquidationSettled, (partyA)), 0);
	}

	/// @notice Calls onCloseExpired on both affiliate and system hooks.
	/// @param quoteId The ID of the quote whose close request expired/was force-cancelled.
	/// @param partyA The address of Party A.
	/// @param partyB The address of Party B.
	/// @param affiliate The affiliate address for hook resolution.
	function callCloseExpiredHooks(uint256 quoteId, address partyA, address partyB, address affiliate) internal {
		address affiliateHook = AffiliateStorage.layout().affiliateHooks[affiliate];
		address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
		safeCall(affiliateHook, abi.encodeCall(ISymmioHook.onCloseExpired, (quoteId, partyA, partyB)), quoteId);
		safeCall(systemHook, abi.encodeCall(ISymmioHook.onCloseExpired, (quoteId, partyA, partyB)), quoteId);
	}

	/// @notice Calls onClosePosition on both affiliate and system hooks.
	/// @param quoteId The ID of the closed quote.
	/// @param closedAmount The amount that was closed.
	/// @param closedPrice The price at which the position was closed.
	/// @param partyA The address of Party A.
	/// @param partyB The address of Party B.
	/// @param affiliate The affiliate address for hook resolution.
	function callClosePositionHooks(
		uint256 quoteId,
		uint256 closedAmount,
		uint256 closedPrice,
		address partyA,
		address partyB,
		address affiliate
	) internal {
		address affiliateHook = AffiliateStorage.layout().affiliateHooks[affiliate];
		address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
		safeCall(affiliateHook, abi.encodeCall(ISymmioHook.onClosePosition, (quoteId, closedAmount, closedPrice, partyA, partyB)), quoteId);
		safeCall(systemHook, abi.encodeCall(ISymmioHook.onClosePosition, (quoteId, closedAmount, closedPrice, partyA, partyB)), quoteId);
	}
}
