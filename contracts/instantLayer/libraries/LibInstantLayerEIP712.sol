// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Account, ReplayAttackHeader, FlexField, SignedOperation, DelegationInfo, SignedDelegation } from "../InstantLayerTypes.sol";

/// @notice EIP-712 domain separator and struct hashing for the InstantLayer diamond
/// @dev The domain separator is rebuilt on every call instead of cached. Under delegatecall,
///      address(this) resolves to the diamond, which is the one stable verifyingContract every
///      facet shares; caching it anywhere (a constructor, a storage slot written once) would
///      freeze a value computed against the wrong address and invalidate every signature.
library LibInstantLayerEIP712 {
	bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
		"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
	);

	bytes32 internal constant NAME_HASH = keccak256("SymmioInstantLayer");
	bytes32 internal constant VERSION_HASH = keccak256("1");

	/// @notice EIP-712 type hash for Account struct
	bytes32 internal constant ACCOUNT_TYPEHASH = keccak256("Account(address addr,bool isPartyB)");

	/// @notice EIP-712 type hash for ReplayAttackHeader struct
	bytes32 internal constant REPLAY_HEADER_TYPEHASH = keccak256("ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)");

	/// @notice EIP-712 type hash for FlexField struct
	bytes32 internal constant FLEX_FIELD_TYPEHASH = keccak256("FlexField(uint256 offset,uint256 length,address authorizedFlexFiller)");

	/// @notice EIP-712 type hash for FlexFillAuth (flex filler signing fill values)
	bytes32 internal constant FLEX_FILL_AUTH_TYPEHASH = keccak256("FlexFillAuth(bytes32 opHash,uint256 fieldIndex,bytes value)");

	/// @notice EIP-712 type hash for SignedOperation struct (includes nested type definitions)
	bytes32 internal constant SIGNED_OPERATION_TYPEHASH = keccak256(
		abi.encodePacked(
			"SignedOperation(",
			"address signer,",
			"address target,",
			"bytes callData,",
			"Account signerAccount,",
			"FlexField[] flexFields,",
			"uint256 maxUses,",
			"ReplayAttackHeader replayAttackHeader",
			")",
			"Account(address addr,bool isPartyB)",
			"FlexField(uint256 offset,uint256 length,address authorizedFlexFiller)",
			"ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)"
		)
	);

	/// @notice EIP-712 type hash for DelegationInfo struct
	bytes32 internal constant DELEGATION_INFO_TYPEHASH = keccak256(
		"DelegationInfo(Account account,address delegatedSigner,bytes4[] selectors,uint256 expiryTimestamp)"
		"Account(address addr,bool isPartyB)"
	);

	/// @notice EIP-712 type hash for SignedDelegation struct
	bytes32 internal constant SIGNED_DELEGATION_TYPEHASH = keccak256(
		"SignedDelegation(DelegationInfo delegationInfo,ReplayAttackHeader replayAttackHeader)"
		"Account(address addr,bool isPartyB)"
		"DelegationInfo(Account account,address delegatedSigner,bytes4[] selectors,uint256 expiryTimestamp)"
		"ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)"
	);

	/// @notice The live EIP-712 domain separator for this diamond.
	/// @dev Computed per call, never cached, so it always reflects the current address(this) and
	///      block.chainid rather than values fixed at deploy or facet-init time.
	function domainSeparator() internal view returns (bytes32) {
		return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
	}

	/// @notice Calculate the EIP-712 hash for a signed operation.
	/// @param signedOp Operation to hash
	/// @return msgDigest EIP-712 compliant hash
	function hashOperation(SignedOperation memory signedOp) internal view returns (bytes32 msgDigest) {
		msgDigest = _hashTypedDataV4(
			keccak256(
				abi.encode(
					SIGNED_OPERATION_TYPEHASH,
					signedOp.signer,
					signedOp.target,
					keccak256(signedOp.callData),
					_hashAccount(signedOp.signerAccount),
					_hashFlexFields(signedOp.flexFields),
					signedOp.maxUses,
					_hashReplay(signedOp.replayAttackHeader)
				)
			)
		);
	}

	/// @notice Calculate the EIP-712 hash for a flex fill authorization.
	/// @param opHash     Hash of the flex operation being filled
	/// @param fieldIndex Index of the flex field being filled
	/// @param value      The fill value bytes
	/// @return msgDigest EIP-712 compliant hash
	function hashFlexFillAuth(bytes32 opHash, uint256 fieldIndex, bytes memory value) internal view returns (bytes32 msgDigest) {
		msgDigest = _hashTypedDataV4(keccak256(abi.encode(FLEX_FILL_AUTH_TYPEHASH, opHash, fieldIndex, keccak256(value))));
	}

	/// @notice Calculate the EIP-712 hash for a signed delegation.
	/// @param signedDelegation Delegation to hash
	/// @return msgDigest EIP-712 compliant hash
	function hashDelegation(SignedDelegation memory signedDelegation) internal view returns (bytes32 msgDigest) {
		msgDigest = _hashTypedDataV4(
			keccak256(
				abi.encode(
					SIGNED_DELEGATION_TYPEHASH,
					_hashDelegationInfo(signedDelegation.delegationInfo),
					_hashReplay(signedDelegation.replayAttackHeader)
				)
			)
		);
	}

	/// @dev Combines the live domain separator with a struct hash the way OZ's _hashTypedDataV4
	///      does, but rebuilding the domain separator on every call instead of reading a cached
	///      immutable.
	function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
		return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
	}

	/// @dev Hash a bytes4 array according to EIP-712 array encoding rules.
	/// Each bytes4 is right-padded to 32 bytes, then all are concatenated and hashed.
	function _hashBytes4Array(bytes4[] memory arr) private pure returns (bytes32) {
		if (arr.length == 0) return keccak256("");
		bytes32[] memory words = new bytes32[](arr.length);
		for (uint256 i = 0; i < arr.length; i++) {
			words[i] = bytes32(arr[i]); // Right-pad to 32 bytes
		}
		return keccak256(abi.encodePacked(words)); // Concatenate 32-byte encodings and hash once.
	}

	/// @dev Hash a DelegationInfo struct according to EIP-712.
	function _hashDelegationInfo(DelegationInfo memory d) private pure returns (bytes32) {
		return
			keccak256(
				abi.encode(DELEGATION_INFO_TYPEHASH, _hashAccount(d.account), d.delegatedSigner, _hashBytes4Array(d.selectors), d.expiryTimestamp)
			);
	}

	/// @dev Hash an Account struct according to EIP-712.
	function _hashAccount(Account memory a) private pure returns (bytes32) {
		return keccak256(abi.encode(ACCOUNT_TYPEHASH, a.addr, a.isPartyB));
	}

	/// @dev Hash a ReplayAttackHeader struct according to EIP-712.
	function _hashReplay(ReplayAttackHeader memory r) private pure returns (bytes32) {
		return keccak256(abi.encode(REPLAY_HEADER_TYPEHASH, r.nonce, r.deadline, r.salt));
	}

	/// @dev Hash a FlexField array according to EIP-712 array encoding rules.
	function _hashFlexFields(FlexField[] memory fields) private pure returns (bytes32) {
		bytes32[] memory fieldHashes = new bytes32[](fields.length);
		for (uint256 i = 0; i < fields.length; i++) {
			fieldHashes[i] = keccak256(abi.encode(FLEX_FIELD_TYPEHASH, fields[i].offset, fields[i].length, fields[i].authorizedFlexFiller));
		}
		return keccak256(abi.encodePacked(fieldHashes));
	}
}
