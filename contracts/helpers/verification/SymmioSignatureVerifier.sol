// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { AccessControlEnumerable } from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import { LibMuonV04ClientBase } from "./LibMuonV04ClientBase.sol";
import { IMuonSignatureVerifier } from "../../core/interfaces/IMuonSignatureVerifier.sol";

/// @notice Verifies Muon TSS signatures and gateway signatures for oracle data
contract MuonSignatureVerifier is IMuonSignatureVerifier, AccessControlEnumerable {
	using ECDSA for bytes32;

	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Emitted when a new TSS public key is added
	event PublicKeyAdded(uint256 x, uint8 parity);
	/// @notice Emitted when a TSS public key is removed
	event PublicKeyRemoved(uint256 x, uint8 parity);
	/// @notice Emitted when a new gateway signer is added
	event GatewaySignerAdded(address signer);
	/// @notice Emitted when a gateway signer is removed
	event GatewaySignerRemoved(address signer);
	/// @notice Emitted when TSS public key function permissions are updated
	event PublicKeyPermissionsUpdated(uint256 x, uint8 parity, uint8[] functionIds, bool allowed);
	/// @notice Emitted when gateway signer function permissions are updated
	event GatewaySignerPermissionsUpdated(address signer, uint8[] functionIds, bool allowed);

	PublicKey[] public publicKeys;
	address[] public gatewaySigners;

	/// @notice Per-function authorization for TSS public keys: keccak256(x, parity) => function ID => allowed
	mapping(bytes32 => mapping(uint8 => bool)) public publicKeyPermissions;
	/// @notice Per-function authorization for gateway signers: address => function ID => allowed
	mapping(address => mapping(uint8 => bool)) public gatewaySignerPermissions;

	/// @notice Initializes the verifier with an admin address
	/// @param _admin The address that receives DEFAULT_ADMIN_ROLE and SETTER_ROLE
	constructor(address _admin) {
		_setupRole(DEFAULT_ADMIN_ROLE, _admin);
		_setupRole(SETTER_ROLE, _admin);
	}

	/// @notice Computes a unique identifier for a public key
	function _publicKeyId(PublicKey memory pubKey) internal pure returns (bytes32) {
		return keccak256(abi.encodePacked(pubKey.x, pubKey.parity));
	}

	/// @notice Verifies both the TSS Schnorr signature and the gateway ECDSA signature,
	///         and checks that both the signing key and gateway are authorized for the given category
	/// @param hash The hash of the signed data
	/// @param sign The Schnorr signature to verify against registered public keys
	/// @param gatewaySignature The ECDSA gateway signature to verify
	/// @param functionId The operation category requesting verification
	function verify(bytes32 hash, SchnorrSign memory sign, bytes memory gatewaySignature, uint8 functionId) external view {
		// Verify TSS via Muon
		bool verifiedTSS = false;
		for (uint256 i = 0; i < publicKeys.length; i++) {
			if (LibMuonV04ClientBase.muonVerify(uint256(hash), sign, publicKeys[i])) {
				require(publicKeyPermissions[_publicKeyId(publicKeys[i])][functionId], "MuonSignatureVerifier: Key not authorized for function");
				verifiedTSS = true;
				break;
			}
		}
		require(verifiedTSS, "MuonSignatureVerifier: TSS not verified");

		// Verify Gateway Signature
		address signer = hash.toEthSignedMessageHash().recover(gatewaySignature);
		bool gatewayVerified = false;
		for (uint256 i = 0; i < gatewaySigners.length; i++) {
			if (signer == gatewaySigners[i]) {
				require(gatewaySignerPermissions[signer][functionId], "MuonSignatureVerifier: Gateway not authorized for function");
				gatewayVerified = true;
				break;
			}
		}
		require(gatewayVerified, "MuonSignatureVerifier: Gateway is not valid");
	}

	/// @notice Verifies the TSS and gateway signatures without per-category authorization checks
	/// @param hash The hash of the signed data
	/// @param sign The Schnorr signature to verify against registered public keys
	/// @param gatewaySignature The ECDSA gateway signature to verify
	function verify(bytes32 hash, SchnorrSign memory sign, bytes memory gatewaySignature) external view {
		// Verify TSS via Muon
		bool verifiedTSS = false;
		for (uint256 i = 0; i < publicKeys.length; i++) {
			if (LibMuonV04ClientBase.muonVerify(uint256(hash), sign, publicKeys[i])) {
				verifiedTSS = true;
				break;
			}
		}
		require(verifiedTSS, "MuonSignatureVerifier: TSS not verified");

		// Verify Gateway Signature
		address signer = hash.toEthSignedMessageHash().recover(gatewaySignature);
		bool gatewayVerified = false;
		for (uint256 i = 0; i < gatewaySigners.length; i++) {
			if (signer == gatewaySigners[i]) {
				gatewayVerified = true;
				break;
			}
		}
		require(gatewayVerified, "MuonSignatureVerifier: Gateway is not valid");
	}

	/// @notice Adds a new TSS public key for signature verification
	/// @param pubKey The public key to add
	function addPublicKey(PublicKey memory pubKey) external onlyRole(SETTER_ROLE) {
		publicKeys.push(pubKey);
		emit PublicKeyAdded(pubKey.x, pubKey.parity);
	}

	/// @notice Removes a TSS public key from the registered keys
	/// @param pubKey The public key to remove
	/// @dev Reverts if the key is not found
	function removePublicKey(PublicKey memory pubKey) external onlyRole(SETTER_ROLE) {
		bool found = false;
		for (uint256 i = 0; i < publicKeys.length; i++) {
			if (publicKeys[i].x == pubKey.x && publicKeys[i].parity == pubKey.parity) {
				publicKeys[i] = publicKeys[publicKeys.length - 1];
				publicKeys.pop();
				found = true;
				break;
			}
		}
		require(found, "MuonSignatureVerifier: public key not found");
		emit PublicKeyRemoved(pubKey.x, pubKey.parity);
	}

	/// @notice Returns all registered TSS public keys
	/// @return Array of all public keys
	function getAllPublicKeys() external view returns (PublicKey[] memory) {
		return publicKeys;
	}

	/// @notice Adds a new gateway signer address
	/// @param signer The address of the gateway signer to add
	function addGatewaySigner(address signer) external onlyRole(SETTER_ROLE) {
		gatewaySigners.push(signer);
		emit GatewaySignerAdded(signer);
	}

	/// @notice Removes a gateway signer address
	/// @param signer The address of the gateway signer to remove
	function removeGatewaySigner(address signer) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < gatewaySigners.length; i++) {
			if (gatewaySigners[i] == signer) {
				gatewaySigners[i] = gatewaySigners[gatewaySigners.length - 1];
				gatewaySigners.pop();
				break;
			}
		}
		emit GatewaySignerRemoved(signer);
	}

	/// @notice Returns all registered gateway signer addresses
	/// @return Array of all gateway signer addresses
	function getAllGatewaySigners() external view returns (address[] memory) {
		return gatewaySigners;
	}

	/// @notice Sets function-level permissions for a TSS public key
	/// @param pubKey The public key to configure
	/// @param functionIds The list of function category IDs to set permissions for
	/// @param allowed Whether the key is authorized for these functions
	function setPublicKeyPermissions(PublicKey memory pubKey, uint8[] calldata functionIds, bool allowed) external onlyRole(SETTER_ROLE) {
		bytes32 keyId = _publicKeyId(pubKey);
		for (uint256 i = 0; i < functionIds.length; i++) {
			publicKeyPermissions[keyId][functionIds[i]] = allowed;
		}
		emit PublicKeyPermissionsUpdated(pubKey.x, pubKey.parity, functionIds, allowed);
	}

	/// @notice Sets function-level permissions for a gateway signer
	/// @param signer The gateway signer address to configure
	/// @param functionIds The list of function category IDs to set permissions for
	/// @param allowed Whether the signer is authorized for these functions
	function setGatewaySignerPermissions(address signer, uint8[] calldata functionIds, bool allowed) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < functionIds.length; i++) {
			gatewaySignerPermissions[signer][functionIds[i]] = allowed;
		}
		emit GatewaySignerPermissionsUpdated(signer, functionIds, allowed);
	}

	/// @notice Checks if a TSS public key is authorized for a specific function
	/// @param pubKey The public key to check
	/// @param functionId The function category ID to check authorization for
	/// @return True if the key is authorized
	function isPublicKeyAuthorized(PublicKey memory pubKey, uint8 functionId) external view returns (bool) {
		return publicKeyPermissions[_publicKeyId(pubKey)][functionId];
	}

	/// @notice Checks if a gateway signer is authorized for a specific function
	/// @param signer The gateway signer address to check
	/// @param functionId The function category ID to check authorization for
	/// @return True if the signer is authorized
	function isGatewaySignerAuthorized(address signer, uint8 functionId) external view returns (bool) {
		return gatewaySignerPermissions[signer][functionId];
	}

	/// @inheritdoc IMuonSignatureVerifier
	/// @dev All uint8 IDs use the same permission and verification path. New IDs default
	///      to unauthorized until SETTER_ROLE explicitly grants both signer permissions.
	function supportsMuonFunction(uint8) external pure returns (bool) {
		return true;
	}
}
