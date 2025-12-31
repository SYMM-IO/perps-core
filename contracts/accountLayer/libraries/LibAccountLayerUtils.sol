// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { AccountHubStorage } from "../storages/AccountHubStorage.sol";
import { AffiliateHubStorage, HookContext } from "../storages/AffiliateHubStorage.sol";
import { ISymmio } from "../interfaces/ISymmio.sol";
import { IMultiAccount } from "../interfaces/IMultiAccount.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

library LibAccountLayerUtils {
	using EnumerableSet for EnumerableSet.AddressSet;

	bytes32 internal constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");
	uint256 internal constant MAX_NAME_LENGTH = 100;

	function getSigner() internal view returns (address) {
		address signer = AccountHubStorage.layout().globalSigner;
		return signer == address(0) ? msg.sender : signer;
	}

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

	function getRelatedCore(address account) internal view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();

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

	function resolveAccountOwner(address account) internal view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();

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

	function validateName(string memory name) internal pure {
		if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_LENGTH) {
			revert IAccountLayerErrors.InvalidNameLength();
		}
	}

	function getClaimableFee(address affiliate, address symmio) internal view returns (uint256) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		uint8 decimals = IERC20Metadata(ISymmio(symmio).getCollateral()).decimals();
		uint256 balance = ISymmio(symmio).balanceOf(afLayout.affiliates[affiliate].feeDetails.feeDistributor);
		return balance / (10 ** (18 - decimals));
	}

	function getAffiliateForAccount(address account) internal view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		if (ahLayout.subAccounts[account].isExists) {
			return ahLayout.subAccounts[account].affiliate;
		}

		if (ahLayout.virtualAccounts[account].parentAccount != address(0)) {
			return getAffiliateForAccount(ahLayout.virtualAccounts[account].parentAccount);
		}

		return address(0);
	}

	function callHook(address affiliate, bytes4 selector, bytes memory data) internal {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		address hook = afLayout.affiliates[affiliate].hooks[selector];
		if (hook == address(0)) return;
		(bool success, bytes memory result) = hook.call(data);
		if (!success) {
			revert IAccountLayerErrors.HookFailed(result);
		}
	}

	function callHookWithContext(address affiliate, address account, address symmioCore, bytes4 selector, bytes memory data) internal {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		address hook = afLayout.affiliates[affiliate].hooks[selector];
		if (hook == address(0)) return;

		// Set hook context before calling
		afLayout.hookContext = HookContext({ account: account, affiliate: affiliate, symmioCore: symmioCore, isActive: true });

		(bool success, bytes memory result) = hook.call(data);

		// Clear hook context after call
		delete afLayout.hookContext;

		if (!success) {
			revert IAccountLayerErrors.HookFailed(result);
		}
	}

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
