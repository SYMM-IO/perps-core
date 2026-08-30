// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import { ISymmioAccountLayer, VirtualAccountDetail } from "../interfaces/ISymmioAccountLayer.sol";

/// @title GaslessBillingIdentity
/// @notice Shared definition of the account charged for gasless gateway operations.
library GaslessBillingIdentity {
	/// @notice The account charged for `account`'s operations: VAs roll up to their parent SubAccount.
	/// @dev parentAccount survives VA deletion (the record is pooled for per-parent reuse), so a VA
	///      deleted earlier in the same batch still bills the parent that received its returned funds.
	function resolveBillingAccount(ISymmioAccountLayer accountLayer, address account) internal view returns (address) {
		VirtualAccountDetail memory virtualAccount = accountLayer.getVirtualAccount(account);
		return virtualAccount.parentAccount != address(0) ? virtualAccount.parentAccount : account;
	}

	/// @notice The canonical account for AUTHORIZATION decisions (wallet ownership, delegation scope):
	///         only a live VA rolls up to its parent. A deleted VA stays itself, so historical VA
	///         addresses cannot widen wallet or delegation authority to the parent.
	function resolveCanonicalAccount(ISymmioAccountLayer accountLayer, address account) internal view returns (address) {
		VirtualAccountDetail memory virtualAccount = accountLayer.getVirtualAccount(account);
		return virtualAccount.isExists ? virtualAccount.parentAccount : account;
	}
}
