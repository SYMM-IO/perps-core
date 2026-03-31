// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AffiliateConfig, SponsorConfig } from "../types/ConfigTypes.sol";

/// @title FeeStorage
/// @notice Diamond storage for fee configuration, collected fees, and sponsorship.
library FeeStorage {
	bytes32 internal constant STORAGE_SLOT = keccak256("diamond.standard.storage.fee");

	struct Layout {
		// ── Fee configuration ──
		mapping(address => AffiliateConfig) affiliateConfigs;
		mapping(address => uint256) collectedFees;
		mapping(address => uint256) collectedOperatorFees;
		mapping(address => mapping(uint256 => uint256)) operatorFees;
		// ── Sponsorship ──
		mapping(address => uint256) sponsorBalances;
		mapping(address => address) sponsors;
		mapping(address => SponsorConfig) sponsorConfigs;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
