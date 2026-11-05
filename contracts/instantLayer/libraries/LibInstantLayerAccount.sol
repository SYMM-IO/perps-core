// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { InstantLayerStorage } from "../storages/InstantLayerStorage.sol";
import { IInstantLayerErrors } from "../interfaces/IInstantLayerErrors.sol";
import { VirtualAccountDetail } from "../../accountLayer/storages/AccountStorage.sol";
import { IViewFacet as IAccountLayerViewFacet } from "../../accountLayer/facets/View/IViewFacet.sol";

/// @notice Account-resolution helpers shared by every InstantLayer facet that reaches into the
///         configured AccountLayer.
/// @dev The view, delegation and execution facets and LibInstantLayerDelegation all need the same
///      canonical-delegator and owner lookups; this is the single copy they call.
library LibInstantLayerAccount {
	/// @notice Normalize a delegation key to the canonical delegator account.
	/// @dev Active virtual accounts are normalized to their parent sub account.
	function canonicalDelegator(address account) internal view returns (address) {
		address accountLayer = InstantLayerStorage.layout().accountLayer;
		if (accountLayer == address(0)) revert IInstantLayerErrors.AccountLayerNotSet();
		VirtualAccountDetail memory virtualAccount = IAccountLayerViewFacet(accountLayer).getVirtualAccount(account);
		if (virtualAccount.isExists) return virtualAccount.parentAccount;
		return account;
	}

	/// @notice Retrieve the owner of an account via the AccountLayer.
	function getAccountOwner(address account) internal view returns (address) {
		address accountLayer = InstantLayerStorage.layout().accountLayer;
		if (accountLayer == address(0)) revert IInstantLayerErrors.AccountLayerNotSet();
		return IAccountLayerViewFacet(accountLayer).ownerOf(account);
	}
}
