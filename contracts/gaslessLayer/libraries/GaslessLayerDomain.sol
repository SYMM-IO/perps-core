// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

/// @title GaslessLayerDomain
/// @notice Single source of the layer's EIP-712 domain.
/// @dev The legacy name "GaslessGateway" is intentionally preserved so existing signatures remain valid.
/// @dev Internal-only, so every function inlines into its caller — no new deploy artifact and no
///      change to the linked-library graph. Called from the linked signing libraries in the gateway's
///      delegatecall context, so `address(this)` resolves to the gateway proxy and the domain separator
///      matches the gateway's own address. Centralizing the domain here is what stops the two signing
///      libraries (wallet operations and native gas top-ups) from silently drifting to different domain
///      separators, which would split the signing domain and break signatures on one path.
library GaslessLayerDomain {
	bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
		"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
	);
	bytes32 internal constant EIP712_NAME_HASH = keccak256("GaslessGateway");
	bytes32 internal constant EIP712_VERSION_HASH = keccak256("1");

	/// @dev keccak256(abi.encode(typehash, name, version, chainId, verifyingContract=address(this))).
	function domainSeparator() internal view returns (bytes32) {
		return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this)));
	}

	/// @dev Full EIP-712 digest for a struct hash: keccak256("\x19\x01" || domainSeparator || structHash).
	function hashTypedData(bytes32 structHash) internal view returns (bytes32) {
		return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
	}
}
