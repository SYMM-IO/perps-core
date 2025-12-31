// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IMarginFacet } from "./IMarginFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { AccountLayerReentrancyGuard } from "../../utils/AccountLayerReentrancyGuard.sol";
import { AccountHubStorage, VirtualAccountIsolationType } from "../../storages/AccountHubStorage.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";

contract MarginFacet is IMarginFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;

	function addMargin(address virtualAccount, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(virtualAccount) {
		if (amount == 0) revert ZeroAmount();

		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		if (!ahLayout.virtualAccounts[virtualAccount].isExists) revert NotVirtualAccount();
		address parent = ahLayout.virtualAccounts[virtualAccount].parentAccount;

		LibAccountLayerUtils.executeWithSigner(parent, abi.encodeWithSelector(ISymmio.internalTransfer.selector, virtualAccount, amount));

		emit AddMargin(virtualAccount, parent, amount);
	}

	function addMarginToNextVA(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId,
		uint256 amount
	) external whenNotPaused nonReentrant onlyAccountOwner(subAccount) {
		if (amount == 0) revert ZeroAmount();

		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		if (!ahLayout.subAccounts[subAccount].isExists) revert AccountDoesNotExist();

		address predictedVA = _predictNextVirtualAccountAddress(subAccount, isolationType, symbolId);

		LibAccountLayerUtils.executeWithSigner(subAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, predictedVA, amount));

		emit AddMargin(predictedVA, subAccount, amount);
	}

	function removeMargin(
		address virtualAccount,
		uint256 amount,
		ISymmio.SingleUpnlSig memory upnlSig
	) external whenNotPaused nonReentrant onlyAccountOwner(virtualAccount) {
		if (amount == 0) revert ZeroAmount();

		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		if (!ahLayout.virtualAccounts[virtualAccount].isExists) revert NotVirtualAccount();
		address parent = ahLayout.virtualAccounts[virtualAccount].parentAccount;

		LibAccountLayerUtils.executeWithSigner(virtualAccount, abi.encodeWithSelector(ISymmio.deallocate.selector, amount, upnlSig));
		LibAccountLayerUtils.executeWithSigner(virtualAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, parent, amount));

		emit RemoveMargin(virtualAccount, parent, amount);
	}

	// ==================== Internal Functions ====================

	function _predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) private view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		address[] storage pool = ahLayout.deletedVirtualAccountsPool[subAccount][isolationType][symbolId];
		if (pool.length > 0) {
			return pool[pool.length - 1];
		}

		if (ahLayout.subAccounts[subAccount].singleVAMode) {
			address existingVA = ahLayout.activeVAByKey[subAccount][isolationType][symbolId];
			if (existingVA != address(0) && ahLayout.virtualAccounts[existingVA].isExists) {
				return existingVA;
			}
		}

		uint256 nextNonce = ahLayout.subAccountVirtualNonces[subAccount] + 1;
		return LibAccountLayerUtils.generateVirtualAccountAddress(subAccount, nextNonce);
	}
}
