// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

/// @notice Interface for the Muon oracle signature verification contract
interface IMuonSignatureVerifier {
	/// @notice Compressed elliptic curve public key for Muon TSS verification
	struct PublicKey {
		uint256 x;
		uint8 parity;
	}

	/// @notice Schnorr signature components produced by the Muon TSS network
	struct SchnorrSign {
		uint256 signature;
		address owner;
		address nonce;
	}

	/// @notice Verifies a Muon TSS Schnorr signature with gateway co-signature
	/// @param hash The message hash that was signed
	/// @param sign The Schnorr signature components
	/// @param gatewaySignature The gateway co-signature for additional verification
	function verify(bytes32 hash, SchnorrSign memory sign, bytes calldata gatewaySignature) external view;

	/// @notice Adds a new TSS public key to the set of valid signing keys
	/// @param pubKey The compressed public key to add
	function addPublicKey(PublicKey memory pubKey) external;

	/// @notice Removes a TSS public key from the set of valid signing keys
	/// @param pubKey The compressed public key to remove
	function removePublicKey(PublicKey memory pubKey) external;

	/// @notice Returns all currently registered TSS public keys
	/// @return Array of all valid public keys
	function getAllPublicKeys() external view returns (PublicKey[] memory);

	/// @notice Adds an address authorized to co-sign as a gateway
	/// @param signer The gateway signer address to add
	function addGatewaySigner(address signer) external;

	/// @notice Removes an address from the authorized gateway signers
	/// @param signer The gateway signer address to remove
	function removeGatewaySigner(address signer) external;

	/// @notice Returns all currently registered gateway signer addresses
	/// @return Array of all authorized gateway signer addresses
	function getAllGatewaySigners() external view returns (address[] memory);
}
