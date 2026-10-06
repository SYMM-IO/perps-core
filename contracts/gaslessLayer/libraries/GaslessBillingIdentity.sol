// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ISymmioAccountLayer, VirtualAccountDetail } from "../interfaces/ISymmioAccountLayer.sol";

/// @title GaslessBillingIdentity
/// @notice Resolve the billing and authorization accounts for gasless operations.
library GaslessBillingIdentity {
	/// @notice Return the billing account for `account`; virtual accounts bill their parent SubAccount.
	/// @dev Deleted VA records retain parentAccount for reuse by that parent. A VA deleted earlier in the batch
	///      still bills the parent that received its returned funds.
	function resolveBillingAccount(ISymmioAccountLayer accountLayer, address account) internal view returns (address) {
		VirtualAccountDetail memory virtualAccount = accountLayer.getVirtualAccount(account);
		return virtualAccount.parentAccount != address(0) ? virtualAccount.parentAccount : account;
	}

	/// @notice Resolve the account used to check wallet ownership and delegation. Only a live VA resolves to its parent.
	/// @dev A deleted VA resolves to its own address and cannot inherit the parent's wallet or delegation authority.
	function resolveCanonicalAccount(ISymmioAccountLayer accountLayer, address account) internal view returns (address) {
		VirtualAccountDetail memory virtualAccount = accountLayer.getVirtualAccount(account);
		return virtualAccount.isExists ? virtualAccount.parentAccount : account;
	}
}
