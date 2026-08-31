// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { GaslessWallet } from "../GaslessWallet.sol";
import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";

/// @title GaslessWalletDeployerLib
/// @notice Linked CREATE2 address derivation and lazy deployment for GaslessLayer wallets.
/// @dev Called through the gateway's linked-library delegatecall path. `address(this)` intentionally
///      resolves to the gateway proxy during normal execution, preserving the existing CREATE2 deployer
///      address across implementation upgrades.
library GaslessWalletDeployerLib {
	uint256 internal constant GASLESS_WALLET_VERSION = 1;

	/// @dev keccak256(type(GaslessWallet).creationCode). Pinned so CREATE2 derivation on the hot path
	///      skips re-hashing the full ~2KB initcode on every call. This is part of every deposit address, so
	///      it is frozen. Guarded on both ends: test/gasless-wallet-invariants.test.ts pins it to the
	///      golden bytecode hash, and getOrDeployGaslessWallet's runtime address-mismatch revert fires if it
	///      ever diverges from the actually-deployed bytecode. Update only alongside a deliberate wallet
	///      version change (which mints new addresses for all future users).
	bytes32 internal constant GASLESS_WALLET_INIT_CODE_HASH = 0x3f601fa99034209285834aabec34f49354849bbf4fdfdbb92b51f5f9b5064f31;

	// ───────────────────── External Entrypoints ───────────────────

	function getGaslessWalletAddress(address ownerWallet) external view returns (address) {
		return _getGaslessWalletAddress(address(this), ownerWallet);
	}

	function getOrDeployGaslessWallet(address ownerWallet) external returns (GaslessWallet wallet, bool deployed) {
		address predicted = _getGaslessWalletAddress(address(this), ownerWallet);
		if (predicted.code.length == 0) {
			GaslessWallet deployedWallet = new GaslessWallet{ salt: _gaslessWalletSalt(ownerWallet) }();
			if (address(deployedWallet) != predicted) revert IGaslessLayer.GaslessWalletAddressMismatch();
			return (deployedWallet, true);
		}
		return (GaslessWallet(payable(predicted)), false);
	}

	// ─────────────────────────── Helpers ──────────────────────────

	function _getGaslessWalletAddress(address deployer, address ownerWallet) internal pure returns (address) {
		bytes32 salt = _gaslessWalletSalt(ownerWallet);
		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, GASLESS_WALLET_INIT_CODE_HASH)))));
	}

	function _gaslessWalletSalt(address ownerWallet) internal pure returns (bytes32) {
		// Keep the original salt tag so renaming the contract does not move existing deposit addresses.
		return keccak256(abi.encode("GaslessQWallet", GASLESS_WALLET_VERSION, ownerWallet));
	}
}
