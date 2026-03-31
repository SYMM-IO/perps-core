// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IMuonSignatureVerifier } from "../../core/interfaces/IMuonSignatureVerifier.sol";

/// @notice Per-affiliate credit line config and debt state.
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

/// @notice Muon-signed attestation of an affiliate's eligible balance base.
/// @dev The Muon oracle computes freeEligible + haircutted(allocatedEligible) - excludedEligible
///      off-chain and delivers the result as `eligibleBase`. No on-chain haircut math.
struct CreditData {
	bytes reqId;
	uint256 eligibleBase;
	uint256 timestamp;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}
