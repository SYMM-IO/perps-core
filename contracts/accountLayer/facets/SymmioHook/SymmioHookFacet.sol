// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { ISymmioHookFacet } from "./ISymmioHookFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { AccountLayerReentrancyGuard } from "../../utils/AccountLayerReentrancyGuard.sol";
import { AccountHubStorage, VirtualAccountData } from "../../storages/AccountHubStorage.sol";
import { AffiliateHubStorage } from "../../storages/AffiliateHubStorage.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { IAccountHubHook } from "../../interfaces/IAccountHubHook.sol";

contract SymmioHookFacet is ISymmioHookFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	function onClosePosition(
		uint256 quoteId,
		uint256 /* filledAmount */,
		uint256 /* closedPrice */,
		address partyA,
		address /* partyB */
	) external onlySymmio nonReentrant whenNotPaused {
		_removeQuoteFromAccount(quoteId, partyA);
	}

	function onCancelQuote(uint256 quoteId, address partyA, address /* partyB */) external onlySymmio whenNotPaused {
		_removeQuoteFromAccount(quoteId, partyA);
	}

	// ==================== Internal Functions ====================

	function _removeQuoteFromAccount(uint256 quoteId, address partyA) private {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		VirtualAccountData storage vData = ahLayout.virtualAccounts[partyA];

		if (vData.isExists) {
			vData.quoteIds.remove(quoteId);
			if (vData.quoteIds.length() == 0) {
				_deleteVirtualAccount(partyA);
			}
		}
	}

	function _deleteVirtualAccount(address account) private {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		VirtualAccountData storage vData = ahLayout.virtualAccounts[account];
		if (!vData.isExists) revert AlreadyDeleted();
		if (vData.quoteIds.length() != 0) revert OpenPositionsExist();

		address parentAccount = vData.parentAccount;
		address core = _getRelatedCore(parentAccount);

		_deallocateAndTransferBalance(account, parentAccount, core);

		vData.isExists = false;

		if (ahLayout.activeVAByKey[parentAccount][vData.isolationType][vData.symbolId] == account) {
			delete ahLayout.activeVAByKey[parentAccount][vData.isolationType][vData.symbolId];
		}

		ahLayout.deletedVirtualAccountsPool[parentAccount][vData.isolationType][vData.symbolId].push(account);
		ahLayout.subAccountToVirtualAccounts[parentAccount].remove(account);

		address affiliate = _getAffiliateForAccount(account);

		_callHook(
			affiliate,
			IAccountHubHook.onVirtualAccountDeletion.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountDeletion.selector, account)
		);

		emit VirtualAccountDeleted(account, parentAccount);
	}

	function _deallocateAndTransferBalance(address account, address parentAccount, address core) private {
		uint256 allocatedBalance = ISymmio(core).allocatedBalanceOfPartyA(account);
		if (allocatedBalance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.zeroUpnlDeallocate.selector, allocatedBalance));
		}

		uint256 balance = ISymmio(core).balanceOf(account);
		if (balance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.internalTransferToBalance.selector, parentAccount, balance));
		}
	}

	function _executeWithSigner(address account, bytes memory callData) private returns (bytes memory) {
		return LibAccountLayerUtils.executeWithSigner(account, callData);
	}

	function _getRelatedCore(address account) internal view returns (address) {
		return LibAccountLayerUtils.getRelatedCore(account);
	}

	function _getAffiliateForAccount(address account) private view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		if (ahLayout.subAccounts[account].isExists) {
			return ahLayout.subAccounts[account].affiliate;
		}

		if (ahLayout.virtualAccounts[account].parentAccount != address(0)) {
			return _getAffiliateForAccount(ahLayout.virtualAccounts[account].parentAccount);
		}

		return address(0);
	}

	function _callHook(address affiliate, bytes4 selector, bytes memory data) private {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		address hook = afLayout.affiliates[affiliate].hooks[selector];
		if (hook == address(0)) return;
		(bool success, bytes memory result) = hook.call(data);
		if (!success) {
			revert HookFailed(result);
		}
	}
}
