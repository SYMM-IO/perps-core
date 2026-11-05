// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

// File-level struct definitions shared by InstantLayer facets. Field order is load-bearing:
// EIP-712 struct hashing is positional.

/// @notice Represents an account context for operations.
/// @dev    isPartyB decides between AccountLayer and PartyB.
/// @param addr         The actual account address (PartyA account or PartyB address)
/// @param isPartyB     Whether this operation targets a PartyB or not
struct Account {
	address addr;
	bool isPartyB;
}

/// @notice Header containing anti-replay protection parameters.
/// @dev    Provides flexible replay protection through salt and optional nonce.
/// @param nonce    Sequential counter (0 = disabled/salt-only, >0 = enforced ordering)
/// @param deadline UNIX timestamp after which the operation expires
/// @param salt     Unique 32-byte value for operation uniqueness (always required)
struct ReplayAttackHeader {
	uint256 nonce;
	uint256 deadline;
	bytes32 salt;
}

/// @notice Defines a modifiable region within operation calldata.
/// @dev    Each flex field allows an authorized flex filler to replace bytes at a specific offset.
/// @param offset   Byte offset in calldata (after 4-byte selector) where replacement starts
/// @param length   Number of bytes to replace (typically 32)
/// @param authorizedFlexFiller Address authorized to provide the replacement value for this field
struct FlexField {
	uint256 offset;
	uint256 length;
	address authorizedFlexFiller;
}

/// @notice Represents a signed operation ready for execution.
/// @dev    This structure is signed via EIP-712 for secure off-chain authorization.
/// @param signer             Address that signed this operation (may be delegated)
/// @param target             Contract to execute the call against
/// @param callData           Encoded function call to execute
/// @param signerAccount      Account context for the operation
/// @param flexFields         Modifiable regions in calldata (empty for standard operations)
/// @param maxUses            Maximum execution count (1=single-use, 0=unlimited)
/// @param replayAttackHeader Anti-replay protection parameters
struct SignedOperation {
	address signer;
	address target;
	bytes callData;
	Account signerAccount;
	FlexField[] flexFields;
	uint256 maxUses;
	ReplayAttackHeader replayAttackHeader;
}

/// @notice Container for delegation authorization with signature.
/// @param delegationInfo     Delegation parameters and permissions
/// @param replayAttackHeader Anti-replay protection for the delegation
struct SignedDelegation {
	DelegationInfo delegationInfo;
	ReplayAttackHeader replayAttackHeader;
}

/// @notice Defines delegation permissions from one address to another.
/// @param account           The account granting delegation
/// @param delegatedSigner   Address authorized to act on behalf of the account
/// @param selectors         Function selectors the delegate can execute
/// @param expiryTimestamp   UNIX timestamp when delegation expires
struct DelegationInfo {
	Account account;
	address delegatedSigner;
	bytes4[] selectors;
	uint256 expiryTimestamp;
}

/// @notice Configuration for result injection between operations.
/// @dev    Enables chaining operation results within templates.
///         IMPORTANT: Only 32-byte return values are supported (uint256, address, bytes32, bool, etc.).
///         For functions returning tuples like (uint256, uint256), use sourceOffsets to specify
///         which 32-byte slot to extract (e.g., offset 0 for first value, 32 for second).
/// @param insertionPoints Array of byte offsets where results should be inserted in calldata
/// @param sourceIndices   Array of operation indices whose results to inject
/// @param sourceOffsets   Array of byte offsets within each source result to extract the 32-byte value
struct Operation {
	uint256[] insertionPoints;
	uint256[] sourceIndices;
	uint256[] sourceOffsets;
}

/// @notice Template definition for complex multi-operation sequences.
/// @param name       Human-readable identifier for the template
/// @param operations Array of operations with their injection configurations
/// @param active     Whether this template can currently be executed
struct Template {
	string name;
	Operation[] operations;
	bool active;
}
