// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title PoolStorage
/// @notice Diamond storage for general and affiliate liquidity pools.
library PoolStorage {
	bytes32 internal constant STORAGE_SLOT = keccak256("diamond.standard.storage.pool");

	struct Layout {
		uint256 generalBalance;
		uint256 lockedGeneralBalance;
		mapping(address => uint256) affiliateBalances;
		mapping(address => uint256) lockedAffiliateBalances;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
