// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IMuonSignatureVerifier } from "../../core/interfaces/IMuonSignatureVerifier.sol";

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
