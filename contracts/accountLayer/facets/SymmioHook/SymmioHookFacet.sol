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
import { AccountStorage, VirtualAccountData, VirtualAccountIsolationType } from "../../storages/AccountStorage.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { IAccountLayerHook } from "../../interfaces/IAccountLayerHook.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";

/// @notice Hook facet called by Symmio core on position lifecycle events to manage virtual account state
contract SymmioHookFacet is ISymmioHookFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	/// @notice Called by Symmio core when a position is opened
	/// @dev Tracks the pending child quote created when a quote is partially filled. On a
	///      POSITION-isolated VA the child is cancelled instead: tracking it would let a second
	///      position open on a VA whose isolation contract is exactly one position.
	function onOpenPosition(
		uint256 quoteId,
		uint256 /* filledAmount */,
		uint256 /* openedPrice */,
		address partyA,
		address /* partyB */
	) external onlySymmio whenNotPaused {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		VirtualAccountData storage vData = ahLayout.virtualAccounts[partyA];
		if (!vData.isExists) return;

		address core = LibAccountLayerUtils.getRelatedCore(vData.parentAccount);
		ISymmio symmio = ISymmio(core);
		uint256 childQuoteId = symmio.getNextQuoteId();
		ISymmio.Quote memory childQuote = symmio.getQuote(childQuoteId);
		if (childQuote.parentId == quoteId && childQuote.partyA == partyA && childQuote.quoteStatus == ISymmio.QuoteStatus.PENDING) {
			if (vData.isolationType == VirtualAccountIsolationType.POSITION) {
				// Cancel is immediate and refunds in the same tx: the child is PENDING with no
				// partyB, and openPosition already required block.timestamp <= deadline. The
				// nested onCancelQuote hook re-enters this facet, so onCancelQuote must never
				// gain the nonReentrant modifier.
				LibAccountLayerUtils.executeWithSigner(partyA, abi.encodeWithSelector(ISymmio.requestToCancelQuote.selector, childQuoteId));
			} else {
				vData.quoteIds.add(childQuoteId);
			}
		}
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
		address partyB
	) external onlySymmio nonReentrant whenNotPaused {
		_removeQuoteFromAccount(quoteId, partyA, partyB);
	}

	/// @notice Called by Symmio core when a quote is cancelled; removes quoteId from the virtual account
	/// @param quoteId The cancelled quote identifier
	/// @param partyA The trader address (may be a virtual account)
	/// @param partyB The counterparty address
	function onCancelQuote(uint256 quoteId, address partyA, address partyB) external onlySymmio whenNotPaused {
		_removeQuoteFromAccount(quoteId, partyA, partyB);
	}

	/// @notice Called by Symmio core when a close request expires or is force cancelled
	function onCloseExpired(uint256 /* quoteId */, address /* partyA */, address /* partyB */) external onlySymmio whenNotPaused {}

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

	/// @notice Called by Symmio core after a partyA's liquidation is fully settled
	/// @dev Attempts deferred VA cleanup now that liquidation state has been cleared
	/// @param partyA The trader address whose liquidation was settled
	function onLiquidationSettled(address partyA) external onlySymmio nonReentrant whenNotPaused {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		// Settlement means this VA's share has been credited — clear pending cross-liq deferrals
		// so _tryDeleteVirtualAccount can proceed regardless of overall cross-liq status.
		EnumerableSet.AddressSet storage crossPartyBs = ahLayout.vaPendingCrossLiqPartyBs[partyA];
		address[] memory pending = crossPartyBs.values();
		for (uint256 i = 0; i < pending.length; i++) {
			crossPartyBs.remove(pending[i]);
		}
		_tryDeleteVirtualAccount(partyA, address(0));
	}

	// ==================== Internal Functions ====================

	/// @param partyB The counterparty from the hook call (used to check cross partyB liquidation deferral)
	function _removeQuoteFromAccount(uint256 quoteId, address partyA, address partyB) private {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		VirtualAccountData storage vData = ahLayout.virtualAccounts[partyA];
		if (!vData.isExists) return;

		address core = LibAccountLayerUtils.getRelatedCore(vData.parentAccount);
		uint256 coreTotal = ISymmio(core).partyAPositionsCount(partyA) + ISymmio(core).partyAPendingQuotesCount(partyA);

		if (coreTotal < vData.quoteIds.length()) {
			vData.quoteIds.remove(quoteId); // full close/cancel/liquidation
		}
		// else: partial close — keep tracking

		// If this partyB is currently in cross liquidation, record it so _tryDeleteVirtualAccount
		// can defer even when a later hook fires with a different partyB. This prevents fund stranding
		// when a VA has positions with multiple partyBs and the cross-liq distributeForClearingHouse
		// has not yet credited the VA's share.
		if (partyB != address(0) && ISymmio(core).getPartyBCrossLiquidationStatus(partyB)) {
			ahLayout.vaPendingCrossLiqPartyBs[partyA].add(partyB);
		}

		_tryDeleteVirtualAccount(partyA, partyB);
	}

	/// @param partyB The counterparty address; address(0) skips the per-hook cross partyB check
	///               (used by onLiquidationSettled after settlement is already complete)
	function _tryDeleteVirtualAccount(address partyA, address partyB) private {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		VirtualAccountData storage vData = ahLayout.virtualAccounts[partyA];
		if (!vData.isExists) return;
		if (vData.quoteIds.length() != 0) return;

		address core = LibAccountLayerUtils.getRelatedCore(vData.parentAccount);

		// Defer if partyA is in any liquidation flow
		if (ISymmio(core).isPartyALiquidated(partyA)) return;
		if (ISymmio(core).isPartyATakeoverInProgress(partyA)) return;

		// Check the partyB from the current hook call
		if (partyB != address(0) && ISymmio(core).getPartyBCrossLiquidationStatus(partyB)) return;

		// Check any previously-recorded cross-liq partyBs (multi-partyB VA protection).
		// Clean up entries whose cross liquidation has since completed.
		EnumerableSet.AddressSet storage crossPartyBs = ahLayout.vaPendingCrossLiqPartyBs[partyA];
		address[] memory pending = crossPartyBs.values();
		for (uint256 i = 0; i < pending.length; i++) {
			if (ISymmio(core).getPartyBCrossLiquidationStatus(pending[i])) {
				return; // still in cross liq — defer
			}
			crossPartyBs.remove(pending[i]); // cross liq done — clean up
		}

		_deleteVirtualAccount(partyA);
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
