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
import { AccountHubStorage, SubAccountData, VirtualAccountData, VirtualAccountIsolationType } from "../../storages/AccountHubStorage.sol";
import { AffiliateHubStorage } from "../../storages/AffiliateHubStorage.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { IMultiAccount } from "../../interfaces/IMultiAccount.sol";

contract MarginFacet is IMarginFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;

	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");

	function addMargin(address virtualAccount, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(virtualAccount) {
		if (amount == 0) revert ZeroAmount();

		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		if (!ahLayout.virtualAccounts[virtualAccount].isExists) revert NotVirtualAccount();
		address parent = ahLayout.virtualAccounts[virtualAccount].parentAccount;

		_executeWithSigner(parent, abi.encodeWithSelector(ISymmio.internalTransfer.selector, virtualAccount, amount));

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

		_executeWithSigner(subAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, predictedVA, amount));

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

		_executeWithSigner(virtualAccount, abi.encodeWithSelector(ISymmio.deallocate.selector, amount, upnlSig));
		_executeWithSigner(virtualAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, parent, amount));

		emit RemoveMargin(virtualAccount, parent, amount);
	}

	// ==================== Internal Functions ====================

	function _getSigner() internal view returns (address) {
		address signer = AccountHubStorage.layout().globalSigner;
		return signer == address(0) ? msg.sender : signer;
	}

	function _executeWithSigner(address account, bytes memory callData) private returns (bytes memory) {
		address core = _getRelatedCore(account);

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

	function _getRelatedCore(address account) internal view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();

		if (ahLayout.subAccounts[account].isExists) {
			return ahLayout.subAccounts[account].symmioCore;
		}

		address parent = ahLayout.virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return _getRelatedCore(parent);
		}

		address[] memory legacyAccounts = afLayout.legacyMultiAccounts.values();
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			address owner = IMultiAccount(legacyAccounts[i]).owners(account);
			if (owner != address(0)) {
				return IMultiAccount(legacyAccounts[i]).symmioAddress();
			}
		}

		revert("MarginFacet: Unable to retrieve core");
	}

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
		return _generateVirtualAccountAddress(subAccount, nextNonce);
	}

	function _generateVirtualAccountAddress(address parentAccount, uint256 nonce) private pure returns (address) {
		return
			address(
				uint160(
					uint256(
						keccak256(abi.encodePacked(bytes1(0xff), parentAccount, keccak256(abi.encodePacked(nonce)), VIRTUAL_ACCOUNT_INIT_CODE_HASH))
					)
				)
			);
	}

	function _resolveAccountOwner(address account) internal view override returns (address) {
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
