// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IMuonSignatureVerifier } from "../interfaces/IMuonSignatureVerifier.sol";

/// @title MockMuonSignatureVerifier
/// @notice A mock implementation of IMuonSignatureVerifier for testing purposes.
/// @dev This contract accepts any signature without verification, allowing tests to run
///      without needing real Muon signatures. Should NEVER be used in production.
contract MockMuonSignatureVerifier is IMuonSignatureVerifier {
	PublicKey[] private _publicKeys;
	address[] private _gatewaySigners;

	/// @notice Accepts any signature without verification
	/// @dev This is intentionally a no-op for testing purposes
	function verify(bytes32, SchnorrSign memory, bytes calldata, uint8) external pure override {
		// Intentionally empty - accepts all signatures for testing
	}

	/// @notice Accepts any signature without verification (permissionless overload)
	function verify(bytes32, SchnorrSign memory, bytes calldata) external pure override {
		// Intentionally empty - accepts all signatures for testing
	}

	function addPublicKey(PublicKey memory pubKey) external override {
		_publicKeys.push(pubKey);
	}

	function removePublicKey(PublicKey memory pubKey) external override {
		for (uint256 i = 0; i < _publicKeys.length; i++) {
			if (_publicKeys[i].x == pubKey.x && _publicKeys[i].parity == pubKey.parity) {
				_publicKeys[i] = _publicKeys[_publicKeys.length - 1];
				_publicKeys.pop();
				break;
			}
		}
	}

	function getAllPublicKeys() external view override returns (PublicKey[] memory) {
		return _publicKeys;
	}

	function addGatewaySigner(address signer) external override {
		_gatewaySigners.push(signer);
	}

	function removeGatewaySigner(address signer) external override {
		for (uint256 i = 0; i < _gatewaySigners.length; i++) {
			if (_gatewaySigners[i] == signer) {
				_gatewaySigners[i] = _gatewaySigners[_gatewaySigners.length - 1];
				_gatewaySigners.pop();
				break;
			}
		}
	}

	function getAllGatewaySigners() external view override returns (address[] memory) {
		return _gatewaySigners;
	}

	function setPublicKeyPermissions(PublicKey memory, uint8[] calldata, bool) external override {
		// No-op for testing
	}

	function setGatewaySignerPermissions(address, uint8[] calldata, bool) external override {
		// No-op for testing
	}

	function isPublicKeyAuthorized(PublicKey memory, uint8) external pure override returns (bool) {
		return true;
	}

	function isGatewaySignerAuthorized(address, uint8) external pure override returns (bool) {
		return true;
	}

	function supportsMuonFunction(uint8) external pure override returns (bool) {
		return true;
	}
}
