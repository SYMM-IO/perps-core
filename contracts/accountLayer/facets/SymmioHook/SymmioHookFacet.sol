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
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { IAccountHubHook } from "../../interfaces/IAccountHubHook.sol";

contract SymmioHookFacet is ISymmioHookFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	function onOpenPosition(
		uint256 /* quoteId */,
		uint256 /* filledAmount */,
		uint256 /* openedPrice */,
		address /* partyA */,
		address /* partyB */
	) external onlySymmio whenNotPaused {
		// No-op: Account layer doesn't need to track position opens
		// This function exists to prevent hook reverts when positions are opened
	}

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

	function onFeeCharged(
		uint256 /* quoteId */,
		uint256 /* amount */,
		address /* partyA */,
		address /* partyB */,
		uint256 /* symbolId */,
		address /* affiliate */,
		uint8 /* feeType */
	) external onlySymmio whenNotPaused {
		// No-op: Account layer doesn't need to track fee charges
		// This function exists to prevent hook reverts when fees are charged
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
		address core = LibAccountLayerUtils.getRelatedCore(parentAccount);

		LibAccountLayerUtils.deallocateAndTransferBalance(account, parentAccount, core);

		vData.isExists = false;

		if (ahLayout.activeVAByKey[parentAccount][vData.isolationType][vData.symbolId] == account) {
			delete ahLayout.activeVAByKey[parentAccount][vData.isolationType][vData.symbolId];
		}

		ahLayout.deletedVirtualAccountsPool[parentAccount][vData.isolationType][vData.symbolId].push(account);
		ahLayout.subAccountToVirtualAccounts[parentAccount].remove(account);

		address affiliate = LibAccountLayerUtils.getAffiliateForAccount(account);

		LibAccountLayerUtils.callHook(
			affiliate,
			account,
			core,
			IAccountHubHook.onVirtualAccountDeletion.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountDeletion.selector, account)
		);

		emit VirtualAccountDeleted(account, parentAccount);
	}
}
