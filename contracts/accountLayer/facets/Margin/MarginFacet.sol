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
import { AccountStorage, VirtualAccountIsolationType, SubAccountIsolationType } from "../../storages/AccountStorage.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";

/// @notice Facet for transferring margin between sub-accounts and virtual accounts
contract MarginFacet is IMarginFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;

	/// @notice Transfers deposited balance from a parent sub-account to a virtual account's allocated balance
	/// @param virtualAccount The virtual account to add margin to
	/// @param amount The amount to transfer via internalTransfer
	function addMargin(address virtualAccount, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(virtualAccount) {
		if (amount == 0) revert ZeroAmount();

		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		if (!ahLayout.virtualAccounts[virtualAccount].isExists) revert NotVirtualAccount();
		address parent = ahLayout.virtualAccounts[virtualAccount].parentAccount;

		LibAccountLayerUtils.executeWithSigner(parent, abi.encodeWithSelector(ISymmio.internalTransfer.selector, virtualAccount, amount));

		emit AddMargin(virtualAccount, parent, amount);
	}

	/// @notice Pre-funds the next virtual account that will be created for a given isolation key
	/// @dev Predicts the next VA address (from pool or nonce) and transfers margin to it
	/// @param subAccount The parent sub-account
	/// @param isolationType The isolation type matching the sub-account's strategy
	/// @param symbolId The symbol ID for the target virtual account
	/// @param amount The amount to transfer via internalTransfer
	function addMarginToNextVA(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId,
		uint256 amount
	) external whenNotPaused nonReentrant onlyAccountOwner(subAccount) {
		if (amount == 0) revert ZeroAmount();

		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		if (!ahLayout.subAccounts[subAccount].isExists) revert AccountDoesNotExist();
		SubAccountIsolationType subIsolation = ahLayout.subAccounts[subAccount].isolationType;

		bool validIsolation = false;
		if (subIsolation == SubAccountIsolationType.POSITION) {
			validIsolation = isolationType == VirtualAccountIsolationType.POSITION;
		} else if (subIsolation == SubAccountIsolationType.MARKET) {
			validIsolation = isolationType == VirtualAccountIsolationType.MARKET;
		} else if (subIsolation == SubAccountIsolationType.MARKET_DIRECTION) {
			validIsolation = isolationType == VirtualAccountIsolationType.MARKET_LONG || isolationType == VirtualAccountIsolationType.MARKET_SHORT;
		}

		if (!validIsolation) revert InvalidIsolationType();

		address predictedVA = _predictNextVirtualAccountAddress(subAccount, isolationType, symbolId);

		LibAccountLayerUtils.executeWithSigner(subAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, predictedVA, amount));

		emit AddMargin(predictedVA, subAccount, amount);
	}

	/// @notice Deallocates and transfers margin from a virtual account back to its parent sub-account
	/// @param virtualAccount The virtual account to remove margin from
	/// @param amount The amount to deallocate and transfer
	/// @param upnlSig The Muon signature proving the account's unrealized PnL
	function removeMargin(
		address virtualAccount,
		uint256 amount,
		ISymmio.SingleUpnlSig memory upnlSig
	) external whenNotPaused nonReentrant onlyAccountOwner(virtualAccount) {
		if (amount == 0) revert ZeroAmount();

		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		if (!ahLayout.virtualAccounts[virtualAccount].isExists) revert NotVirtualAccount();
		address parent = ahLayout.virtualAccounts[virtualAccount].parentAccount;

		LibAccountLayerUtils.executeWithSigner(virtualAccount, abi.encodeWithSelector(ISymmio.deallocate.selector, amount, upnlSig));
		LibAccountLayerUtils.executeWithSigner(virtualAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, parent, amount));

		emit RemoveMargin(virtualAccount, parent, amount);
	}

	/// @notice Recovers funds from a lost virtual account address back to its parent sub-account
	/// @dev Used when a VA address has funds but was never formally created or was orphaned
	/// @param subAccount The parent sub-account to recover funds to
	/// @param nonce The nonce used to derive the lost virtual account address
	function emergencyRecoverMargin(address subAccount, uint256 nonce) external whenNotPaused nonReentrant onlyAccountOwner(subAccount) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		if (!ahLayout.subAccounts[subAccount].isExists) revert AccountDoesNotExist();

		uint256 currentNonce = ahLayout.subAccountVirtualNonces[subAccount];
		if (nonce == 0 || nonce > currentNonce + 1) revert InvalidNonce();

		address lostAccount = LibAccountLayerUtils.generateVirtualAccountAddress(subAccount, nonce);
		if (ahLayout.subAccounts[lostAccount].isExists || ahLayout.virtualAccounts[lostAccount].isExists) {
			revert AccountAlreadyExists();
		}

		address core = LibAccountLayerUtils.getRelatedCore(subAccount);
		uint256 allocatedBalance = ISymmio(core).allocatedBalanceOfPartyA(lostAccount);
		uint256 balance = ISymmio(core).balanceOf(lostAccount);
		if (allocatedBalance + balance == 0) revert ZeroAmount();

		if (allocatedBalance > 0) {
			_executeWithSymmioSigner(core, lostAccount, abi.encodeWithSelector(ISymmio.zeroUpnlDeallocate.selector, allocatedBalance));
		}

		uint256 totalBalance = ISymmio(core).balanceOf(lostAccount);
		if (totalBalance > 0) {
			_executeWithSymmioSigner(core, lostAccount, abi.encodeWithSelector(ISymmio.internalTransferToBalance.selector, subAccount, totalBalance));
		}

		emit EmergencyMarginRecovered(lostAccount, subAccount, totalBalance);
	}

	// ==================== Internal Functions ====================

	function _predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) private view returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();

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

	function _executeWithSymmioSigner(address symmio, address signer, bytes memory callData) private returns (bytes memory) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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
}
