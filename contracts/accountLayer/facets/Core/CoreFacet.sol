// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ICoreFacet } from "./ICoreFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { AccountLayerReentrancyGuard } from "../../utils/AccountLayerReentrancyGuard.sol";
import {
	AccountHubStorage,
	SubAccountData,
	VirtualAccountData,
	SubAccountCreationData,
	VirtualAccountIsolationType,
	SubAccountIsolationType,
	LegacyAccountImportData
} from "../../storages/AccountHubStorage.sol";
import { AffiliateHubStorage, AffiliateState, HookContext } from "../../storages/AffiliateHubStorage.sol";
import { LibQuoteParams, QuoteParams } from "../../libraries/LibQuoteParams.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { LibAccountLayerSafeCall } from "../../libraries/LibAccountLayerSafeCall.sol";
import { LibAccountLayerSafeERC20 } from "../../libraries/LibAccountLayerSafeERC20.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { IAccountHubHook } from "../../interfaces/IAccountHubHook.sol";
import { IVirtualProvider } from "../../../core/interfaces/IVirtualProvider.sol";
import { IMultiAccount } from "../../interfaces/IMultiAccount.sol";

contract CoreFacet is ICoreFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");

	// ==================== Sub-Account Management ====================

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

	function editAccountName(address account, string memory name) external whenNotPaused onlyAccountOwner(account) {
		LibAccountLayerUtils.validateName(name);

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

	function deleteSubAccount(address subAccount) external whenNotPaused nonReentrant onlyAccountOwner(subAccount) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		SubAccountData storage s = ahLayout.subAccounts[subAccount];

		if (!s.isExists) revert AccountDoesNotExist();

		// Require all VirtualAccounts to be deleted first
		if (ahLayout.subAccountToVirtualAccounts[subAccount].length() > 0) {
			revert HasActiveVirtualAccounts();
		}

		// Check that the account is empty in symmio
		ISymmio symmio = ISymmio(s.symmioCore);

		// Check balance is 0
		if (symmio.balanceOf(subAccount) > 0) revert SubAccountNotEmpty();

		// Check allocated balance is 0
		if (symmio.allocatedBalanceOfPartyA(subAccount) > 0) revert SubAccountNotEmpty();

		// Check no open positions
		if (symmio.partyAPositionsCount(subAccount) > 0) revert OpenPositionsExist();

		// Check no pending quotes
		uint256[] memory pendingQuotes = symmio.getPartyAPendingQuotes(subAccount);
		if (pendingQuotes.length > 0) revert PendingQuotesExist();

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
			IAccountHubHook.onSubAccountDeletion.selector,
			abi.encodeWithSelector(IAccountHubHook.onSubAccountDeletion.selector, subAccount, owner)
		);

		emit SubAccountDeleted(subAccount, owner, affiliate);
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

	// ==================== Deposit Functions ====================

	function depositForAccount(address account, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(account) {
		_depositToSymmio(account, amount, ISymmio.depositFor.selector);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(account) {
		_depositToSymmio(account, amount, ISymmio.depositAndAllocateFor.selector);
	}

	function _depositToSymmio(address account, uint256 amount, bytes4 depositSelector) private {
		if (amount == 0) revert ZeroAmount();

		address core = LibAccountLayerUtils.getRelatedCore(account);

		// Deposit directly from the signer into Symmio
		address signer = LibAccountLayerUtils.getSigner();
		_executeWithSymmioSigner(core, signer, abi.encodeWithSelector(depositSelector, account, amount));
	}

	function depositForAccountWithExpressRate(address account, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(account) {
		(uint256 expressRate, address virtualProvider) = _getExpressDepositConfig(account);
		_depositWithExpressSplit(account, amount, ISymmio.depositFor.selector, expressRate, virtualProvider);
	}

	function depositAndAllocateForAccountWithExpressRate(
		address account,
		uint256 amount
	) external whenNotPaused nonReentrant onlyAccountOwner(account) {
		(uint256 expressRate, address virtualProvider) = _getExpressDepositConfig(account);
		_depositWithExpressSplit(account, amount, ISymmio.depositAndAllocateFor.selector, expressRate, virtualProvider);
	}

	function _getExpressDepositConfig(address account) private view returns (uint256 expressRate, address virtualProvider) {
		address affiliate = LibAccountLayerUtils.getAffiliateForAccount(account);
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();

		expressRate = afLayout.affiliates[affiliate].expressRate;
		virtualProvider = afLayout.affiliates[affiliate].virtualProvider;

		if (expressRate > 1e18) revert InvalidExpressRate();
		if (expressRate > 0 && virtualProvider == address(0)) revert VirtualProviderRequired();
	}

	function _depositWithExpressSplit(address account, uint256 amount, bytes4 depositSelector, uint256 expressRate, address virtualProvider) private {
		if (amount == 0) revert ZeroAmount();

		address core = LibAccountLayerUtils.getRelatedCore(account);
		address collateral = ISymmio(core).getCollateral();
		uint256 collateralDecimals = IERC20Metadata(collateral).decimals();

		bool usesAllocation = depositSelector == ISymmio.depositAndAllocateFor.selector;

		// Get balances before deposit to calculate increase
		uint256 balanceBefore = ISymmio(core).balanceOf(account);
		uint256 allocatedBefore = usesAllocation ? ISymmio(core).allocatedBalanceOfPartyA(account) : 0;

		// Pull funds into AccountLayer to support splitting between Symmio and VirtualProvider
		address signer = LibAccountLayerUtils.getSigner();
		LibAccountLayerSafeERC20.safeTransferFrom(collateral, signer, address(this), amount);

		// Calculate split: virtualAmount = amount * expressRate / 1e18
		uint256 virtualAmount = (amount * expressRate) / 1e18;
		uint256 realAmount = amount - virtualAmount;

		// Deposit (and optionally allocate) real portion to Symmio Diamond
		if (realAmount > 0) {
			LibAccountLayerSafeERC20.safeIncreaseAllowance(collateral, core, realAmount);
			_executeWithSymmioSigner(core, address(this), abi.encodeWithSelector(depositSelector, account, realAmount));
		}

		// Transfer virtual portion to Virtual Provider and invoke callback
		if (virtualAmount > 0) {
			LibAccountLayerSafeERC20.safeTransfer(collateral, virtualProvider, virtualAmount);
			// Use safe call to prevent virtualProvider from impersonating user via getSigner()
			LibAccountLayerSafeCall.safeExternalCall(
				virtualProvider,
				abi.encodeWithSelector(IVirtualProvider.onExpressDeposit.selector, account, virtualAmount, core)
			);
		}

		// Enforce invariant: input_amount == balanceOf(account) increase (including allocation if used)
		uint256 balanceAfter = ISymmio(core).balanceOf(account);
		uint256 allocatedAfter = usesAllocation ? ISymmio(core).allocatedBalanceOfPartyA(account) : 0;
		uint256 balanceIncrease = balanceAfter - balanceBefore;
		uint256 allocatedIncrease = usesAllocation ? allocatedAfter - allocatedBefore : 0;
		uint256 expectedIncrease = (amount * 1e18) / (10 ** collateralDecimals);
		if (balanceIncrease + allocatedIncrease != expectedIncrease) revert BalanceInvariantViolation();
	}

	function _executeWithSymmioSigner(address symmio, address signer, bytes memory callData) private returns (bytes memory) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		address previousSigner = ahLayout.globalSigner;
		ahLayout.globalSigner = address(0);

		ISymmio(symmio).setSigner(signer);
		(bool success, bytes memory result) = symmio.call(callData);
		ISymmio(symmio).setSigner(address(0));

		ahLayout.globalSigner = previousSigner;

		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}

		return result;
	}

	// ==================== Call Execution ====================

	function _call(
		address account,
		bytes[] calldata callDatas
	) external whenNotPaused nonReentrant onlyAccountOwner(account) returns (bytes[] memory) {
		if (callDatas.length == 0) revert EmptyArray();

		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		bytes[] memory results = new bytes[](callDatas.length);

		for (uint256 i = 0; i < callDatas.length; i++) {
			bytes calldata cd = callDatas[i];
			bytes4 selector = bytes4(cd[:4]);
			if (selector == ISymmio.internalTransferToBalance.selector) revert Unauthorized();

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

	function _createSubAccount(address affiliate, address sender, SubAccountCreationData memory data) private returns (address subAccountAddress) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

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
			symmio.setSigner(virtualAccount);
			symmio.bindToPartyB(bindState.partyB);
			symmio.setSigner(address(0));
		}

		LibAccountLayerUtils.callHook(
			parent.affiliate,
			virtualAccount,
			parent.symmioCore,
			IAccountHubHook.onVirtualAccountCreation.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountCreation.selector, virtualAccount, parentAccount, metadata)
		);

		emit VirtualAccountCreated(virtualAccount, parentAccount);
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
		accountData.quoteIds.add(ISymmio(LibAccountLayerUtils.getRelatedCore(account)).getNextQuoteId());
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

	function importLegacyAccounts(
		address legacyContract,
		address affiliate,
		address[] calldata symmioCores,
		LegacyAccountImportData[] calldata accountsData
	) external whenNotPaused nonReentrant returns (address[] memory importedAccounts) {
		if (accountsData.length == 0) revert EmptyArray();

		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

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
