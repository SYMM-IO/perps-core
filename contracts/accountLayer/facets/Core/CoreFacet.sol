// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { ICoreFacet } from "./ICoreFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { AccountLayerReentrancyGuard } from "../../utils/AccountLayerReentrancyGuard.sol";
import {
	AccountStorage,
	SubAccountData,
	VirtualAccountData,
	SubAccountCreationData,
	VirtualAccountIsolationType,
	SubAccountIsolationType,
	LegacyAccountImportData
} from "../../storages/AccountStorage.sol";
import { AffiliateStorage, AffiliateState, HookContext } from "../../storages/AffiliateStorage.sol";
import { LibQuoteParams, QuoteParams } from "../../libraries/LibQuoteParams.sol";
import { LibAccountLayerAccessibility } from "../../libraries/LibAccountLayerAccessibility.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { LibAccountLayerMargin } from "../../libraries/LibAccountLayerMargin.sol";
import { LibAccountLayerSigner } from "../../libraries/LibAccountLayerSigner.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { IAccountLayerHook } from "../../interfaces/IAccountLayerHook.sol";
import { IMultiAccount } from "../../interfaces/IMultiAccount.sol";

/// @notice Core facet for sub-account and virtual account management, deposits, and call execution
contract CoreFacet is ICoreFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");

	// ==================== Sub-Account Management ====================

	/// @notice Creates one or more sub-accounts under the specified affiliate
	/// @param affiliate The affiliate address the sub-accounts belong to
	/// @param accountsData Configuration for each sub-account to create
	/// @return The deterministic addresses of the created sub-accounts
	function createSubAccounts(
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant returns (address[] memory) {
		if (accountsData.length == 0) revert EmptyArray();

		address[] memory createdAccounts = new address[](accountsData.length);
		address signer = LibAccountLayerUtils.getSigner();

		for (uint256 i = 0; i < accountsData.length; i++) {
			createdAccounts[i] = _createSubAccount(affiliate, signer, accountsData[i]);
		}

		return createdAccounts;
	}

	/// @notice Creates one or more sub-accounts for a specified owner under the specified affiliate
	/// @param owner The owner of the created sub-accounts
	/// @param affiliate The affiliate address the sub-accounts belong to
	/// @param accountsData Configuration for each sub-account to create
	/// @return The deterministic addresses of the created sub-accounts
	function createSubAccountsFor(
		address owner,
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant onlyRole(LibAccountLayerAccessibility.ACCOUNT_CREATOR_ROLE) returns (address[] memory) {
		if (owner == address(0)) revert ZeroAddress();
		if (accountsData.length == 0) revert EmptyArray();

		address[] memory createdAccounts = new address[](accountsData.length);

		for (uint256 i = 0; i < accountsData.length; i++) {
			createdAccounts[i] = _createSubAccount(affiliate, owner, accountsData[i]);
		}

		return createdAccounts;
	}

	/// @notice Updates the display name of a sub-account
	/// @param account The sub-account address to rename
	/// @param name The new name (must be 1-100 characters)
	function editAccountName(address account, string memory name) external whenNotPaused onlyAccountOwner(account) {
		LibAccountLayerUtils.validateName(name);

		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		if (!ahLayout.subAccounts[account].isExists) revert AccountDoesNotExist();

		ahLayout.subAccounts[account].name = name;
		emit EditAccountName(account, name);
	}

	/// @notice Toggles single virtual account mode for a sub-account
	/// @dev Only applicable to MARKET and MARKET_DIRECTION isolation types. Requires no active VAs.
	/// @param subAccount The sub-account address
	/// @param enabled Whether single VA mode should be enabled
	function setSingleVAMode(address subAccount, bool enabled) external whenNotPaused onlyAccountOwner(subAccount) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		SubAccountData storage s = ahLayout.subAccounts[subAccount];
		if (!s.isExists) revert AccountDoesNotExist();

		if (enabled && s.isolationType != SubAccountIsolationType.MARKET && s.isolationType != SubAccountIsolationType.MARKET_DIRECTION) {
			revert SingleVAModeNotApplicable();
		}

		if (ahLayout.subAccountToVirtualAccounts[subAccount].length() > 0) {
			revert HasActiveVirtualAccounts();
		}

		s.singleVAMode = enabled;
		emit SingleVAModeChanged(subAccount, enabled);
	}

	/// @notice Deletes a sub-account that has no active virtual accounts, positions, or balance
	/// @param subAccount The sub-account address to delete
	function deleteSubAccount(address subAccount) external whenNotPaused nonReentrant onlyAccountOwner(subAccount) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		SubAccountData storage s = ahLayout.subAccounts[subAccount];

		if (!s.isExists) revert AccountDoesNotExist();

		// Require all VirtualAccounts to be deleted first
		if (ahLayout.subAccountToVirtualAccounts[subAccount].length() > 0) {
			revert HasActiveVirtualAccounts();
		}

		// Check that the account is empty in symmio
		ISymmio symmio = ISymmio(s.symmioCore);

		// Trading state is checked before balances on purpose. Open positions and pending quotes keep their
		// CVA and LF locked in allocated balance, and core forbids deallocating below that floor, so an account
		// with either can never be emptied first. Checking balances ahead of them would always report
		// SubAccountNotEmpty and point the caller at a withdrawal that cannot succeed, instead of naming the
		// position or quote that must be closed.

		// Check no open positions
		if (symmio.partyAPositionsCount(subAccount) > 0) revert OpenPositionsExist();

		// Check no pending quotes
		uint256[] memory pendingQuotes = symmio.getPartyAPendingQuotes(subAccount);
		if (pendingQuotes.length > 0) revert PendingQuotesExist();

		// Check balance is 0
		if (symmio.balanceOf(subAccount) > 0) revert SubAccountNotEmpty();

		// Check allocated balance is 0
		if (symmio.allocatedBalanceOfPartyA(subAccount) > 0) revert SubAccountNotEmpty();

		// Store values before deletion for event and hook
		address owner = s.owner;
		address affiliate = s.affiliate;
		address symmioCore = s.symmioCore;

		// Mark as deleted
		s.isExists = false;

		// Remove from user's subAccounts set
		ahLayout.userToSubAccounts[owner].remove(subAccount);

		// Call affiliate hook
		LibAccountLayerUtils.callHook(
			affiliate,
			subAccount,
			symmioCore,
			IAccountLayerHook.onSubAccountDeletion.selector,
			abi.encodeWithSelector(IAccountLayerHook.onSubAccountDeletion.selector, subAccount, owner)
		);

		emit SubAccountDeleted(subAccount, owner, affiliate);
	}

	/// @notice Transfers ownership of a sub-account and all of its virtual accounts to a new owner
	/// @param subAccount The sub-account address to transfer
	/// @param newOwner The new owner of the sub-account
	function transferSubAccountOwnership(address subAccount, address newOwner) external whenNotPaused nonReentrant onlyAccountOwner(subAccount) {
		if (newOwner == address(0)) revert ZeroAddress();

		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		SubAccountData storage s = ahLayout.subAccounts[subAccount];
		if (!s.isExists) revert AccountDoesNotExist();

		address oldOwner = s.owner;
		if (oldOwner == newOwner) revert InvalidState();

		address affiliate = s.affiliate;
		address symmioCore = s.symmioCore;

		ahLayout.userToSubAccounts[oldOwner].remove(subAccount);
		ahLayout.userToSubAccounts[newOwner].add(subAccount);
		s.owner = newOwner;

		LibAccountLayerUtils.callHook(
			affiliate,
			subAccount,
			symmioCore,
			IAccountLayerHook.onSubAccountOwnershipTransfer.selector,
			abi.encodeWithSelector(IAccountLayerHook.onSubAccountOwnershipTransfer.selector, subAccount, oldOwner, newOwner)
		);

		emit SubAccountOwnershipTransferred(subAccount, oldOwner, newOwner);
	}

	// ==================== Virtual Account Management ====================

	/// @notice Manually creates a virtual account under a CUSTOM isolation sub-account
	/// @param parentAccount The parent sub-account (must have CUSTOM isolation type)
	/// @param metadata Arbitrary metadata to attach to the virtual account
	/// @param isolationType The isolation type for the virtual account
	/// @param symbolId The symbol the virtual account is restricted to (for market-based isolation)
	/// @return The address of the created or reused virtual account
	function createCustomVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external whenNotPaused nonReentrant onlyAccountOwner(parentAccount) returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		SubAccountData storage parent = ahLayout.subAccounts[parentAccount];

		if (parent.isolationType != SubAccountIsolationType.CUSTOM) {
			revert OnlyCustomIsolationCanCreateManually();
		}

		return _getOrCreateVirtualAccount(parentAccount, metadata, isolationType, symbolId);
	}

	// ==================== Deposit Functions ====================

	/// @notice Deposits collateral into the Symmio core for the specified account
	/// @param account The sub-account or virtual account to deposit for
	/// @param amount The amount of collateral to deposit
	function depositForAccount(address account, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(account) {
		_depositToSymmio(account, amount, ISymmio.depositFor.selector);
	}

	/// @notice Deposits and immediately allocates collateral for the specified account
	/// @param account The sub-account or virtual account to deposit and allocate for
	/// @param amount The amount of collateral to deposit and allocate
	function depositAndAllocateForAccount(address account, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(account) {
		_depositToSymmio(account, amount, ISymmio.depositAndAllocateFor.selector);
	}

	function _depositToSymmio(address account, uint256 amount, bytes4 depositSelector) private {
		if (amount == 0) revert ZeroAmount();
		_revertIfDeletedVirtualAccount(account);

		address core = LibAccountLayerUtils.getRelatedCore(account);

		// Deposit directly from the signer into Symmio
		address signer = LibAccountLayerUtils.getSigner();
		_executeWithSymmioSigner(core, signer, abi.encodeWithSelector(depositSelector, account, amount));
	}

	function _revertIfDeletedVirtualAccount(address account) private view {
		VirtualAccountData storage virtualAccount = AccountStorage.layout().virtualAccounts[account];
		if (virtualAccount.parentAccount != address(0) && !virtualAccount.isExists) revert AccountDoesNotExist();
	}

	function _executeWithSymmioSigner(address symmio, address signer, bytes memory callData) private returns (bytes memory) {
		(address previousSigner, bool wasTransientScoped) = LibAccountLayerSigner.clearSignerForExternalCall();
		bytes memory result = LibAccountLayerUtils.executeWithSignerOnCore(symmio, signer, callData);
		LibAccountLayerSigner.restoreSignerAfterExternalCall(previousSigner, wasTransientScoped);
		return result;
	}

	// ==================== Call Execution ====================

	/// @notice Executes an array of Symmio core calls on behalf of an account
	/// @dev Handles sendQuote routing to virtual accounts based on sub-account isolation type.
	///      Blocks internalTransferToBalance to prevent unauthorized fund extraction.
	/// @param account The account to execute calls for
	/// @param callDatas Array of encoded function calls to execute on the Symmio core
	/// @return Array of return data from each call
	function _call(
		address account,
		bytes[] calldata callDatas
	) external whenNotPaused nonReentrant onlyAccountOwner(account) returns (bytes[] memory) {
		return _executeCalls(account, callDatas, false, VirtualAccountIsolationType.POSITION, 0);
	}

	/// @notice Pre-funds the next virtual account and executes Symmio core calls in a single transaction
	/// @dev Equivalent to addMarginToNextVA followed by _call, but with one authorization and one
	///      reentrancy guard. The margin lands on the predicted next VA and the sendQuote routing in
	///      the calls then creates or reuses that same VA. Both are computed atomically in this call.
	///      Every sendQuote in callDatas is validated against the margin key, so the margin cannot be
	///      routed to a different VA than the quote opens under.
	/// @param account The sub-account to fund and execute calls for
	/// @param isolationType The isolation type matching the sub-account's strategy
	/// @param symbolId The symbol ID for the target virtual account
	/// @param marginAmount The amount to transfer to the next VA via internalTransfer
	/// @param callDatas Array of encoded function calls to execute on the Symmio core
	/// @return Array of return data from each call
	function _callWithMargin(
		address account,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId,
		uint256 marginAmount,
		bytes[] calldata callDatas
	) external whenNotPaused nonReentrant onlyAccountOwner(account) returns (bytes[] memory) {
		LibAccountLayerMargin.addMarginToNextVA(account, isolationType, symbolId, marginAmount);
		return _executeCalls(account, callDatas, true, isolationType, symbolId);
	}

	function _executeCalls(
		address account,
		bytes[] calldata callDatas,
		bool enforceMarginKey,
		VirtualAccountIsolationType marginIsolationType,
		uint256 marginSymbolId
	) private returns (bytes[] memory) {
		if (callDatas.length == 0) revert EmptyArray();

		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		bytes[] memory results = new bytes[](callDatas.length);

		for (uint256 i = 0; i < callDatas.length; i++) {
			bytes calldata cd = callDatas[i];
			bytes4 selector = bytes4(cd[:4]);
			if (selector == ISymmio.internalTransferToBalance.selector || selector == ISymmio.zeroUpnlDeallocate.selector) revert Unauthorized();

			bool isVirtualAccount = ahLayout.virtualAccounts[account].isExists;
			bool isSubAccount = ahLayout.subAccounts[account].isExists;
			if (!isVirtualAccount && !isSubAccount) {
				// if its a deleted VA, parentAccount is still set and it must not be callable
				if (ahLayout.virtualAccounts[account].parentAccount != address(0)) revert AccountDoesNotExist();

				// legacy multi accounts
				if (LibAccountLayerUtils.resolveAccountOwner(account) == address(0)) revert AccountDoesNotExist();
				results[i] = _executeWithSigner(account, cd);
				continue;
			}

			if (
				selector == LibQuoteParams.SEND_QUOTE_SELECTOR ||
				selector == LibQuoteParams.SEND_QUOTE_WITH_AFFILIATE_SELECTOR ||
				selector == LibQuoteParams.SEND_QUOTE_WITH_AFFILIATE_AND_DATA_SELECTOR
			) {
				QuoteParams memory p = LibQuoteParams.decodeQuoteParams(cd);

				if (enforceMarginKey) {
					LibAccountLayerMargin.validateQuoteMatchesMarginKey(p, marginIsolationType, marginSymbolId);
				}

				if (isVirtualAccount) {
					results[i] = _handleVirtualAccountSendQuote(account, cd, p);
					continue;
				}

				if (isSubAccount) {
					results[i] = _handleSubAccountSendQuote(account, cd, p);
					continue;
				}
			}

			results[i] = _executeWithSigner(account, cd);
		}

		// Fire onCall hook
		LibAccountLayerUtils.callHook(
			LibAccountLayerUtils.getAffiliateForAccount(account),
			account,
			LibAccountLayerUtils.getRelatedCore(account),
			IAccountLayerHook.onCall.selector,
			abi.encodeWithSelector(IAccountLayerHook.onCall.selector, account, callDatas)
		);

		return results;
	}

	// ==================== Hook Callback ====================

	/// @notice Executes a whitelisted Symmio call on behalf of an account during an active hook context
	/// @dev Can only be called while a hook is active. The selector must be in hookAllowedSelectors.
	/// @param callData The encoded function call to execute on the Symmio core
	function executeForAccount(bytes calldata callData) external {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		HookContext memory ctx = afLayout.hookContext;

		if (!ctx.isActive) revert NoActiveHookContext();
		if (msg.sender != ctx.activeHook) revert UnauthorizedHookCaller();

		// Validate selector is whitelisted for this affiliate
		bytes4 selector = bytes4(callData[:4]);
		if (!afLayout.hookAllowedSelectors[ctx.affiliate][selector]) {
			revert SelectorNotAllowed(selector);
		}

		// Execute on symmioCore on behalf of account
		bool usesTransientSigner = LibAccountLayerUtils.beginCoreSigner(ctx.symmioCore, ctx.account);
		(bool success, bytes memory result) = LibAccountLayerUtils.callCore(ctx.symmioCore, callData);
		LibAccountLayerUtils.endCoreSigner(ctx.symmioCore, usesTransientSigner);
		if (!success) revert HookActionFailed(result);

		emit HookActionExecuted(ctx.account, ctx.affiliate, selector);
	}

	// ==================== Internal Functions ====================

	function _createSubAccount(address affiliate, address sender, SubAccountCreationData memory data) private returns (address subAccountAddress) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();

		LibAccountLayerUtils.validateName(data.name);
		if (!afLayout.whitelistedSymmioCores[data.symmioCore]) revert NotSymmioCore();
		if (afLayout.affiliates[affiliate].state != AffiliateState.ACTIVE) revert AffiliateNotActive();
		if (!afLayout.affiliates[affiliate].symmioCores.contains(data.symmioCore)) revert SymmioCoreNotAllowed();

		if (
			data.singleVAMode &&
			data.isolationType != SubAccountIsolationType.MARKET &&
			data.isolationType != SubAccountIsolationType.MARKET_DIRECTION
		) {
			revert SingleVAModeNotApplicable();
		}

		uint256 nonce = ++ahLayout.globalNonce;
		subAccountAddress = _generateSubAccountAddress(affiliate, sender, nonce);

		SubAccountData storage s = ahLayout.subAccounts[subAccountAddress];
		s.owner = sender;
		s.isExists = true;
		s.singleVAMode = data.singleVAMode;
		s.name = data.name;
		s.affiliate = affiliate;
		s.metadata = data.metadata;
		s.symmioCore = data.symmioCore;
		s.isolationType = data.isolationType;

		ahLayout.userToSubAccounts[sender].add(subAccountAddress);

		LibAccountLayerUtils.callHook(
			affiliate,
			subAccountAddress,
			data.symmioCore,
			IAccountLayerHook.onAccountCreation.selector,
			abi.encodeWithSelector(IAccountLayerHook.onAccountCreation.selector, sender, subAccountAddress, data.metadata)
		);

		emit SubAccountCreated(subAccountAddress, sender, affiliate, data.name);
	}

	function _getOrCreateVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) private returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();

		if (ahLayout.subAccounts[parentAccount].singleVAMode) {
			address existingVA = ahLayout.activeVAByKey[parentAccount][isolationType][symbolId];
			if (existingVA != address(0) && ahLayout.virtualAccounts[existingVA].isExists) {
				return existingVA;
			}
		}

		address reused = _tryReuseVirtualAccount(parentAccount, isolationType, symbolId);
		if (reused != address(0)) return reused;
		return _createVirtualAccount(parentAccount, metadata, isolationType, symbolId);
	}

	function _tryReuseVirtualAccount(address parentAccount, VirtualAccountIsolationType isolationType, uint256 symbolId) private returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		address[] storage pool = ahLayout.deletedVirtualAccountsPool[parentAccount][isolationType][symbolId];
		if (pool.length == 0) return address(0);

		address reusedAccount = pool[pool.length - 1];
		pool.pop();

		VirtualAccountData storage v = ahLayout.virtualAccounts[reusedAccount];
		v.isExists = true;

		ahLayout.subAccountToVirtualAccounts[parentAccount].add(reusedAccount);

		SubAccountData storage parent = ahLayout.subAccounts[parentAccount];

		if (parent.singleVAMode) {
			ahLayout.activeVAByKey[parentAccount][isolationType][symbolId] = reusedAccount;
		}

		// Sync bind state with parent account
		ISymmio symmio = ISymmio(parent.symmioCore);
		ISymmio.BindState memory parentBindState = symmio.getBindState(parentAccount);
		address parentPartyB =
			parentBindState.status == ISymmio.BindStatus.BOUND || parentBindState.status == ISymmio.BindStatus.PENDING_UNBIND
				? parentBindState.partyB
				: address(0);
		ISymmio.BindState memory vaBindState = symmio.getBindState(reusedAccount);

		if (vaBindState.partyB != parentPartyB) {
			if (vaBindState.partyB != address(0)) {
				if (vaBindState.status == ISymmio.BindStatus.BOUND) {
					_executeWithSymmioSigner(parent.symmioCore, reusedAccount, abi.encodeWithSelector(ISymmio.requestToUnbindFromPartyB.selector));
				}

				if (vaBindState.status == ISymmio.BindStatus.BOUND || vaBindState.status == ISymmio.BindStatus.PENDING_UNBIND) {
					_executeWithSymmioSigner(
						parent.symmioCore,
						vaBindState.partyB,
						abi.encodeWithSelector(ISymmio.completeUnbindRequest.selector, reusedAccount)
					);
				}
			}

			if (parentPartyB != address(0)) {
				_executeWithSymmioSigner(parent.symmioCore, reusedAccount, abi.encodeWithSelector(ISymmio.bindToPartyB.selector, parentPartyB));
			}
		}

		LibAccountLayerUtils.callHook(
			parent.affiliate,
			reusedAccount,
			parent.symmioCore,
			IAccountLayerHook.onVirtualAccountCreation.selector,
			abi.encodeWithSelector(IAccountLayerHook.onVirtualAccountCreation.selector, reusedAccount, parentAccount, v.metadata)
		);

		emit VirtualAccountReused(reusedAccount, parentAccount);

		return reusedAccount;
	}

	function _createVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) private returns (address virtualAccount) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		SubAccountData storage parent = ahLayout.subAccounts[parentAccount];
		if (!parent.isExists) revert InvalidParent();

		uint256 nonce = ++ahLayout.subAccountVirtualNonces[parentAccount];
		virtualAccount = LibAccountLayerUtils.generateVirtualAccountAddress(parentAccount, nonce);

		VirtualAccountData storage v = ahLayout.virtualAccounts[virtualAccount];
		v.isExists = true;
		v.metadata = metadata;
		v.parentAccount = parentAccount;
		v.isolationType = isolationType;
		v.symbolId = symbolId;

		ahLayout.subAccountToVirtualAccounts[parentAccount].add(virtualAccount);

		if (parent.singleVAMode) {
			ahLayout.activeVAByKey[parentAccount][isolationType][symbolId] = virtualAccount;
		}

		ISymmio symmio = ISymmio(parent.symmioCore);

		ISymmio.BindState memory bindState = symmio.getBindState(parentAccount);
		if (bindState.status == ISymmio.BindStatus.BOUND || bindState.status == ISymmio.BindStatus.PENDING_UNBIND) {
			LibAccountLayerUtils.executeWithSignerOnCore(
				parent.symmioCore,
				virtualAccount,
				abi.encodeWithSelector(ISymmio.bindToPartyB.selector, bindState.partyB)
			);
		}

		LibAccountLayerUtils.callHook(
			parent.affiliate,
			virtualAccount,
			parent.symmioCore,
			IAccountLayerHook.onVirtualAccountCreation.selector,
			abi.encodeWithSelector(IAccountLayerHook.onVirtualAccountCreation.selector, virtualAccount, parentAccount, metadata)
		);

		emit VirtualAccountCreated(virtualAccount, parentAccount);
	}

	function _handleVirtualAccountSendQuote(address account, bytes memory cd, QuoteParams memory p) private returns (bytes memory) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		VirtualAccountData storage accountData = ahLayout.virtualAccounts[account];
		VirtualAccountIsolationType isolationType = accountData.isolationType;

		if (
			(isolationType == VirtualAccountIsolationType.POSITION && accountData.quoteIds.length() > 0) ||
			(isolationType == VirtualAccountIsolationType.MARKET_LONG && p.positionType != ISymmio.PositionType.LONG) ||
			(isolationType == VirtualAccountIsolationType.MARKET_SHORT && p.positionType != ISymmio.PositionType.SHORT)
		) {
			revert PositionTypeNotAllowedForThisAccount();
		}

		if (
			(isolationType == VirtualAccountIsolationType.MARKET ||
				isolationType == VirtualAccountIsolationType.MARKET_LONG ||
				isolationType == VirtualAccountIsolationType.MARKET_SHORT) && p.symbolId != accountData.symbolId
		) {
			revert SymbolNotAllowedForThisAccount();
		}

		bytes memory result = _executeWithSigner(account, cd);
		accountData.quoteIds.add(ISymmio(LibAccountLayerUtils.getRelatedCore(account)).getNextQuoteId());
		return result;
	}

	function _handleSubAccountSendQuote(address account, bytes memory cd, QuoteParams memory p) private returns (bytes memory) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		SubAccountData storage accountData = ahLayout.subAccounts[account];

		if (accountData.isolationType == SubAccountIsolationType.CUSTOM) {
			return _executeWithSigner(account, cd);
		}

		address virtualAccount;
		if (accountData.isolationType == SubAccountIsolationType.POSITION) {
			virtualAccount = _getOrCreateVirtualAccount(account, hex"", VirtualAccountIsolationType.POSITION, p.symbolId);
		}

		if (accountData.isolationType == SubAccountIsolationType.MARKET)
			virtualAccount = _getOrCreateVirtualAccount(account, hex"", VirtualAccountIsolationType.MARKET, p.symbolId);

		if (accountData.isolationType == SubAccountIsolationType.MARKET_DIRECTION) {
			VirtualAccountIsolationType vType =
				p.positionType == ISymmio.PositionType.LONG ? VirtualAccountIsolationType.MARKET_LONG : VirtualAccountIsolationType.MARKET_SHORT;

			virtualAccount = _getOrCreateVirtualAccount(account, hex"", vType, p.symbolId);
		}

		bytes memory result = _executeWithSigner(virtualAccount, cd);
		ahLayout.virtualAccounts[virtualAccount].quoteIds.add(ISymmio(LibAccountLayerUtils.getRelatedCore(virtualAccount)).getNextQuoteId());
		return result;
	}

	function _executeWithSigner(address account, bytes memory callData) private returns (bytes memory) {
		address signer = LibAccountLayerUtils.getSigner();
		bytes memory result = LibAccountLayerUtils.executeWithSigner(account, callData);
		emit Call(signer, account, callData, true, result);
		return result;
	}

	function _generateSubAccountAddress(address affiliate, address user, uint256 nonce) private pure returns (address) {
		return
			address(
				uint160(
					uint256(keccak256(abi.encodePacked(bytes1(0xff), affiliate, keccak256(abi.encodePacked(user, nonce)), ACCOUNT_INIT_CODE_HASH)))
				)
			);
	}

	// ==================== Legacy Account Migration ====================

	/// @notice Imports accounts from a legacy MultiAccount contract into the AccountLayer
	/// @dev Validates ownership via the legacy contract, prevents double-import, and creates CUSTOM isolation sub-accounts
	/// @param legacyContract The registered legacy MultiAccount contract address
	/// @param affiliate The affiliate to associate imported accounts with
	/// @param symmioCores The Symmio core addresses available for the affiliate
	/// @param accountsData Import data for each account (address, name, core index)
	/// @return importedAccounts The addresses of the imported sub-accounts
	function importLegacyAccounts(
		address legacyContract,
		address affiliate,
		address[] calldata symmioCores,
		LegacyAccountImportData[] calldata accountsData
	) external whenNotPaused nonReentrant returns (address[] memory importedAccounts) {
		if (accountsData.length == 0) revert EmptyArray();

		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();

		// Validate legacy contract is registered
		if (!afLayout.legacyMultiAccounts.contains(legacyContract)) {
			revert LegacyContractNotRegistered();
		}

		// Validate affiliate is active
		if (afLayout.affiliates[affiliate].state != AffiliateState.ACTIVE) {
			revert AffiliateNotActive();
		}

		// Validate all symmioCores are allowed for this affiliate (number of symmioCores is very limited)
		for (uint256 i = 0; i < symmioCores.length; i++) {
			if (!afLayout.affiliates[affiliate].symmioCores.contains(symmioCores[i])) {
				revert SymmioCoreNotAllowed();
			}
		}

		address signer = LibAccountLayerUtils.getSigner();
		IMultiAccount multiAccount = IMultiAccount(legacyContract);
		importedAccounts = new address[](accountsData.length);

		for (uint256 i = 0; i < accountsData.length; i++) {
			LegacyAccountImportData calldata data = accountsData[i];

			// Validate coreIndex
			if (data.coreIndex >= symmioCores.length) revert InvalidCallData();

			// Validate ownership
			if (multiAccount.owners(data.account) != signer) {
				revert LegacyAccountNotOwned();
			}

			// Prevent double-import
			if (ahLayout.subAccounts[data.account].isExists) {
				revert AccountAlreadyExists();
			}

			// Validate name
			LibAccountLayerUtils.validateName(data.name);

			// Create SubAccountData
			SubAccountData storage s = ahLayout.subAccounts[data.account];
			s.owner = signer;
			s.isExists = true;
			s.singleVAMode = false;
			s.name = data.name;
			s.affiliate = affiliate;
			s.metadata = "";
			s.symmioCore = symmioCores[data.coreIndex];
			s.isolationType = SubAccountIsolationType.CUSTOM;

			ahLayout.userToSubAccounts[signer].add(data.account);
			importedAccounts[i] = data.account;

			emit LegacyAccountImported(data.account, signer, legacyContract, affiliate);
		}
	}
}
