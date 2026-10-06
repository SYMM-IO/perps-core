// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IMuonSignatureVerifier } from "../../core/interfaces/IMuonSignatureVerifier.sol";

/// @notice Per-affiliate credit line config and debt state.
struct AffiliateCredit {
	// ── Protocol-set hard caps ──
	/// @dev Absolute ceiling (token units) the protocol allows this affiliate to owe. 0 = uncapped.
	uint256 protocolMaxDebt;
	/// @dev Percentage ceiling (bps of eligibleBase) the protocol allows. 0 = uncapped.
	uint256 protocolMaxDebtBps;
	// ── Affiliate-chosen stricter caps ──
	/// @dev Optional tighter absolute cap the affiliate self-imposes (must be <= protocolMaxDebt).
	uint256 affiliateMaxDebt;
	/// @dev Optional tighter percentage cap the affiliate self-imposes (must be <= protocolMaxDebtBps).
	uint256 affiliateMaxDebtBps;
	// ── Debt tracking ──
	/// @dev Sum of credit amounts earmarked for withdrawals that have been requested but not yet paid out.
	uint256 reservedDebt;
	/// @dev Sum of credit amounts for withdrawals already paid out to users, awaiting settlement from core.
	uint256 activeDebt;
	/// @dev Per-request credit amount. Key = keccak256(user, requestId).
	mapping(bytes32 => uint256) requestDebt;
	/// @dev Whether a request's debt has moved from reserved to active. Key = keccak256(user, requestId).
	mapping(bytes32 => bool) requestActivated;
	// ── State ──
	/// @dev Affiliate-level kill switch. When true, it blocks all new credit reservations.
	bool paused;
	/// @dev Per-user exclusion list. Blocked addresses cannot reserve credit with this affiliate.
	mapping(address => bool) blacklisted;
	// ── Cap-change throttle state ──
	/// @dev Number of non-free cap changes performed within the current window.
	uint256 capChangeCount;
	/// @dev Timestamp when the current quota window started.
	uint256 capChangeEpochStart;
	// ── Bad debt tracking ──
	/// @dev Unrecovered credit loss accrued when coverLoss could not fully deduct from the affiliate pool.
	uint256 badDebt;
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
