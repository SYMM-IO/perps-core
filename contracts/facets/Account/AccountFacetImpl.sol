// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../../storages/AccountStorage.sol";
import "../../storages/QuoteStorage.sol";
import "../../storages/GlobalAppStorage.sol";
import "../../storages/MAStorage.sol";
import "../../libraries/muon/LibMuonAccount.sol";
import "../../libraries/LibAccount.sol";
import "../../interfaces/IExternalTransferRelayer.sol";
import "../../libraries/LibSigner.sol";
import {WithdrawStorage} from "../../storages/WithdrawStorage.sol";
import {IVirtualProvider} from "../../interfaces/IVirtualProvider.sol";

library AccountFacetImpl {
	using SafeERC20 for IERC20;

	function deposit(address user, uint256 amount) internal {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		IERC20(appLayout.collateral).safeTransferFrom(LibSigner.getSigner(), address(this), amount);
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		AccountStorage.layout().balances[user] += amountWith18Decimals;
	}

	function virtualDepositFor(address user, uint256 amount) internal {
		AccountStorage.layout().balances[user] += amount;
	}

	function withdraw(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		require(appLayout.deprecateOldWithdrawalPaused == false, "This Withdrawal has been deprecated use new one;");
		require(
			block.timestamp >= accountLayout.withdrawCooldown[LibSigner.getSigner()] + MAStorage.layout().deallocateCooldown,
			"AccountFacet: Cooldown hasn't reached"
		);
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		accountLayout.balances[LibSigner.getSigner()] -= amountWith18Decimals;
		IERC20(appLayout.collateral).safeTransfer(user, amount);
	}

	function withdrawSuspendedUser(address user, address recipient, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		accountLayout.balances[user] -= amountWith18Decimals;
		accountLayout.balances[recipient] += amountWith18Decimals;
	}

	function deallocateSuspendedUser(address user, uint256 amount) internal returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(accountLayout.allocatedBalances[user] >= amount, "AccountFacet: Insufficient allocated Balance");
		accountLayout.allocatedBalances[user] -= amount;
		accountLayout.balances[user] += amount;
		return accountLayout.allocatedBalances[user];
	}

	function allocate(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(
			accountLayout.allocatedBalances[user] + amount <= GlobalAppStorage.layout().balanceLimitPerUser,
			"AccountFacet: Allocated balance limit reached"
		);
		require(accountLayout.balances[user] >= amount, "AccountFacet: Insufficient balance");
		accountLayout.balances[user] -= amount;
		accountLayout.allocatedBalances[user] += amount;
	}

	function deallocate(uint256 amount, SingleUpnlSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(
			block.timestamp >= accountLayout.withdrawCooldown[LibSigner.getSigner()] + MAStorage.layout().deallocateDebounceTime,
			"AccountFacet: Too many deallocate in a short window"
		);
		require(accountLayout.allocatedBalances[LibSigner.getSigner()] >= amount, "AccountFacet: Insufficient allocated Balance");
		LibMuonAccount.verifyPartyAUpnl(upnlSig, LibSigner.getSigner());
		int256 availableBalance = LibAccount.partyAAvailableForQuote(upnlSig.upnl, LibSigner.getSigner());
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "AccountFacet: partyA will be liquidatable");

		accountLayout.allocatedBalances[LibSigner.getSigner()] -= amount;
		accountLayout.balances[LibSigner.getSigner()] += amount;
		accountLayout.withdrawCooldown[LibSigner.getSigner()] = block.timestamp;
	}

	function zeroUpnlDeallocate(uint256 amount, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		require(accountLayout.allocatedBalances[LibSigner.getSigner()] >= amount, "AccountFacet: Insufficient allocated Balance");
		require(
			quoteLayout.partyAPendingQuotes[partyA].length + quoteLayout.partyAOpenPositions[partyA].length == 0,
			"AccountFacet: PartyA has Open/Pending position"
		);

		accountLayout.allocatedBalances[LibSigner.getSigner()] -= amount;
		accountLayout.balances[LibSigner.getSigner()] += amount;
	}

	function transferAllocation(uint256 amount, address origin, address recipient, SingleUpnlSig memory upnlSig) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(!maLayout.partyBLiquidationStatus[LibSigner.getSigner()][origin], "PartyBFacet: PartyB isn't solvent");
		require(!maLayout.partyBLiquidationStatus[LibSigner.getSigner()][recipient], "PartyBFacet: PartyB isn't solvent");
		require(!maLayout.liquidationStatus[origin], "PartyBFacet: Origin isn't solvent");
		require(!maLayout.liquidationStatus[recipient], "PartyBFacet: Recipient isn't solvent");
		require(!accountLayout.crossLiquidationDetails[LibSigner.getSigner()].inProgress, "PartyBFacet: PartyB isn't solvent");

		// deallocate from origin
		require(accountLayout.partyBAllocatedBalances[LibSigner.getSigner()][origin] >= amount, "PartyBFacet: Insufficient locked balance");
		LibMuonAccount.verifyPartyBUpnl(upnlSig, LibSigner.getSigner(), origin);
		int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, LibSigner.getSigner(), origin);
		require(availableBalance >= 0, "PartyBFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "PartyBFacet: Will be liquidatable");

		accountLayout.partyBAllocatedBalances[LibSigner.getSigner()][origin] -= amount;
		// allocate for recipient
		accountLayout.partyBAllocatedBalances[LibSigner.getSigner()][recipient] += amount;
	}

	function internalTransfer(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(
			accountLayout.allocatedBalances[user] + amount <= GlobalAppStorage.layout().balanceLimitPerUser,
			"AccountFacet: Allocated balance limit reached"
		);
		require(accountLayout.balances[LibSigner.getSigner()] >= amount, "AccountFacet: Insufficient balance");
		accountLayout.balances[LibSigner.getSigner()] -= amount;
		accountLayout.allocatedBalances[user] += amount;
	}

	function allocateForPartyB(uint256 amount, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(accountLayout.balances[LibSigner.getSigner()] >= amount, "AccountFacet: Insufficient balance");
		require(!MAStorage.layout().partyBLiquidationStatus[LibSigner.getSigner()][partyA], "AccountFacet: PartyB isn't solvent");
		require(!accountLayout.crossLiquidationDetails[LibSigner.getSigner()].inProgress, "AccountFacet: PartyB isn't solvent");

		accountLayout.balances[LibSigner.getSigner()] -= amount;
		accountLayout.partyBAllocatedBalances[LibSigner.getSigner()][partyA] += amount;
	}

	function deallocateForPartyB(uint256 amount, address partyA, SingleUpnlSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(accountLayout.partyBAllocatedBalances[LibSigner.getSigner()][partyA] >= amount, "AccountFacet: Insufficient allocated balance");
		LibMuonAccount.verifyPartyBUpnl(upnlSig, LibSigner.getSigner(), partyA);
		int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, LibSigner.getSigner(), partyA);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "AccountFacet: Will be liquidatable");

		accountLayout.partyBAllocatedBalances[LibSigner.getSigner()][partyA] -= amount;
		accountLayout.balances[LibSigner.getSigner()] += amount;
		accountLayout.withdrawCooldown[LibSigner.getSigner()] = block.timestamp;
	}

	function depositToReserveVault(uint256 amount, address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(amount <= accountLayout.balances[LibSigner.getSigner()], "AccountFacet: Insufficient balance");
		require(MAStorage.layout().partyBStatus[partyB], "AccountFacet: Should be partyB");
		accountLayout.balances[LibSigner.getSigner()] -= amount;
		accountLayout.reserveVault[partyB] += amount;
	}

	function withdrawFromReserveVault(uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(amount > 0 && amount <= accountLayout.reserveVault[LibSigner.getSigner()], "AccountFacet: Insufficient balance");
		accountLayout.reserveVault[LibSigner.getSigner()] -= amount;
		accountLayout.balances[LibSigner.getSigner()] += amount;
		accountLayout.withdrawCooldown[LibSigner.getSigner()] = block.timestamp;
	}

	function activateMasterAccountMode() internal {
		require(
			GlobalAppStorage.layout().masterAccountActivationMode,
			"AccountFacet: Master account activation disabled"
		);
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(!accountLayout.masterAccountMode[LibSigner.getSigner()], "AccountFacet: Master account mode is active");
		accountLayout.masterAccountMode[LibSigner.getSigner()] = true;
	}

	function externalTransfer(address sender, address receiver, uint256 amount, address target) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		require(amount > 0, "AccountFacet: Amount is zero");
		require(receiver != address(0) && target != address(0), "AccountFacet: Zero receiver or target");
		address relayer = accountLayout.externalTransferTargetsRelayers[target];
		require(relayer != address(0), "AccountFacet: Target not whitelisted");

		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		accountLayout.balances[sender] -= amountWith18Decimals;
		require(IERC20(appLayout.collateral).balanceOf(address(this)) - withdrawLayout.withdrawLockedBalance >= amount, "AccountFacet: Insufficient contract balance");
		IERC20(appLayout.collateral).safeTransfer(relayer, amount);

		IExternalTransferRelayer(relayer).onTransfer(appLayout.collateral, sender, receiver, amount, target);
	}

	function virtualExternalTransfer(address sender, address receiver, uint256 amount, address target, address virtualProvider) internal returns (uint256){
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		// Input Checks
		require(amount > 0, "AccountFacet: Amount is zero");
		require(receiver != address(0) && target != address(0), "AccountFacet: Zero Receiver or Zero Target");
		require(appLayout.virtualProviders[virtualProvider], "AccountFacet: Invalid virtual provider");

		// Balance Adjustment
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		require(amountWith18Decimals <= accountLayout.balances[sender], "AccountFacet: Insufficient balance");
		accountLayout.balances[sender] -= amountWith18Decimals;

		// State Update
		uint256 currentId = ++accountLayout.lastExternalTransferId;
		ExternalTransferReq memory externalTransferReq = ExternalTransferReq({
			id: currentId,
			sender: sender,
			receiver: receiver,
			source: address(this),
			target: target,
			amount: amount,
			timestamp: block.timestamp,
			provider: virtualProvider,
			status: ExternalTransferStatus.PENDING
		});
		accountLayout.externalTransfers[currentId] = externalTransferReq;

		// Callback to Virtual Provider
		IVirtualProvider(virtualProvider).onExternalTransfer(externalTransferReq);
		return currentId;
	}

	function acceptVirtualExternalTransfer(uint256 id) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ExternalTransferReq storage externalTransferReq = accountLayout.externalTransfers[id];

		require(externalTransferReq.status == ExternalTransferStatus.PENDING, "AccountFacet: External transfer already processed");
		require(externalTransferReq.provider == msg.sender, "AccountFacet: Only provider can accept the transfer");

		externalTransferReq.status = ExternalTransferStatus.COMPLETED;
	}

	function cancelVirtualExternalTransfer(uint256 id) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		ExternalTransferReq storage externalTransferReq = accountLayout.externalTransfers[id];

		require(externalTransferReq.sender == msg.sender, "AccountFacet: Invalid Sender");
		require(externalTransferReq.status == ExternalTransferStatus.PENDING, "AccountFacet: External transfer already processed");

		uint256 amountWith18Decimals = (externalTransferReq.amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		accountLayout.balances[externalTransferReq.sender] += amountWith18Decimals;

		externalTransferReq.status = ExternalTransferStatus.CANCELED;

		IVirtualProvider(externalTransferReq.provider).onCancelExternalTransfer(id);
	}

	function bindToPartyB(address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		require(partyB != address(0), "AccountFacet: Zero address");
		require(quoteLayout.partyAOpenPositions[LibSigner.getSigner()].length == quoteLayout.partyBOpenPositions[partyB][LibSigner.getSigner()].length,"AccountFacet : Have Open Positions with Other Party B");
		require(quoteLayout.partyALockQuotesCount[LibSigner.getSigner()] == quoteLayout.partyBPendingQuotes[partyB][LibSigner.getSigner()].length,"AccountFacet : Have Locked Quotes with Other Party B");
		require(accountLayout.isPartyBBindable[partyB], "AccountFacet: Not Bindable");
		BindState storage bindState = accountLayout.bindState[LibSigner.getSigner()];
		require(bindState.status == BindStatus.NOT_BOUND, "AccountFacet: Invalid state");

		bindState.partyB = partyB;
		bindState.status = BindStatus.BOUND;
		bindState.modifyTimestamp = block.timestamp;
	}

	function requestToUnbindFromPartyB() internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		BindState storage bindState = accountLayout.bindState[LibSigner.getSigner()];
		require(bindState.status == BindStatus.BOUND, "AccountFacet: Invalid state");

		bindState.status = BindStatus.PENDING_UNBIND;
		bindState.modifyTimestamp = block.timestamp;
	}

	function cancelUnbindRequest() internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		BindState storage bindState = accountLayout.bindState[LibSigner.getSigner()];
		require(bindState.status == BindStatus.PENDING_UNBIND, "AccountFacet: Invalid state");

		bindState.status = BindStatus.BOUND;
		bindState.modifyTimestamp = block.timestamp;
	}

	function completeUnbindRequest(address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		BindState storage bindState = accountLayout.bindState[partyA];

		require(bindState.status == BindStatus.PENDING_UNBIND, "AccountFacet: Invalid state");

		if (LibSigner.getSigner() != bindState.partyB)
			require(block.timestamp >= bindState.modifyTimestamp + MAStorage.layout().unbindCooldown, "AccountFacet: Cooldown not reached");

		bindState.partyB = address(0);
		bindState.status = BindStatus.NOT_BOUND;
		bindState.modifyTimestamp = block.timestamp;
	}

	function activateInstantActionMode() internal {
		require(AccountStorage.layout().bindState[LibSigner.getSigner()].status == BindStatus.BOUND, "AccountFacet: Invalid state");
		AccountStorage.layout().instantActionsMode[LibSigner.getSigner()] = true;
	}

	function proposeToDeactivateInstantActionMode() internal {
		AccountStorage.Layout storage layout = AccountStorage.layout();
		layout.instantActionsModeDeactivateTime[LibSigner.getSigner()] = block.timestamp + layout.deactiveInstantActionModeCooldown;
	}

	function deactivateInstantActionMode() internal {
		AccountStorage.Layout storage layout = AccountStorage.layout();

		if (layout.instantActionsModeDeactivateTime[LibSigner.getSigner()] == 0) revert("Instant Action Deactivation not proposed yet");

		if (layout.instantActionsModeDeactivateTime[LibSigner.getSigner()] > block.timestamp) {
			revert("Instant Actions Mode Deactivate Timeout not passed");
		}

		layout.instantActionsMode[LibSigner.getSigner()] = false;
		layout.instantActionsModeDeactivateTime[LibSigner.getSigner()] = 0;
	}
}
