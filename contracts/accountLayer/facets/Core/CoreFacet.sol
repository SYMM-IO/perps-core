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
import { AccountHubStorage, SubAccountData, VirtualAccountData, SubAccountCreationData, VirtualAccountIsolationType, SubAccountIsolationType } from "../../storages/AccountHubStorage.sol";
import { AffiliateHubStorage, AffiliateState, HookContext } from "../../storages/AffiliateHubStorage.sol";
import { LibAccountLayerAccessibility } from "../../libraries/LibAccountLayerAccessibility.sol";
import { LibQuoteParams, QuoteParams } from "../../libraries/LibQuoteParams.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { IAccountHubHook } from "../../interfaces/IAccountHubHook.sol";
import { IMultiAccount } from "../../interfaces/IMultiAccount.sol";

contract CoreFacet is ICoreFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");
	uint256 private constant MAX_NAME_LENGTH = 100;

	// ==================== Sub-Account Management ====================

	function createSubAccounts(
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant returns (address[] memory) {
		if (accountsData.length == 0) revert EmptyArray();

		address[] memory createdAccounts = new address[](accountsData.length);
		address signer = _getSigner();

		for (uint256 i = 0; i < accountsData.length; i++) {
			createdAccounts[i] = _createSubAccount(affiliate, signer, accountsData[i]);
		}

		return createdAccounts;
	}

	function editAccountName(address account, string memory name) external whenNotPaused onlyAccountOwner(account) {
		_validateName(name);

		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		if (!ahLayout.subAccounts[account].isExists) revert AccountDoesNotExist();

		ahLayout.subAccounts[account].name = name;
		emit EditAccountName(account, name);
	}

	function setSingleVAMode(address subAccount, bool enabled) external whenNotPaused onlyAccountOwner(subAccount) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
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

	// ==================== Virtual Account Management ====================

	function createCustomVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external whenNotPaused nonReentrant onlyAccountOwner(parentAccount) returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		SubAccountData storage parent = ahLayout.subAccounts[parentAccount];

		if (parent.isolationType != SubAccountIsolationType.CUSTOM) {
			revert OnlyCustomIsolationCanCreateManually();
		}

		return _getOrCreateVirtualAccount(parentAccount, metadata, isolationType, symbolId);
	}

	// ==================== Call Execution ====================

	function _call(address account, bytes[] calldata callDatas) external whenNotPaused nonReentrant returns (bytes[] memory) {
		if (callDatas.length == 0) revert EmptyArray();

		address signer = _getSigner();
		if (!_isOwnerOf(account, signer) && !LibAccountLayerAccessibility.hasRole(msg.sender, LibAccountLayerAccessibility.INSTANT_LAYER_ROLE)) {
			revert NotOwner();
		}

		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		bytes[] memory results = new bytes[](callDatas.length);

		for (uint256 i = 0; i < callDatas.length; i++) {
			bytes calldata cd = callDatas[i];
			bytes4 selector = bytes4(cd[:4]);

			if (
				selector == LibQuoteParams.SEND_QUOTE_SELECTOR ||
				selector == LibQuoteParams.SEND_QUOTE_WITH_AFFILIATE_SELECTOR ||
				selector == LibQuoteParams.SEND_QUOTE_WITH_AFFILIATE_AND_DATA_SELECTOR
			) {
				QuoteParams memory p = LibQuoteParams.decodeQuoteParams(cd);

				if (ahLayout.virtualAccounts[account].isExists) {
					results[i] = _handleVirtualAccountSendQuote(account, cd, p);
					return results;
				}

				if (ahLayout.subAccounts[account].isExists) {
					results[i] = _handleSubAccountSendQuote(account, cd, p);
					return results;
				}
			}

			results[i] = _executeWithSigner(account, cd);
		}

		return results;
	}

	// ==================== Hook Callback ====================

	function executeForAccount(bytes calldata callData) external {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		HookContext memory ctx = afLayout.hookContext;

		if (!ctx.isActive) revert NoActiveHookContext();

		// Validate selector is whitelisted for this affiliate
		bytes4 selector = bytes4(callData[:4]);
		if (!afLayout.hookAllowedSelectors[ctx.affiliate][selector]) {
			revert SelectorNotAllowed(selector);
		}

		// Execute on symmioCore on behalf of account
		ISymmio symmio = ISymmio(ctx.symmioCore);
		symmio.setSigner(ctx.account);
		(bool success, bytes memory result) = ctx.symmioCore.call(callData);
		symmio.setSigner(address(0));

		if (!success) {
			revert HookActionFailed(result);
		}

		emit HookActionExecuted(ctx.account, ctx.affiliate, selector);
	}

	// ==================== Internal Functions ====================

	function _getSigner() internal view returns (address) {
		address signer = AccountHubStorage.layout().globalSigner;
		return signer == address(0) ? msg.sender : signer;
	}

	function _validateName(string memory name) private pure {
		if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_LENGTH) {
			revert InvalidNameLength();
		}
	}

	function _createSubAccount(address affiliate, address sender, SubAccountCreationData memory data) private returns (address subAccountAddress) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		_validateName(data.name);
		if (!afLayout.whitelistedSymmioCores[data.symmioCore]) revert NotSymmioCore();
		if (afLayout.affiliates[affiliate].state != AffiliateState.ACTIVE) revert AffiliateNotActive();

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

		_callHook(
			affiliate,
			subAccountAddress,
			data.symmioCore,
			IAccountHubHook.onAccountCreation.selector,
			abi.encodeWithSelector(IAccountHubHook.onAccountCreation.selector, sender, subAccountAddress, data.metadata)
		);

		emit SubAccountCreated(subAccountAddress, sender, affiliate, data.name);
	}

	function _getOrCreateVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) private returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

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
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
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

		_callHook(
			parent.affiliate,
			reusedAccount,
			parent.symmioCore,
			IAccountHubHook.onVirtualAccountCreation.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountCreation.selector, reusedAccount, parentAccount, v.metadata)
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
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		SubAccountData storage parent = ahLayout.subAccounts[parentAccount];
		if (!parent.isExists) revert InvalidParent();

		uint256 nonce = ++ahLayout.subAccountVirtualNonces[parentAccount];
		virtualAccount = _generateVirtualAccountAddress(parentAccount, nonce);

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
		if (bindState.status == ISymmio.BindStatus.BOUND) {
			symmio.setSigner(virtualAccount);
			symmio.bindToPartyB(bindState.partyB);
			symmio.setSigner(address(0));
		}

		_callHook(
			parent.affiliate,
			virtualAccount,
			parent.symmioCore,
			IAccountHubHook.onVirtualAccountCreation.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountCreation.selector, virtualAccount, parentAccount, metadata)
		);

		emit VirtualAccountCreated(virtualAccount, parentAccount);
	}

	function _deleteVirtualAccount(address account) internal {
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
			account,
			core,
			IAccountHubHook.onVirtualAccountDeletion.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountDeletion.selector, account)
		);

		emit VirtualAccountDeleted(account, parentAccount);
	}

	function _handleVirtualAccountSendQuote(address account, bytes memory cd, QuoteParams memory p) private returns (bytes memory) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
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
		accountData.quoteIds.add(ISymmio(_getRelatedCore(account)).getNextQuoteId());
		return result;
	}

	function _handleSubAccountSendQuote(address account, bytes memory cd, QuoteParams memory p) private returns (bytes memory) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
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
			VirtualAccountIsolationType vType = p.positionType == ISymmio.PositionType.LONG
				? VirtualAccountIsolationType.MARKET_LONG
				: VirtualAccountIsolationType.MARKET_SHORT;

			virtualAccount = _getOrCreateVirtualAccount(account, hex"", vType, p.symbolId);
		}

		bytes memory result = _executeWithSigner(virtualAccount, cd);
		ahLayout.virtualAccounts[virtualAccount].quoteIds.add(ISymmio(_getRelatedCore(virtualAccount)).getNextQuoteId());
		return result;
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
		address signer = _getSigner();
		address core = _getRelatedCore(account);

		ISymmio(core).setSigner(account);
		(bool success, bytes memory result) = core.call(callData);
		ISymmio(core).setSigner(address(0));

		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}

		emit Call(signer, account, callData, true, result);
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

		revert("CoreFacet: Unable to retrieve core");
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

	function _callHook(address affiliate, address account, address symmioCore, bytes4 selector, bytes memory data) private {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		address hook = afLayout.affiliates[affiliate].hooks[selector];
		if (hook == address(0)) return;

		// Set hook context before calling
		afLayout.hookContext = HookContext({ account: account, affiliate: affiliate, symmioCore: symmioCore, isActive: true });

		(bool success, bytes memory result) = hook.call(data);

		// Clear hook context after call
		delete afLayout.hookContext;

		if (!success) {
			revert HookFailed(result);
		}
	}

	function _generateSubAccountAddress(address affiliate, address user, uint256 nonce) private pure returns (address) {
		return
			address(
				uint160(
					uint256(keccak256(abi.encodePacked(bytes1(0xff), affiliate, keccak256(abi.encodePacked(user, nonce)), ACCOUNT_INIT_CODE_HASH)))
				)
			);
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
