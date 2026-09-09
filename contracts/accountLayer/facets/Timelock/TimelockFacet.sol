// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { ITimelockFacet } from "./ITimelockFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { LibTimelock } from "../../libraries/LibTimelock.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { TimelockStorage, SelectorTimelock, Schedule, TimelockApproval, SignedTimelockApproval } from "../../storages/TimelockStorage.sol";

/// @notice Per-selector timelocks chosen by the account owner, each guarded by an unlocker that can approve one op at a time.
contract TimelockFacet is ITimelockFacet, AccountLayerAccessibility, AccountLayerPausable {
	/// @notice Puts a timelock, unlocker plus delay, on each selector of a root sub-account.
	function setupTimelocks(
		address subAccount,
		address unlocker,
		uint256 delay,
		bytes4[] calldata selectors
	) external whenNotPaused onlyAccountOwner(subAccount) {
		if (!AccountStorage.layout().subAccounts[subAccount].isExists) revert NotRootSubAccount();
		if (LibAccountLayerUtils.legacyOwnerOf(subAccount) != address(0)) revert LegacyAccountCannotBeTimelocked();
		if (unlocker == address(0)) revert ZeroUnlocker();
		TimelockStorage.Layout storage t = TimelockStorage.layout();
		if (delay < t.minTimelockDelay) revert DelayBelowMinimum();
		if (delay > LibTimelock.MAX_TIMELOCK_DELAY) revert DelayAboveMaximum();

		// Timelocking a selector nobody timelocks, or strengthening one, is instant. Weakening a timelocked selector,
		// with a shorter delay or a different unlocker, is itself a timelocked op: its current unlocker must approve
		// it, or the owner must schedule it. Otherwise the owner could hand a selector to their own key and unlock
		// instantly. Only the weakened selectors go through the gate.
		LibTimelock.requirePolicyChangeApprovedOrScheduled(subAccount, _weakenedSelectors(t, subAccount, unlocker, delay, selectors));

		for (uint256 i = 0; i < selectors.length; i++) {
			t.selectorTimelocks[subAccount][selectors[i]] = SelectorTimelock({ unlocker: unlocker, delay: uint64(delay) });
		}
		_advanceNonce(t, subAccount);
		emit TimelocksSetup(subAccount, unlocker, delay, selectors);
	}

	/// @notice Removes the timelock from selectors; itself a timelocked op whenever a cleared selector was timelocked.
	function clearTimelocks(address subAccount, bytes4[] calldata selectors) external whenNotPaused onlyAccountOwner(subAccount) {
		if (!AccountStorage.layout().subAccounts[subAccount].isExists) revert NotRootSubAccount();
		TimelockStorage.Layout storage t = TimelockStorage.layout();
		// Clearing a timelocked selector is itself a timelocked op: its unlocker must approve it, or the owner must
		// schedule it. The gate ignores selectors nobody timelocks.
		LibTimelock.requirePolicyChangeApprovedOrScheduled(subAccount, selectors);

		for (uint256 i = 0; i < selectors.length; i++) {
			delete t.selectorTimelocks[subAccount][selectors[i]];
		}
		_advanceNonce(t, subAccount);
		emit TimelocksCleared(subAccount, selectors);
	}

	/// @notice Schedules one op on the account's family, starting now: a public notice that this exact calldata will run
	///         once its delay has passed.
	function scheduleTimelockOp(address account, bytes32 callDataHash) external whenNotPaused onlyAccountOwner(account) {
		address root = LibTimelock.rootOf(account);
		if (root == address(0)) revert AccountDoesNotExist();
		TimelockStorage.Layout storage t = TimelockStorage.layout();
		uint64 scheduledAt = uint64(block.timestamp);
		t.schedules[root][callDataHash] = Schedule({ scheduledAt: scheduledAt, nonce: t.nonces[root] });
		emit TimelockOpScheduled(root, callDataHash, scheduledAt);
	}

	/// @notice Cancels a schedule, pending or ready.
	function cancelTimelockOp(address account, bytes32 callDataHash) external whenNotPaused onlyAccountOwner(account) {
		address root = LibTimelock.rootOf(account);
		if (root == address(0)) revert AccountDoesNotExist();
		delete TimelockStorage.layout().schedules[root][callDataHash];
		emit TimelockOpCancelled(root, callDataHash);
	}

	/// @notice Runs innerCallData on this diamond, first recording the unlockers' approvals for it.
	/// @dev Not nonReentrant on purpose: the inner call takes the guard. No owner check of its own: the
	///      delegatecall preserves msg.sender and the signer context, so the inner entry point enforces ownership. The
	///      wrapper adds no authority, so a relayer that authorizes per selector must check its delegate on the op the
	///      wrapper carries, as the InstantLayer does, never on this selector.
	///      Each approval names its unlocker, an EOA or an EIP-1271 contract, and its signature is checked against it
	///      the way InstantLayer checks its signers. Each approval names the account and the exact calldata of the one
	///      op it is for: an inner core call, the standalone call the entry performs on the side, or the entry itself.
	///      Approvals live in transient storage for this transaction only, keyed by account, calldata hash, and
	///      unlocker; the gate inside the op uses one per timelocked op from that op's unlocker. Approvals for other
	///      calldatas or other accounts are never consulted. Any unused supplied approval reverts the whole call,
	///      including its replay mark, so unrelated calls cannot burn approvals.
	function executeTimelockOp(SignedTimelockApproval[] calldata approvals, bytes calldata innerCallData) external returns (bytes memory) {
		TimelockStorage.Layout storage t = TimelockStorage.layout();
		uint256[] memory previousCounts = new uint256[](approvals.length);

		for (uint256 i = 0; i < approvals.length; i++) {
			TimelockApproval calldata approval = approvals[i].approval;
			if (approval.unlocker == address(0)) revert ZeroUnlocker();
			if (approval.deadline < block.timestamp) revert ApprovalExpired();
			bytes32 approvalHash = LibTimelock.hashApproval(approval);
			if (t.usedApprovals[approvalHash]) revert ApprovalUsed();
			if (!SignatureChecker.isValidSignatureNow(approval.unlocker, approvalHash, approvals[i].signature)) revert InvalidApprovalSignature();

			previousCounts[i] = LibTimelock.recordedApprovalCount(approval.account, approval.callDataHash, approval.unlocker);
			t.usedApprovals[approvalHash] = true;
			LibTimelock.recordApproval(approval.account, approval.callDataHash, approval.unlocker);
			emit TimelockOpApproved(approval.account, approval.callDataHash, approval.unlocker, approvalHash);
		}

		// The op runs with its own calldata, so the gate inside it reads the approvals recorded above.
		bytes memory result = LibTimelock.runTimelockedOp(innerCallData);

		// Every supplied approval must be consumed. The first occurrence of each tuple has its lowest previous
		// count, so checking all entries also checks distinct salts together without a separate deduplication pass.
		// Nested wrappers may consume outer approvals too, but must not erase those left for their caller.
		for (uint256 i = 0; i < approvals.length; i++) {
			TimelockApproval calldata approval = approvals[i].approval;
			if (LibTimelock.recordedApprovalCount(approval.account, approval.callDataHash, approval.unlocker) > previousCounts[i]) {
				revert UnusedTimelockApproval();
			}
		}
		return result;
	}

	/// @dev The selectors a setupTimelocks call would weaken: timelocked today, and given a shorter delay or a different
	///      unlocker. Only these need the current unlocker's consent.
	function _weakenedSelectors(
		TimelockStorage.Layout storage t,
		address subAccount,
		address unlocker,
		uint256 delay,
		bytes4[] calldata selectors
	) private view returns (bytes4[] memory weakened) {
		uint256 n;
		for (uint256 i = 0; i < selectors.length; i++) {
			if (_weakens(t.selectorTimelocks[subAccount][selectors[i]], unlocker, delay)) n++;
		}
		weakened = new bytes4[](n);
		n = 0;
		for (uint256 i = 0; i < selectors.length; i++) {
			if (_weakens(t.selectorTimelocks[subAccount][selectors[i]], unlocker, delay)) weakened[n++] = selectors[i];
		}
	}

	function _weakens(SelectorTimelock memory current, address unlocker, uint256 delay) private pure returns (bool) {
		return current.unlocker != address(0) && (current.unlocker != unlocker || delay < current.delay);
	}

	/// @dev Every policy change advances the nonce, so schedules made under the old policy cannot be used against
	///      the new one.
	function _advanceNonce(TimelockStorage.Layout storage t, address subAccount) private {
		t.nonces[subAccount] += 1;
		emit TimelockNonceAdvanced(subAccount, t.nonces[subAccount]);
	}
}
