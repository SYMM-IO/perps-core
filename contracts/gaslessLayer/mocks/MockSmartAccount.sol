// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Test stand-in for a smart account such as Coinbase Smart Wallet. It accepts the account's
///         wrapped signature format and applies the account-specific replay-safe digest, so neither a
///         bare owner signature nor a wrapped signature over the unwrapped digest is accepted.
contract MockSmartAccount is IERC1271 {
	bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
	bytes32 private constant EIP712_NAME_HASH = keccak256("Coinbase Smart Wallet");
	bytes32 private constant EIP712_VERSION_HASH = keccak256("1");
	bytes32 private constant MESSAGE_TYPEHASH = keccak256("CoinbaseSmartWalletMessage(bytes32 hash)");

	/// @dev Mirrors Coinbase Smart Wallet's SignatureWrapper: the owner slot plus the owner's signature bytes.
	struct SignatureWrapper {
		uint256 ownerIndex;
		bytes signatureData;
	}

	address public immutable owner;

	constructor(address owner_) {
		owner = owner_;
	}

	receive() external payable {}

	function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
		SignatureWrapper memory wrapper = abi.decode(signature, (SignatureWrapper));
		if (wrapper.ownerIndex != 0) return bytes4(0xffffffff);
		(address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(replaySafeHash(hash), wrapper.signatureData);
		return err == ECDSA.RecoverError.NoError && recovered == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
	}

	/// @notice Apply Coinbase Smart Wallet's account-specific anti-replay envelope to an external digest.
	function replaySafeHash(bytes32 hash) public view returns (bytes32) {
		bytes32 domainSeparator = keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this)));
		return keccak256(abi.encodePacked("\x19\x01", domainSeparator, keccak256(abi.encode(MESSAGE_TYPEHASH, hash))));
	}
}
