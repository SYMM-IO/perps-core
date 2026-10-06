// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Bot-signed payload that authorizes promoting an already-ACCEPTED STANDARD
///         withdrawal into WINDOWED-style processing once the affiliate credit cap has
///         freed up. Covered by a SIGNER_ROLE ECDSA signature bound via EIP-712 to
///         `(user, requestId, nonce, affiliateAmount, creditAmount, accelerationFee, partsHash, deadline)`.
struct AccelerateOffer {
	uint256 nonce;
	uint256 affiliateAmount;
	uint256 creditAmount;
	uint256 accelerationFee;
	uint256 deadline;
	bytes signature;
}
