// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountLayer } from "../interfaces/IAccountLayer.sol";

contract MockExpressAccountLayer is IAccountLayer {
	struct Account {
		address affiliate;
		bool exists;
	}

	mapping(address => Account) private accounts;

	function setAccount(address account, address affiliate, bool exists) external {
		accounts[account] = Account({ affiliate: affiliate, exists: exists });
	}

	function setAccounts(address[] calldata accountAddresses, address affiliate, bool exists) external {
		for (uint256 i = 0; i < accountAddresses.length; i++) {
			accounts[accountAddresses[i]] = Account({ affiliate: affiliate, exists: exists });
		}
	}

	function getAffiliateForAccount(address account) external view returns (address affiliate, bool exists) {
		Account storage data = accounts[account];
		return (data.affiliate, data.exists);
	}
}
