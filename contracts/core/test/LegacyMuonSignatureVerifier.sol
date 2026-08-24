// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @dev Models a verifier deployed before the explicit forward-compatible capability API.
enum LegacyMuonFunction {
	Trading,
	AccountManagement,
	Settlement,
	ForceClose,
	Funding,
	LiquidationPartyA,
	LiquidationPartyB,
	RemoveMargin
}

contract LegacyMuonSignatureVerifier {
	function isGatewaySignerAuthorized(address, LegacyMuonFunction) external pure returns (bool) {
		return true;
	}
}
