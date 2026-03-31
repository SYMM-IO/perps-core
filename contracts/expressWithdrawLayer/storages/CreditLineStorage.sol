// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title CreditLineStorage
/// @notice Diamond storage layout for per-affiliate credit line state.
/// @dev Uses a unique keccak256 slot to avoid collisions with other diamond storage.
library CreditLineStorage {
	bytes32 internal constant STORAGE_SLOT = keccak256("diamond.standard.storage.creditline");

	struct AffiliateCredit {
		// ── Protocol-set hard caps ──
		uint256 protocolMaxDebt;
		uint256 protocolMaxDebtBps;
		// ── Affiliate-chosen stricter caps ──
		uint256 affiliateMaxDebt;
		uint256 affiliateMaxDebtBps;
		// ── Debt tracking ──
		uint256 reservedDebt;
		uint256 activeDebt;
		mapping(bytes32 => uint256) requestDebt;
		mapping(bytes32 => bool) requestActivated;
		// ── State ──
		bool paused;
		mapping(address => bool) blacklisted;
	}

	struct Layout {
		// ── Global Muon config (protocol-level) ──
		address signatureVerifier;
		uint256 muonAppId;
		uint256 muonFreshnessWindow;
		// ── Per-affiliate credit config and debt state ──
		mapping(address => AffiliateCredit) affiliates;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
