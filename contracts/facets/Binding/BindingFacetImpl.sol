// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage, BindState, BindStatus } from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";

library BindingFacetImpl {
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
}
