// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { AccountHubStorage } from "../storages/AccountHubStorage.sol";
import { AffiliateHubStorage } from "../storages/AffiliateHubStorage.sol";
import { ISymmio } from "../interfaces/ISymmio.sol";
import { IMultiAccount } from "../interfaces/IMultiAccount.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

library LibAccountLayerUtils {
	using EnumerableSet for EnumerableSet.AddressSet;

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
}
