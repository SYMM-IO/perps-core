// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { ExternalTransferStorage, VirtualExternalTransferRequest, VirtualExternalTransferStatus } from "../../storages/ExternalTransferStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { WithdrawStorage } from "../../storages/WithdrawStorage.sol";
import { IExternalTransferRelayer } from "../../interfaces/IExternalTransferRelayer.sol";
import { IVirtualProvider } from "../../interfaces/IVirtualProvider.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibSafeCall } from "../../libraries/LibSafeCall.sol";
import { LibSafeERC20 } from "../../libraries/LibSafeERC20.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";

library ExternalTransferFacetImpl {
	function externalTransfer(address sender, address receiver, uint256 amount, address target) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ExternalTransferStorage.Layout storage extLayout = ExternalTransferStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		require(amount > 0, "AccountFacet: Amount is zero");
		require(receiver != address(0) && target != address(0), "AccountFacet: Zero receiver or target");
		address relayer = extLayout.externalTransferTargetsRelayers[target];
		require(relayer != address(0), "AccountFacet: Target not whitelisted");

		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		accountLayout.balances[sender] -= amountWith18Decimals;
		require(
			IERC20(appLayout.collateral).balanceOf(address(this)) - withdrawLayout.withdrawLockedBalance >= amount,
			"AccountFacet: Insufficient contract balance"
		);
		LibSafeERC20.safeTransfer(appLayout.collateral, relayer, amount);

		LibSafeCall.safeExternalCall(
			relayer,
			abi.encodeCall(IExternalTransferRelayer.onTransfer, (appLayout.collateral, sender, receiver, amount, target))
		);
	}

	function virtualExternalTransfer(
		address sender,
		address receiver,
		uint256 amount,
		address target,
		address virtualProvider
	) internal returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ExternalTransferStorage.Layout storage extLayout = ExternalTransferStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		// Input Checks
		require(amount > 0, "AccountFacet: Amount is zero");
		require(receiver != address(0) && target != address(0), "AccountFacet: Zero Receiver or Zero Target");
		require(withdrawLayout.virtualProviders[virtualProvider], "AccountFacet: Invalid virtual provider");

		// Balance Adjustment
		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		require(amountWith18Decimals <= accountLayout.balances[sender], "AccountFacet: Insufficient balance");
		accountLayout.balances[sender] -= amountWith18Decimals;

		// State Update
		uint256 currentId = ++extLayout.lastExternalTransferId;
		VirtualExternalTransferRequest memory externalTransferReq = VirtualExternalTransferRequest({
			id: currentId,
			sender: sender,
			receiver: receiver,
			source: address(this),
			target: target,
			amount: amount,
			timestamp: block.timestamp,
			provider: virtualProvider,
			status: VirtualExternalTransferStatus.PENDING
		});
		extLayout.externalTransfers[currentId] = externalTransferReq;

		// Callback to Virtual Provider
		LibSafeCall.safeExternalCall(
			virtualProvider,
			abi.encodeCall(IVirtualProvider.onExternalTransfer, (externalTransferReq))
		);
		return currentId;
	}

	function acceptVirtualExternalTransfer(uint256 id) internal {
		ExternalTransferStorage.Layout storage extLayout = ExternalTransferStorage.layout();
		VirtualExternalTransferRequest storage externalTransferReq = extLayout.externalTransfers[id];

		require(externalTransferReq.status == VirtualExternalTransferStatus.PENDING, "AccountFacet: External transfer already processed");
		require(externalTransferReq.provider == msg.sender, "AccountFacet: Only provider can accept the transfer");

		externalTransferReq.status = VirtualExternalTransferStatus.COMPLETED;
	}

	function cancelVirtualExternalTransfer(uint256 id) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ExternalTransferStorage.Layout storage extLayout = ExternalTransferStorage.layout();

		VirtualExternalTransferRequest storage externalTransferReq = extLayout.externalTransfers[id];

		require(externalTransferReq.sender == LibSigner.getSigner(), "AccountFacet: Invalid Sender");
		require(externalTransferReq.status == VirtualExternalTransferStatus.PENDING, "AccountFacet: External transfer already processed");

		uint256 amountWith18Decimals = LibAccount.to18Decimals(externalTransferReq.amount);
		accountLayout.balances[externalTransferReq.sender] += amountWith18Decimals;

		externalTransferReq.status = VirtualExternalTransferStatus.CANCELED;

		LibSafeCall.safeExternalCall(
			externalTransferReq.provider,
			abi.encodeCall(IVirtualProvider.onCancelExternalTransfer, (id))
		);
	}
}
