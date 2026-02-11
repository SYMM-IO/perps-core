// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Interface for verifying ECDSA and EIP-1271 smart contract signatures
interface ISignatureVerifier {
	/// @notice Verifies that a signature was produced by the given signer address
	/// @param signer The expected signer address
	/// @param hash The message hash that was signed
	/// @param signature The signature bytes to verify
	/// @return True if the signature is valid for the given signer
	function verifySignature(address signer, bytes32 hash, bytes calldata signature) external view returns (bool);

	/// @notice Validates a signature using the EIP-1271 standard for smart contract wallets
	/// @param hash The message hash that was signed
	/// @param signature The signature bytes to validate
	/// @param signer The smart contract address to validate against
	/// @return The EIP-1271 magic value if valid, zero otherwise
	function isValidSignatureEIP1271(bytes32 hash, bytes calldata signature, address signer) external view returns (bytes4);
}
