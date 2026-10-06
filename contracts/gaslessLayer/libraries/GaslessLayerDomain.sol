// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title GaslessLayerDomain
/// @notice Shared EIP-712 domain for wallet operations and native gas top-ups.
/// @dev The legacy name "GaslessGateway" keeps existing signatures valid.
///      Internal functions inline into their callers and require no separate deployment or library link.
///      The signing libraries call them through the gateway's delegatecall context, where `address(this)`
///      is the gateway proxy. Both signing paths therefore use the proxy address and the same domain separator.
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
