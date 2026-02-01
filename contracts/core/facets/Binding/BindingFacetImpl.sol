// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { TradingModeStorage, BindState, BindStatus } from "../../storages/TradingModeStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";

library BindingFacetImpl {
	using LockedValuesOps for LockedValues;

	function bindToPartyB(address partyB) internal {
		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(partyB != address(0), "AccountFacet: Zero address");
		require(
			quoteLayout.partyAOpenPositions[signer].length == quoteLayout.partyBOpenPositions[partyB][signer].length,
			"AccountFacet : Have Open Positions with Other Party B"
		);
		require(accountLayout.pendingLockedBalances[signer].totalForPartyA() == 0, "AccountFacet: Have pending quotes");
		require(tradingLayout.isPartyBBindable[partyB], "AccountFacet: Not Bindable");
		BindState storage bindState = tradingLayout.bindState[signer];
		require(bindState.status == BindStatus.NOT_BOUND, "AccountFacet: Invalid state");

		bindState.partyB = partyB;
		bindState.status = BindStatus.BOUND;
		bindState.modifyTimestamp = block.timestamp;
	}

	function requestToUnbindFromPartyB() internal {
		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();

		BindState storage bindState = tradingLayout.bindState[LibSigner.getSigner()];
		require(bindState.status == BindStatus.BOUND, "AccountFacet: Invalid state");

		bindState.status = BindStatus.PENDING_UNBIND;
		bindState.modifyTimestamp = block.timestamp;
	}

	function cancelUnbindRequest() internal {
		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();

		BindState storage bindState = tradingLayout.bindState[LibSigner.getSigner()];
		require(bindState.status == BindStatus.PENDING_UNBIND, "AccountFacet: Invalid state");

		bindState.status = BindStatus.BOUND;
		bindState.modifyTimestamp = block.timestamp;
	}

	function completeUnbindRequest(address partyA) internal {
		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();
		BindState storage bindState = tradingLayout.bindState[partyA];

		require(bindState.status == BindStatus.PENDING_UNBIND, "AccountFacet: Invalid state");

		if (LibSigner.getSigner() != bindState.partyB)
			require(block.timestamp >= bindState.modifyTimestamp + tradingLayout.unbindCooldown, "AccountFacet: Cooldown not reached");

		bindState.partyB = address(0);
		bindState.status = BindStatus.NOT_BOUND;
		bindState.modifyTimestamp = block.timestamp;
	}

	function activateInstantActionMode() internal {
		address signer = LibSigner.getSigner();
		require(TradingModeStorage.layout().bindState[signer].status == BindStatus.BOUND, "AccountFacet: Invalid state");
		TradingModeStorage.layout().instantActionsMode[signer] = true;
	}

	function proposeToDeactivateInstantActionMode() internal {
		TradingModeStorage.Layout storage layout = TradingModeStorage.layout();
		layout.instantActionsModeDeactivateTime[LibSigner.getSigner()] = block.timestamp + layout.deactiveInstantActionModeCooldown;
	}

	function deactivateInstantActionMode() internal {
		TradingModeStorage.Layout storage layout = TradingModeStorage.layout();
		address signer = LibSigner.getSigner();

		if (layout.instantActionsModeDeactivateTime[signer] == 0) revert("Instant Action Deactivation not proposed yet");

		if (layout.instantActionsModeDeactivateTime[signer] > block.timestamp) {
			revert("Instant Actions Mode Deactivate Timeout not passed");
		}

		layout.instantActionsMode[signer] = false;
		layout.instantActionsModeDeactivateTime[signer] = 0;
	}
}
