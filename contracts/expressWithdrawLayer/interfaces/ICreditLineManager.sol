// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { CreditData } from "../types/CreditTypes.sol";

/// @title ICreditLineManager
/// @notice Interface for per-affiliate credit line management.
///         Called exclusively by ExpressProvider to reserve, activate, settle, and cancel credit.
interface ICreditLineManager {
	/// @notice Reserves credit for a pending withdrawal. Validates Muon data and caps.
	/// @param user The withdrawing user (used for blacklist check and request key).
	/// @param requestId The SYMMIO withdrawal request ID.
	/// @param creditAmount Amount of credit to reserve.
	/// @param data Muon-signed affiliate-level eligible balance attestation.
	function reserveDebt(address user, uint256 requestId, uint256 creditAmount, CreditData calldata data) external;

	/// @notice Moves reserved debt to active. Called when funds are actually advanced.
	/// @param user The withdrawing user.
	/// @param requestId The SYMMIO withdrawal request ID.
	function activateDebt(address user, uint256 requestId) external;

	/// @notice Clears active debt after successful finalization.
	/// @param user The withdrawing user.
	/// @param requestId The SYMMIO withdrawal request ID.
	function settleDebt(address user, uint256 requestId) external;

	/// @notice Clears reserved debt on cancel/suspend before payout.
	/// @param user The withdrawing user.
	/// @param requestId The SYMMIO withdrawal request ID.
	function cancelReservation(address user, uint256 requestId) external;

	/// @notice Returns total outstanding debt (reserved + active).
	function totalDebt() external view returns (uint256);
}
