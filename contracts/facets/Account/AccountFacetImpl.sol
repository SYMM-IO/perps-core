// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {
	AccountStorage,
	AssuranceWithdrawalRequest,
	AssuranceWithdrawStatus,
	BindState,
	BindStatus,
	ExternalTransferReq,
	ExternalTransferStatus
} from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { MasterAccountMigrationStorage } from "../../storages/MasterAccountMigrationStorage.sol";
import { LibMuonAccount } from "../../libraries/muon/LibMuonAccount.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { IExternalTransferRelayer } from "../../interfaces/IExternalTransferRelayer.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { WithdrawStorage } from "../../storages/WithdrawStorage.sol";
import { IVirtualProvider } from "../../interfaces/IVirtualProvider.sol";
import { LibMuon } from "../../libraries/muon/LibMuon.sol";
import { SingleUpnlSig } from "../../storages/MuonStorage.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { MAStorage } from "../../storages/MAStorage.sol";

library AccountFacetImpl {
	using SafeERC20 for IERC20;

	function _normalizeTo18(address token, uint256 amount) internal view returns (uint256) {
		uint256 decimals = IERC20Metadata(token).decimals();
		require(decimals <= 18, "AccountFacet: token decimals > 18");
		return (amount * 1e18) / (10 ** decimals);
	}

	function deposit(address user, uint256 amount) internal {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		IERC20(appLayout.collateral).safeTransferFrom(LibSigner.getSigner(), address(this), amount);
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		AccountStorage.layout().balances[user] += amountWith18Decimals;
	}

	function virtualDepositFor(address user, uint256 amount) internal {
		require(GlobalAppStorage.layout().virtualProviders[msg.sender], "AccountFacet : msg.sender not registered as virtual provider");
		AccountStorage.layout().balances[user] += amount;
	}

	function withdraw(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		address signer = LibSigner.getSigner();
		require(appLayout.deprecateOldWithdrawalPaused == false, "This Withdrawal has been deprecated use new one;");
		require(
			block.timestamp >= accountLayout.withdrawCooldown[signer] + MAStorage.layout().deallocateCooldown,
			"AccountFacet: Cooldown hasn't reached"
		);
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		accountLayout.balances[signer] -= amountWith18Decimals;
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
		address signer = LibSigner.getSigner();
		require(
			block.timestamp >= accountLayout.withdrawCooldown[signer] + MAStorage.layout().deallocateDebounceTime,
			"AccountFacet: Too many deallocate in a short window"
		);
		require(accountLayout.allocatedBalances[signer] >= amount, "AccountFacet: Insufficient allocated Balance");
		LibMuonAccount.verifyPartyAUpnl(upnlSig, signer);
		int256 availableBalance = LibAccount.partyAAvailableForQuote(upnlSig.upnl, signer);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "AccountFacet: partyA will be liquidatable");

		accountLayout.allocatedBalances[signer] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.withdrawCooldown[signer] = block.timestamp;
	}

	function zeroUpnlDeallocate(uint256 amount, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		address signer = LibSigner.getSigner();

		require(accountLayout.allocatedBalances[signer] >= amount, "AccountFacet: Insufficient allocated Balance");
		require(
			quoteLayout.partyAPendingQuotes[partyA].length + quoteLayout.partyAOpenPositions[partyA].length == 0,
			"AccountFacet: PartyA has Open/Pending position"
		);

		accountLayout.allocatedBalances[signer] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.withdrawCooldown[signer] = block.timestamp;
	}

	function transferAllocation(uint256 amount, address origin, address recipient, SingleUpnlSig memory upnlSig) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(!maLayout.partyBLiquidationStatus[signer][origin], "PartyBFacet: PartyB isn't solvent");
		require(!maLayout.partyBLiquidationStatus[signer][recipient], "PartyBFacet: PartyB isn't solvent");
		require(!maLayout.liquidationStatus[origin], "PartyBFacet: Origin isn't solvent");
		require(!maLayout.liquidationStatus[recipient], "PartyBFacet: Recipient isn't solvent");
		require(!accountLayout.crossLiquidationDetails[signer].inProgress, "PartyBFacet: PartyB isn't solvent");

		// Not to be in master account mode as when the MA is activated there is no point on transferAllocation
		require(!accountLayout.masterAccountMode[signer], "PartyBFacet: Master account mode is active");

		// deallocate from origin
		require(accountLayout.partyBAllocatedBalances[signer][origin] >= amount, "PartyBFacet: Insufficient allocated balance");
		LibMuon.verifyPartyBUpnl(upnlSig, signer, origin, true); // Here the nonce is always from master account mode nonce if enabled
		int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, signer, origin);
		require(availableBalance >= 0, "PartyBFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "PartyBFacet: Will be liquidatable");

		accountLayout.partyBAllocatedBalances[signer][origin] -= amount;
		// allocate for recipient
		accountLayout.partyBAllocatedBalances[signer][recipient] += amount;
	}

	function internalTransfer(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(
			accountLayout.allocatedBalances[user] + amount <= GlobalAppStorage.layout().balanceLimitPerUser,
			"AccountFacet: Allocated balance limit reached"
		);
		require(accountLayout.balances[signer] >= amount, "AccountFacet: Insufficient balance");
		accountLayout.balances[signer] -= amount;
		accountLayout.allocatedBalances[user] += amount;
	}

	function internalTransferToBalance(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(accountLayout.balances[signer] >= amount, "AccountFacet: Insufficient balance");
		accountLayout.balances[signer] -= amount;
		accountLayout.balances[user] += amount;
		accountLayout.withdrawCooldown[user] = block.timestamp;
	}

	function allocateForPartyB(uint256 amount, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(!accountLayout.masterAccountMode[signer] || partyA == address(0), "PartyBFacet: Master account mode is active");
		require(accountLayout.balances[signer] >= amount, "AccountFacet: Insufficient balance");
		require(
			!MAStorage.layout().partyBLiquidationStatus[signer][partyA] && !accountLayout.crossLiquidationDetails[signer].inProgress,
			"AccountFacet: PartyB isn't solvent"
		);
		accountLayout.balances[signer] -= amount;
		accountLayout.partyBAllocatedBalances[signer][partyA] += amount;
	}

	function deallocateForPartyB(uint256 amount, address partyA, SingleUpnlSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(accountLayout.partyBAllocatedBalances[signer][partyA] >= amount, "AccountFacet: Insufficient allocated balance");
		LibMuon.verifyPartyBUpnl(upnlSig, signer, partyA, true); // Here the nonce is always from master account mode nonce if enabled
		int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, signer, partyA);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "AccountFacet: Will be liquidatable");

		accountLayout.partyBAllocatedBalances[signer][partyA] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.withdrawCooldown[signer] = block.timestamp;
	}

	function depositToReserveVault(uint256 amount, address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(amount <= accountLayout.balances[signer], "AccountFacet: Insufficient balance");
		require(MAStorage.layout().partyBStatus[partyB], "AccountFacet: Should be partyB");
		accountLayout.balances[signer] -= amount;
		accountLayout.reserveVault[partyB] += amount;
	}

	function withdrawFromReserveVault(uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(amount > 0 && amount <= accountLayout.reserveVault[signer], "AccountFacet: Insufficient balance");
		accountLayout.reserveVault[signer] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.withdrawCooldown[signer] = block.timestamp;
	}

	function activateMasterAccountMode() internal {
		require(GlobalAppStorage.layout().masterAccountEnabled, "AccountFacet: Master account disabled");
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(MasterAccountMigrationStorage.layout().partyBMigrationComplete[signer], "AccountFacet: Master account migration incomplete");
		require(!accountLayout.masterAccountMode[signer], "AccountFacet: Master account mode is active");
		accountLayout.masterAccountMode[signer] = true;
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
		require(
			IERC20(appLayout.collateral).balanceOf(address(this)) - withdrawLayout.withdrawLockedBalance >= amount,
			"AccountFacet: Insufficient contract balance"
		);
		IERC20(appLayout.collateral).safeTransfer(relayer, amount);

		IExternalTransferRelayer(relayer).onTransfer(appLayout.collateral, sender, receiver, amount, target);
	}

	function virtualExternalTransfer(
		address sender,
		address receiver,
		uint256 amount,
		address target,
		address virtualProvider
	) internal returns (uint256) {
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

		require(externalTransferReq.sender == LibSigner.getSigner(), "AccountFacet: Invalid Sender");
		require(externalTransferReq.status == ExternalTransferStatus.PENDING, "AccountFacet: External transfer already processed");

		uint256 amountWith18Decimals = (externalTransferReq.amount * 1e18) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		accountLayout.balances[externalTransferReq.sender] += amountWith18Decimals;

		externalTransferReq.status = ExternalTransferStatus.CANCELED;

		IVirtualProvider(externalTransferReq.provider).onCancelExternalTransfer(id);
	}

	function bindToPartyB(address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		address signer = LibSigner.getSigner();
		require(partyB != address(0), "AccountFacet: Zero address");
		require(
			quoteLayout.partyAOpenPositions[signer].length == quoteLayout.partyBOpenPositions[partyB][signer].length,
			"AccountFacet : Have Open Positions with Other Party B"
		);
		require(
			quoteLayout.partyALockQuotesCount[signer] == quoteLayout.partyBPendingQuotes[partyB][signer].length,
			"AccountFacet : Have Locked Quotes with Other Party B"
		);
		require(accountLayout.isPartyBBindable[partyB], "AccountFacet: Not Bindable");
		BindState storage bindState = accountLayout.bindState[signer];
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
		address signer = LibSigner.getSigner();
		require(AccountStorage.layout().bindState[signer].status == BindStatus.BOUND, "AccountFacet: Invalid state");
		AccountStorage.layout().instantActionsMode[signer] = true;
	}

	function proposeToDeactivateInstantActionMode() internal {
		AccountStorage.Layout storage layout = AccountStorage.layout();
		layout.instantActionsModeDeactivateTime[LibSigner.getSigner()] = block.timestamp + layout.deactiveInstantActionModeCooldown;
	}

	function deactivateInstantActionMode() internal {
		AccountStorage.Layout storage layout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		if (layout.instantActionsModeDeactivateTime[signer] == 0) revert("Instant Action Deactivation not proposed yet");

		if (layout.instantActionsModeDeactivateTime[signer] > block.timestamp) {
			revert("Instant Actions Mode Deactivate Timeout not passed");
		}

		layout.instantActionsMode[signer] = false;
		layout.instantActionsModeDeactivateTime[signer] = 0;
	}

	// ---------------- Assurance collateral lifecycle ----------------
	/**
	 * @notice Handles collateral dedicated to ADL/assurance operations for PartyB.
	 * @dev Allows deposit, withdrawal requests/approval, cancellation, and penalty application against assurance funds.
	 */

	function depositAssuranceCollateral(uint256 amount, address token) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(amount > 0, "AccountFacet: invalid amount");

		IERC20(token).safeTransferFrom(signer, address(this), amount);
		accountLayout.assuranceCollateral[signer][token] += amount;
	}

	function requestAssuranceWithdraw(uint256 amount, address token, address recipient) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(amount > 0, "AccountFacet: invalid amount");
		require(recipient != address(0), "AccountFacet: invalid recipient");
		require(accountLayout.assuranceWithdrawalRequests[signer].status == AssuranceWithdrawStatus.NONE, "AccountFacet: withdraw pending");
		require(accountLayout.assuranceCollateral[signer][token] >= amount, "AccountFacet: insufficient ADL collateral");

		accountLayout.assuranceWithdrawalRequests[signer] = AssuranceWithdrawalRequest({
			token: token,
			amount: amount,
			recipient: recipient,
			requester: signer,
			status: AssuranceWithdrawStatus.PENDING
		});
	}

	function acceptAssuranceWithdraw(address partyB, uint256 amount, address token) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		AssuranceWithdrawalRequest storage req = accountLayout.assuranceWithdrawalRequests[partyB];

		require(req.status == AssuranceWithdrawStatus.PENDING, "AccountFacet: no pending ADL withdraw");
		require(req.requester == partyB, "AccountFacet: requester mismatch");
		require(req.token == token && req.amount == amount, "AccountFacet: params mismatch");
		require(accountLayout.assuranceCollateral[partyB][token] >= amount, "AccountFacet: insufficient ADL collateral");

		address recipient = req.recipient;
		accountLayout.assuranceCollateral[partyB][token] -= amount;
		req.status = AssuranceWithdrawStatus.NONE;
		req.amount = 0;
		req.token = address(0);
		req.recipient = address(0);
		req.requester = address(0);

		IERC20(token).safeTransfer(recipient, amount);
	}

	function cancelAssuranceWithdraw() internal returns (address token, uint256 amount) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		AssuranceWithdrawalRequest storage req = accountLayout.assuranceWithdrawalRequests[signer];

		require(req.status == AssuranceWithdrawStatus.PENDING, "AccountFacet: no pending ADL withdraw");

		token = req.token;
		amount = req.amount;
		req.recipient = address(0);
		req.requester = address(0);
		req.status = AssuranceWithdrawStatus.NONE;
		req.amount = 0;
		req.token = address(0);
	}

	function performSolverPenalty(address partyB, address token, uint256 amount, address recipient) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(amount > 0, "AccountFacet: invalid penalty");
		require(accountLayout.assuranceCollateral[partyB][token] >= amount, "AccountFacet: insufficient ADL collateral");

		accountLayout.assuranceCollateral[partyB][token] -= amount;
		IERC20(token).safeTransfer(recipient, amount);
	}
}
