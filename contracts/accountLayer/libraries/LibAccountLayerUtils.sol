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

library LibAccountLayerUtils {
	using EnumerableSet for EnumerableSet.AddressSet;

	function getSigner() internal view returns (address) {
		address signer = AccountHubStorage.layout().globalSigner;
		return signer == address(0) ? msg.sender : signer;
	}

	function executeWithSigner(address account, bytes memory callData, address core) internal returns (bytes memory) {
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

	function executeWithSigner(
		address account,
		bytes memory callData,
		string memory errorMessage
	) internal returns (bytes memory) {
		address core = getRelatedCore(account, errorMessage);
		return executeWithSigner(account, callData, core);
	}

	function getRelatedCore(address account, string memory errorMessage) internal view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();

		if (ahLayout.subAccounts[account].isExists) {
			return ahLayout.subAccounts[account].symmioCore;
		}

		address parent = ahLayout.virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return getRelatedCore(parent, errorMessage);
		}

		address[] memory legacyAccounts = afLayout.legacyMultiAccounts.values();
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			address owner = IMultiAccount(legacyAccounts[i]).owners(account);
			if (owner != address(0)) {
				return IMultiAccount(legacyAccounts[i]).symmioAddress();
			}
		}

		revert(errorMessage);
	}
}
