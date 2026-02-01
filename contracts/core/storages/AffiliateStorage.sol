// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Fee } from "./QuoteStorage.sol";

/// @title AffiliateStorage
/// @notice Affiliate fee configuration and custom fee overrides
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library AffiliateStorage {
	bytes32 internal constant AFFILIATE_STORAGE_SLOT = keccak256("diamond.standard.storage.affiliate");

	struct Layout {
		/// @notice Floor for affiliate trading fees (in 18 decimals)
		/// @dev Prevents affiliates from setting fees below this threshold. Ensures minimum
		///      protocol revenue. Set as a percentage (e.g., 1e16 = 1%). Checked when
		///      affiliates configure their fee structure.
		uint256 minAffiliateFee;
		/// @notice Trading fee configuration per affiliate and symbol
		/// @dev Maps affiliate => symbolId => Fee struct (openFee, closeFee, isSet).
		///      If isSet is false, falls back to symbol's default fee. Enables affiliates
		///      to offer custom fee tiers to their users.
		mapping(address => mapping(uint256 => Fee)) affiliateFee;
		/// @notice Custom fee overrides per affiliate, per user, per symbol
		/// @dev Maps affiliate => user => symbolId => Fee. Enables VIP tiers or promotional
		///      rates for specific users. Takes precedence over affiliateFee when set.
		mapping(address => mapping(address => mapping(uint256 => Fee))) customAffiliateFee;
		/// @notice Hook contracts called on protocol events per affiliate
		/// @dev Called on onOpenPosition, onClosePosition, onCancelQuote events.
		///      address(0) key is the system-wide hook. Enables custom integrations.
		mapping(address => address) affiliateHooks;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = AFFILIATE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
