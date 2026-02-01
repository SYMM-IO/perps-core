// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MAStorage } from "../storages/MAStorage.sol";
import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { Quote, QuoteStatus, QuoteStorage } from "../storages/QuoteStorage.sol";
import { TradingModeStorage } from "../storages/TradingModeStorage.sol";
import { CrossPartyBStorage } from "../storages/CrossPartyBStorage.sol";
import { LibAccessibility } from "../libraries/LibAccessibility.sol";
import { LibSigner } from "../libraries/LibSigner.sol";

abstract contract Accessibility {
	modifier onlyPartyB() {
		require(MAStorage.layout().partyBStatus[LibSigner.getSigner()], "Accessibility: Should be partyB");
		_;
	}

	modifier notPartyB() {
		require(!MAStorage.layout().partyBStatus[LibSigner.getSigner()], "Accessibility: Shouldn't be partyB");
		_;
	}

	modifier userNotPartyB(address user) {
		require(!MAStorage.layout().partyBStatus[user], "Accessibility: Shouldn't be partyB");
		_;
	}


	/// @notice Restricts function access to accounts that are admins for a specific role.
	/// @dev Includes proxy protection by default. When a proxy sets a signer before forwarding calls,
	///      `msg.sender` becomes the proxy address. Without the proxy check, functions would authorize
	///      based on the proxy's roles rather than the original caller's - allowing users to inherit
	///      any privileged roles held by the proxy.
	modifier onlyRoleAdmin(bytes32 role) {
		require(GlobalAppStorage.layout().signer == address(0), "Accessibility: Cannot call via proxy");
		require(LibAccessibility.isRoleAdmin(msg.sender, role), "Accessibility: Must be role admin");
		_;
	}

	/// @notice Restricts function access to accounts with a specific role.
	/// @dev Includes proxy protection by default. When a proxy sets a signer before forwarding calls,
	///      `msg.sender` becomes the proxy address. Without the proxy check, functions would authorize
	///      based on the proxy's roles rather than the original caller's - allowing users to inherit
	///      any privileged roles held by the proxy.
	///
	///      For functions that proxies legitimately need to call (e.g., setSigner), use onlyRoleAllowProxy instead.
	modifier onlyRole(bytes32 role) {
		require(GlobalAppStorage.layout().signer == address(0), "Accessibility: Cannot call via proxy");
		require(LibAccessibility.hasRole(msg.sender, role), "Accessibility: Must have role");
		_;
	}

	/// @notice Same as onlyRole but allows calls through proxies that set a signer.
	/// @dev USE WITH CAUTION. Only use this for functions that:
	///      1. Must be callable by proxies to function correctly (e.g., setSigner for proxy context setup)
	///      2. Have been explicitly reviewed for proxy-related security implications
	///
	///      If a proxy holds the required role, any user routing calls through that proxy will pass
	///      this check. Ensure this is the intended behavior before using this modifier.
	modifier onlyRoleAllowProxy(bytes32 role) {
		require(LibAccessibility.hasRole(msg.sender, role), "Accessibility: Must have role");
		_;
	}

	modifier notLiquidatedPartyA(address partyA) {
		require(!MAStorage.layout().liquidationStatus[partyA], "Accessibility: PartyA isn't solvent");
		_;
	}

	modifier notLiquidatedPartyB(address partyB, address partyA) {
		require(!MAStorage.layout().partyBLiquidationStatus[partyB][partyA], "Accessibility: PartyB isn't solvent");
		require(!CrossPartyBStorage.layout().crossLiquidationDetails[partyB].inProgress, "Accessibility: PartyB isn't solvent");
		_;
	}

	modifier notCrossLiquidatedPartyB(address partyB) {
		require(!CrossPartyBStorage.layout().crossLiquidationDetails[partyB].inProgress, "Accessibility: PartyB isn't solvent");
		_;
	}

	modifier notLiquidated(uint256 quoteId) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(!MAStorage.layout().liquidationStatus[quote.partyA], "Accessibility: PartyA isn't solvent");
		require(!MAStorage.layout().partyBLiquidationStatus[quote.partyB][quote.partyA], "Accessibility: PartyB isn't solvent");
		require(!CrossPartyBStorage.layout().crossLiquidationDetails[quote.partyB].inProgress, "Accessibility: PartyB isn't solvent");
		require(
			quote.quoteStatus != QuoteStatus.LIQUIDATED &&
				quote.quoteStatus != QuoteStatus.LIQUIDATED_PENDING &&
				quote.quoteStatus != QuoteStatus.CLOSED,
			"Accessibility: Invalid state"
		);
		_;
	}

	modifier onlyPartyAOfQuote(uint256 quoteId) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(quote.partyA == LibSigner.getSigner(), "Accessibility: Should be partyA of quote");
		_;
	}

	modifier onlyPartyBOfQuote(uint256 quoteId) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(quote.partyB == msg.sender, "Accessibility: Should be partyB of quote");
		_;
	}

	modifier notSuspended(address user) {
		require(!AccountStorage.layout().suspendedAddresses[user], "Accessibility: Sender is Suspended");
		_;
	}

	modifier onlySuspended(address user) {
		require(AccountStorage.layout().suspendedAddresses[user], "Accessibility: User is not suspended");
		_;
	}

	modifier whenInstantModeIsNotActive(address sender) {
		require(!(TradingModeStorage.layout().instantActionsMode[sender] && !TradingModeStorage.layout().callFromInstantLayer), "Instant Mode Not Active");
		_;
	}

	modifier whenInstantModeIsActive(address sender) {
		require (TradingModeStorage.layout().instantActionsMode[sender],"Instant Mode Not Active");
		_;
	}
}
