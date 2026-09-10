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

	/// @dev Frozen keccak256(type(GaslessWallet).creationCode), shared by prediction and deployment.
	///      GaslessLayerInvariants.behavior.ts pins the bytecode hash; deployment verifies the resulting address.
	///      Changing the wallet bytecode or salt scheme changes predicted deposit addresses.
	bytes32 internal constant GASLESS_WALLET_INIT_CODE_HASH = 0x3f601fa99034209285834aabec34f49354849bbf4fdfdbb92b51f5f9b5064f31;

	// ───────────────────── External Entrypoints ───────────────────

	/// @notice Predict the owner's index-zero GaslessWallet address without deploying it.
	/// @dev Called through the gateway so address(this) is the CREATE2 deployer.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @return Predicted GaslessWallet address.
	function getGaslessWalletAddress(address owner) external view returns (address) {
		return _getGaslessWalletAddress(address(this), owner);
	}

	/// @notice Predict the owner's selected GaslessWallet address without deploying it.
	/// @dev Called through the gateway so address(this) is the CREATE2 deployer.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @return Predicted GaslessWallet address.
	function getWalletAddress(address owner, uint256 walletId) external view returns (address) {
		return _walletAddress(owner, walletId);
	}

	/// @notice Return the selected GaslessWallet, deploying it if needed.
	/// @dev Preserves the original salt at index zero. Emits GaslessWalletDeployed only on deployment, for every index.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @return wallet Selected GaslessWallet instance.
	/// @return deployed Whether this call deployed the wallet.
	function getOrDeployGaslessWallet(address owner, uint256 walletId) external returns (GaslessWallet wallet, bool deployed) {
		address predicted = _walletAddress(owner, walletId);
		if (predicted.code.length == 0) {
			wallet = new GaslessWallet{ salt: _walletSalt(owner, walletId) }();
			if (address(wallet) != predicted) revert IGaslessLayer.GaslessWalletAddressMismatch();
			emit IGaslessLayer.GaslessWalletDeployed(owner, walletId, predicted);
			return (wallet, true);
		}
		return (GaslessWallet(payable(predicted)), false);
	}

	function _walletAddress(address owner, uint256 walletId) private view returns (address) {
		return
			address(
				uint160(
					uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _walletSalt(owner, walletId), GASLESS_WALLET_INIT_CODE_HASH)))
				)
			);
	}

	function _walletSalt(address owner, uint256 walletId) private pure returns (bytes32) {
		if (walletId == 0) return _gaslessWalletSalt(owner);
		return keccak256(abi.encode("GaslessQIndexedWallet", GASLESS_WALLET_VERSION, owner, walletId));
	}

	// ─────────────────────────── Helpers ──────────────────────────

	function _getGaslessWalletAddress(address deployer, address owner) internal pure returns (address) {
		bytes32 salt = _gaslessWalletSalt(owner);
		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, GASLESS_WALLET_INIT_CODE_HASH)))));
	}

	function _gaslessWalletSalt(address owner) internal pure returns (bytes32) {
		// Keep the original salt tag so renaming the contract does not move existing deposit addresses.
		return keccak256(abi.encode("GaslessQWallet", GASLESS_WALLET_VERSION, owner));
	}
}
