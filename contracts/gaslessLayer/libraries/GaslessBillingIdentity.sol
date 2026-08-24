// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import { ISymmioAccountLayer, VirtualAccountDetail } from "../interfaces/ISymmioAccountLayer.sol";

/// @title GaslessBillingIdentity
/// @notice Shared definition of the account charged for gasless gateway operations.
library GaslessBillingIdentity {
	function resolveBillingAccount(ISymmioAccountLayer accountLayer, address account) internal view returns (address) {
		VirtualAccountDetail memory virtualAccount = accountLayer.getVirtualAccount(account);
		return virtualAccount.isExists ? virtualAccount.parentAccount : account;
	}
}
