// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IMuonSignatureVerifier, MuonFunction } from "../interfaces/IMuonSignatureVerifier.sol";

/// @dev Test-only verifier that accepts exactly one expected Muon payload hash.
contract HashCheckingMuonSignatureVerifier is IMuonSignatureVerifier {
	bytes32 public expectedHash;

	function setExpectedHash(bytes32 hash) external {
		expectedHash = hash;
	}

	function verify(bytes32 hash, SchnorrSign memory, bytes calldata, MuonFunction) external view override {
		require(hash == expectedHash, "HashCheckingMuonSignatureVerifier: unexpected hash");
	}

	function verify(bytes32 hash, SchnorrSign memory, bytes calldata) external view override {
		require(hash == expectedHash, "HashCheckingMuonSignatureVerifier: unexpected hash");
	}

	function addPublicKey(PublicKey memory) external override {}

	function removePublicKey(PublicKey memory) external override {}

	function getAllPublicKeys() external pure override returns (PublicKey[] memory publicKeys) {}

	function addGatewaySigner(address) external override {}

	function removeGatewaySigner(address) external override {}

	function getAllGatewaySigners() external pure override returns (address[] memory gatewaySigners) {}

	function setPublicKeyPermissions(PublicKey memory, MuonFunction[] calldata, bool) external override {}

	function setGatewaySignerPermissions(address, MuonFunction[] calldata, bool) external override {}

	function isPublicKeyAuthorized(PublicKey memory, MuonFunction) external pure override returns (bool) {
		return true;
	}

	function isGatewaySignerAuthorized(address, MuonFunction) external pure override returns (bool) {
		return true;
	}
}
