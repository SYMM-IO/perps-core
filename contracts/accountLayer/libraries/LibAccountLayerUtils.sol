// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { AffiliateStorage, HookContext } from "../storages/AffiliateStorage.sol";
import { ISymmio } from "../interfaces/ISymmio.sol";
import { IMultiAccount } from "../interfaces/IMultiAccount.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

/// @notice Utility library for account resolution, signer management, hook execution, and address generation
library LibAccountLayerUtils {
	using EnumerableSet for EnumerableSet.AddressSet;

	bytes32 internal constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");
	uint256 internal constant MAX_NAME_LENGTH = 100;

	/// @notice Returns the current effective signer (globalSigner if set, otherwise msg.sender)
	function getSigner() internal view returns (address) {
		address signer = AccountStorage.layout().globalSigner;
		return signer == address(0) ? msg.sender : signer;
	}

	/// @notice Executes a call on the Symmio core with setSigner(account), then clears the signer
	function executeWithSigner(address account, bytes memory callData) internal returns (bytes memory) {
		address core = getRelatedCore(account);
		ISymmio(core).setSigner(account);
		(bool success, bytes memory result) = core.call(callData);
		ISymmio(core).setSigner(address(0));

		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}

		return result;
	}

	/// @notice Resolves the Symmio core address associated with an account
	function getRelatedCore(address account) internal view returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();

		if (ahLayout.subAccounts[account].isExists) {
			return ahLayout.subAccounts[account].symmioCore;
		}

		address parent = ahLayout.virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return getRelatedCore(parent);
		}

		address[] memory legacyAccounts = afLayout.legacyMultiAccounts.values();
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			address owner = IMultiAccount(legacyAccounts[i]).owners(account);
			if (owner != address(0)) {
				return IMultiAccount(legacyAccounts[i]).symmioAddress();
			}
		}

		revert IAccountLayerErrors.CoreNotFound();
	}

	/// @notice Resolves the owner of an account by checking sub-accounts, virtual accounts, and legacy contracts
	function resolveAccountOwner(address account) internal view returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();

		address owner = ahLayout.subAccounts[account].owner;
		if (owner != address(0)) {
			return owner;
		}

		address parent = ahLayout.virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			address parentOwner = ahLayout.subAccounts[parent].owner;
			if (parentOwner != address(0)) {
				return parentOwner;
			}
		}

		address[] memory legacyAccounts = afLayout.legacyMultiAccounts.values();
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			address legacyOwner = IMultiAccount(legacyAccounts[i]).owners(account);
			if (legacyOwner != address(0)) {
				return legacyOwner;
			}
		}

		return address(0);
	}

	/// @notice Generates a deterministic virtual account address using CREATE2-style hashing
	function generateVirtualAccountAddress(address parentAccount, uint256 nonce) internal pure returns (address) {
		return
			address(
				uint160(
					uint256(
						keccak256(abi.encodePacked(bytes1(0xff), parentAccount, keccak256(abi.encodePacked(nonce)), VIRTUAL_ACCOUNT_INIT_CODE_HASH))
					)
				)
			);
	}

	/// @notice Validates that a name is non-empty and within the maximum length
	function validateName(string memory name) internal pure {
		if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_LENGTH) {
			revert IAccountLayerErrors.InvalidNameLength();
		}
	}

	/// @notice Returns the claimable fee balance for an affiliate, adjusted for collateral decimals
	function getClaimableFee(address affiliate, address symmio) internal view returns (uint256) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		uint8 decimals = IERC20Metadata(ISymmio(symmio).getCollateral()).decimals();
		uint256 balance = ISymmio(symmio).balanceOf(afLayout.affiliates[affiliate].feeDetails.feeDistributor);
		return balance / (10 ** (18 - decimals));
	}

	/// @notice Resolves the affiliate associated with an account by traversing the account hierarchy
	function getAffiliateForAccount(address account) internal view returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();

		if (ahLayout.subAccounts[account].isExists) {
			return ahLayout.subAccounts[account].affiliate;
		}

		if (ahLayout.virtualAccounts[account].parentAccount != address(0)) {
			return getAffiliateForAccount(ahLayout.virtualAccounts[account].parentAccount);
		}

		return address(0);
	}

	/// @notice Calls the affiliate's registered hook for a given selector with signer protection
	function callHook(address affiliate, address account, address symmioCore, bytes4 selector, bytes memory data) internal {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		address hook = afLayout.affiliates[affiliate].hooks[selector];
		if (hook == address(0)) return;

		// Save and clear signer before external call to prevent hook from impersonating user
		address previousSigner = ahLayout.globalSigner;
		ahLayout.globalSigner = address(0);

		// Set hook context before calling
		afLayout.hookContext = HookContext({ account: account, affiliate: affiliate, symmioCore: symmioCore, isActive: true });
		afLayout.activeHookCaller = hook;

		(bool success, bytes memory result) = hook.call(data);

		// Clear hook context after call
		delete afLayout.hookContext;
		afLayout.activeHookCaller = address(0);

		// Restore signer after hook call
		ahLayout.globalSigner = previousSigner;

		if (!success) {
			revert IAccountLayerErrors.HookFailed(result);
		}
	}

	/// @notice Deallocates all funds from an account and transfers the balance to its parent
	function deallocateAndTransferBalance(address account, address parentAccount, address core) internal {
		uint256 allocatedBalance = ISymmio(core).allocatedBalanceOfPartyA(account);
		if (allocatedBalance > 0) {
			executeWithSigner(account, abi.encodeWithSelector(ISymmio.zeroUpnlDeallocate.selector, allocatedBalance));
		}

		uint256 balance = ISymmio(core).balanceOf(account);
		if (balance > 0) {
			executeWithSigner(account, abi.encodeWithSelector(ISymmio.internalTransferToBalance.selector, parentAccount, balance));
		}
	}
}
