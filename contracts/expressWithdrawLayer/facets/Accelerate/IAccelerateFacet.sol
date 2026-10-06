// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../../core/storages/WithdrawStorage.sol";

interface IAccelerateEvents {
	/// @notice Emitted when an ACCEPTED STANDARD withdrawal is promoted to WINDOWED-style
	///         processing and paid out without waiting for cooldown.
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
	/// @notice Promote an ACCEPTED STANDARD withdrawal into WINDOWED-style processing.
	///         Any caller with a valid bot-signed offer may invoke this permissionless function.
	/// @dev Reverts atomically on cap breach, leaving the STANDARD state intact so the bot
	///      or the frontend can retry later with the same signature once capacity frees up.
	///      When the affiliate's effective minValidatorSignatures > 0, `validatorData` must
	///      carry a quorum of `ValidatorAccelerateApproval` signatures over the frozen request
	///      (user, requestId, partsHash), each within the validator approval timeout.
	function accelerateWithdraw(
		address user,
		uint256 requestId,
		WithdrawReceiverPart[] calldata parts,
		bytes calldata accelerateOfferData,
		bytes calldata validatorData,
		bytes calldata creditDataRaw
	) external;
}
