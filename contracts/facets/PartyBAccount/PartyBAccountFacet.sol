// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IPartyBAccountFacet } from "./IPartyBAccountFacet.sol";
import { PartyBAccountFacetImpl } from "./PartyBAccountFacetImpl.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { SingleUpnlSig } from "../../storages/MuonStorage.sol";

contract PartyBAccountFacet is Accessibility, Pausable, IPartyBAccountFacet {
	/// @notice Allows Party B to allocate a specified amount of collateral for an specified partyA.
	/// @dev This function can only be called by Party B when Party B actions are not paused and Party B is not liquidated.
	/// @param amount The precise amount of collateral to be allocated, specified in 18 decimals.
	/// @param partyA The address of Party A
	function allocateForPartyB(
		uint256 amount,
		address partyA
	) public whenNotPartyBActionsPaused notLiquidatedPartyB(LibSigner.getSigner(), partyA) onlyPartyB {
		address signer = LibSigner.getSigner();
		PartyBAccountFacetImpl.allocateForPartyB(amount, partyA);
		emit AllocateForPartyB(signer, partyA, amount, AccountStorage.layout().partyBAllocatedBalances[signer][partyA]);
		emit SharedEvents.BalanceChangePartyB(signer, partyA, amount, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	/// @notice Allows Party B to deallocate a specified amount of collateral
	/// @dev This function can only be called by Party B when Party B actions are not paused and neither Party A nor Party B is liquidated.
	/// @param amount The precise amount of collateral to be deallocated, specified in decimals.
	/// @param partyA The address of Party A
	/// @param upnlSig The Muon signature for SingleUpnlSig.
	function deallocateForPartyB(
		uint256 amount,
		address partyA,
		SingleUpnlSig memory upnlSig
	)
		external
		whenNotPartyBActionsPaused
		notLiquidatedPartyB(LibSigner.getSigner(), partyA)
		notSuspended(LibSigner.getSigner())
		notLiquidatedPartyA(partyA)
		onlyPartyB
	{
		address signer = LibSigner.getSigner();
		PartyBAccountFacetImpl.deallocateForPartyB(amount, partyA, upnlSig);
		emit DeallocateForPartyB(signer, partyA, amount, AccountStorage.layout().partyBAllocatedBalances[signer][partyA]);
		emit SharedEvents.BalanceChangePartyB(signer, partyA, amount, SharedEvents.BalanceChangeType.DEALLOCATE);
	}

	/// @notice Allows transferring the allocation of partyB from one party A to another.
	/// @param amount The precise amount of collateral to be transferred, specified in decimals.
	/// @param origin The address of the party A whose allocation is being transferred.
	/// @param recipient The address of the party A who will receive the transferred allocation.
	/// @param upnlSig The Muon signature for SingleUpnlSig.
	function transferAllocation(uint256 amount, address origin, address recipient, SingleUpnlSig memory upnlSig) external whenNotPartyBActionsPaused {
		address signer = LibSigner.getSigner();
		PartyBAccountFacetImpl.transferAllocation(amount, origin, recipient, upnlSig);
		emit TransferAllocation(
			amount,
			origin,
			AccountStorage.layout().partyBAllocatedBalances[signer][origin],
			recipient,
			AccountStorage.layout().partyBAllocatedBalances[signer][recipient]
		);
		emit SharedEvents.BalanceChangePartyB(signer, origin, amount, SharedEvents.BalanceChangeType.DEALLOCATE);
		emit SharedEvents.BalanceChangePartyB(signer, recipient, amount, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	/// @notice Allows transferring the balance of partyB to emergency reserve vault.
	/// @param amount The precise amount of collateral to be transferred to emergency reserve vault, specified in 18 decimals.
	function depositToReserveVault(
		uint256 amount,
		address partyB
	) external whenNotPartyBActionsPaused notSuspended(LibSigner.getSigner()) notSuspended(partyB) {
		PartyBAccountFacetImpl.depositToReserveVault(amount, partyB);
		emit DepositToReserveVault(LibSigner.getSigner(), partyB, amount);
	}

	/// @notice Allows transferring the balance of partyB in emergency reserve vault to balance.
	/// @param amount The precise amount of collateral to be transferred from emergency reserve vault, specified in 18 decimals.
	function withdrawFromReserveVault(uint256 amount) external whenNotPartyBActionsPaused notSuspended(LibSigner.getSigner()) {
		PartyBAccountFacetImpl.withdrawFromReserveVault(amount);
		emit WithdrawFromReserveVault(LibSigner.getSigner(), amount);
	}

	/// @notice Activates master account mode for Party B
	/// @dev Can only be called by Party B when not paused and not suspended
	function activateMasterAccountMode() external whenNotPartyBActionsPaused notSuspended(LibSigner.getSigner()) onlyPartyB {
		PartyBAccountFacetImpl.activateMasterAccountMode();
		emit ActivateMasterAccountMode(LibSigner.getSigner());
	}
}
