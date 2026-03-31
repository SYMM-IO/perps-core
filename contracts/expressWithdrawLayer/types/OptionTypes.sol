// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Decoded fields from the bot's EIP-712 signed option payload.
struct DecodedOption {
	uint256 nonce;
	uint8 optionType;
	uint256 availableAt;
	address affiliate;
	uint256 affiliateAmount;
	uint256 creditAmount;
	uint256 fee;
	uint256 operatorFee;
	uint256 maxUserFee;
	uint256 deadline;
	bytes signature;
}

/// @notice Breakdown of withdrawal amounts by funding source.
struct ComputedAmounts {
	uint256 expressAmount;
	uint256 generalAmount;
}
