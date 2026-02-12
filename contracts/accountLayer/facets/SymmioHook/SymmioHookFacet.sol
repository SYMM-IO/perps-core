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
import { AccountStorage, VirtualAccountData } from "../../storages/AccountStorage.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { IAccountLayerHook } from "../../interfaces/IAccountLayerHook.sol";

/// @notice Hook facet called by Symmio core on position lifecycle events to manage virtual account state
contract SymmioHookFacet is ISymmioHookFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	/// @notice Called by Symmio core when a position is opened (no-op in AccountLayer)
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

	/// @notice Called by Symmio core when a position is closed; removes quoteId from the virtual account
	/// @dev If the virtual account has no remaining quotes, it is automatically deleted and its funds returned to the parent
	/// @param quoteId The closed quote identifier
	/// @param partyA The trader address (may be a virtual account)
	function onClosePosition(
		uint256 quoteId,
		uint256 /* filledAmount */,
		uint256 /* closedPrice */,
		address partyA,
		address /* partyB */
	) external onlySymmio nonReentrant whenNotPaused {
		_removeQuoteFromAccount(quoteId, partyA);
	}

	/// @notice Called by Symmio core when a quote is cancelled; removes quoteId from the virtual account
	/// @param quoteId The cancelled quote identifier
	/// @param partyA The trader address (may be a virtual account)
	function onCancelQuote(uint256 quoteId, address partyA, address /* partyB */) external onlySymmio whenNotPaused {
		_removeQuoteFromAccount(quoteId, partyA);
	}

	/// @notice Called by Symmio core when a fee is charged (no-op in AccountLayer)
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
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		VirtualAccountData storage vData = ahLayout.virtualAccounts[partyA];

		if (vData.isExists) {
			vData.quoteIds.remove(quoteId);
			if (vData.quoteIds.length() == 0) {
				_deleteVirtualAccount(partyA);
			}
		}
	}

	function _deleteVirtualAccount(address account) private {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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
			IAccountLayerHook.onVirtualAccountDeletion.selector,
			abi.encodeWithSelector(IAccountLayerHook.onVirtualAccountDeletion.selector, account)
		);

		emit VirtualAccountDeleted(account, parentAccount);
	}
}
