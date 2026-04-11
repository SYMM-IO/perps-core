// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../../core/storages/WithdrawStorage.sol";

interface IAccelerateEvents {
	/// @notice Emitted when an ACCEPTED STANDARD withdrawal is promoted to INSTANT-style
	///         processing and immediately paid out to the user.
	event WithdrawAccelerated(
		address indexed user,
		uint256 indexed requestId,
		address indexed affiliate,
		uint256 affiliateAmount,
		uint256 creditAmount,
		uint256 generalAmount
	);
}

interface IAccelerateFacet is IAccelerateEvents {
	/// @notice Promote an ACCEPTED STANDARD withdrawal into INSTANT-style processing.
	///         Permissionless — any caller with a valid bot-signed offer may invoke.
	/// @dev Reverts atomically on cap breach, leaving the STANDARD state intact so the bot
	///      or the frontend can retry later with the same signature once capacity frees up.
	function accelerateWithdraw(
		address user,
		uint256 requestId,
		WithdrawReceiverPart[] calldata parts,
		bytes calldata accelerateOfferData,
		bytes calldata creditDataRaw
	) external;
}
