// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.34;

import { AccountStorage } from "../storages/AccountStorage.sol";
import { TimelockStorage, SelectorTimelock, Schedule, TimelockApproval } from "../storages/TimelockStorage.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

/// @title LibTimelock
/// @notice The gate every timelocked AccountLayer entry point runs, and the pieces TimelockFacet builds it from.
/// @dev Each call has one selector and is identified by the hash of its exact calldata. There are two checks:
///      - Call execution checks that selector's unlocker approval or a mature schedule for that exact calldata.
///        A batch checks its entry, any implied margin call, and each inner core call separately.
///      - Policy changes check the existing locks being weakened or cleared. These selectors name settings being
///        changed, not calls being executed. Each affected unlocker must approve the exact policy-change calldata,
///        or its schedule must have waited that lock's delay.
///      Both checks consume approvals and schedules. Repeated execution of the same calldata needs a separate
///      authorization for each occurrence. executeTimelockOp verifies signatures and records approvals in transient
///      storage before delegatecalling the entry point; it reverts if any supplied approval remains unused.
library LibTimelock {
	/// @dev Same signature as ITimelockFacetEvents.TimelockOpExecuted so both emit the identical topic.
	event TimelockOpExecuted(address indexed subAccount, bytes32 indexed callDataHash);

	uint256 internal constant DEFAULT_SCHEDULE_GRACE_PERIOD = 10 minutes;
	uint256 internal constant MAX_TIMELOCK_DELAY = 30 days;

	bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
		"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
	);
	bytes32 internal constant NAME_HASH = keccak256("SymmioAccountLayerTimelock");
	bytes32 internal constant VERSION_HASH = keccak256("1");
	bytes32 internal constant TIMELOCK_APPROVAL_TYPEHASH = keccak256(
		"TimelockApproval(address account,address unlocker,bytes32 callDataHash,uint256 deadline,bytes32 salt)"
	);

	/// @dev Salt for the transient slots that hold recorded approvals. See "Approvals recorded for this transaction".
	bytes32 private constant TRANSIENT_APPROVAL_SALT = keccak256("symmio.account-layer.transient.timelock.approval");

	/// @notice Root sub-account of an account family, or address(0) for anything the AccountLayer does not own.
	/// @dev Virtual accounts inherit their parent's timelocks, like delegations. A deleted VA keeps its
	///      parentAccount, so it still resolves to the family.
	function rootOf(address account) internal view returns (address) {
		AccountStorage.Layout storage a = AccountStorage.layout();
		if (a.subAccounts[account].isExists) return account;
		return a.virtualAccounts[account].parentAccount;
	}

	/// @notice Timelock on one selector of a root sub-account; unlocker == address(0) means not timelocked.
	function timelockOf(address subAccount, bytes4 selector) internal view returns (SelectorTimelock memory) {
		return TimelockStorage.layout().selectorTimelocks[subAccount][selector];
	}

	/// @notice How long a schedule stays valid once its delay has passed: the configured value, or 10 minutes when unset.
	function scheduleGracePeriod() internal view returns (uint256) {
		uint256 configured = TimelockStorage.layout().scheduleGracePeriod;
		return configured == 0 ? DEFAULT_SCHEDULE_GRACE_PERIOD : configured;
	}

	// ==================== Call execution ====================

	/// @notice Checks an entry point's own calldata against its one selector's timelock.
	function requireCallApprovedOrScheduled(address account, bytes4 selector) internal {
		address root = rootOf(account);
		if (root == address(0)) return;
		_requireCallApprovedOrScheduled(root, keccak256(msg.data), selector);
	}

	/// @notice Checks arbitrary Core calldata executed for an account through a trusted AccountLayer callback.
	/// @dev The approval or schedule binds to the Core calldata itself, matching an inner op carried by `_call`.
	function requireCallDataApprovedOrScheduled(address account, bytes calldata callData) internal {
		address root = rootOf(account);
		if (root == address(0)) return;
		bytes4 selector;
		if (callData.length >= 4) {
			assembly ("memory-safe") {
				selector := calldataload(callData.offset)
			}
		}
		_requireCallApprovedOrScheduled(root, keccak256(callData), selector);
	}

	/// @notice Checks a _call-style entry, its implied standalone call if any, and each inner core call independently.
	/// @dev The entry is checked only against its own selector's policy. Its approval or schedule never covers inner calls.
	function requireCallsApprovedOrScheduled(address account, bytes[] calldata callDatas, bytes memory sideCallData) internal {
		address root = rootOf(account);
		if (root == address(0)) return;
		_requireCallApprovedOrScheduled(root, keccak256(msg.data), msg.sig);
		if (sideCallData.length != 0) {
			_requireCallApprovedOrScheduled(root, keccak256(sideCallData), _selectorOf(sideCallData));
		}
		for (uint256 i = 0; i < callDatas.length; i++) {
			_requireCallApprovedOrScheduled(root, keccak256(callDatas[i]), _selectorOf(callDatas[i]));
		}
	}

	/// @dev One call, one selector: consume its unlocker's approval or its own schedule. There are no child calls here.
	function _requireCallApprovedOrScheduled(address root, bytes32 callDataHash, bytes4 selector) private {
		SelectorTimelock memory timelock = timelockOf(root, selector);
		if (timelock.unlocker == address(0)) return;
		if (!useApproval(root, callDataHash, timelock.unlocker)) {
			_useSchedule(root, callDataHash, timelock.delay);
		}
		emit TimelockOpExecuted(root, callDataHash);
	}

	/// @dev A calldata shorter than a selector yields zero, preserving the call gate's existing handling.
	function _selectorOf(bytes memory callData) private pure returns (bytes4 selector) {
		if (callData.length < 4) return bytes4(0);
		assembly ("memory-safe") {
			selector := mload(add(callData, 32))
		}
	}

	// ==================== Policy changes ====================

	/// @notice Checks the existing locks being weakened or cleared by this policy-change call.
	/// @param policySelectors Selectors whose settings are changing, not child calls to execute.
	/// @dev Approvals and the schedule bind to the exact policy-change calldata. Each unlocker approves once even
	///      when it guards several affected selectors. The schedule is consumed once after checking every affected lock.
	function requirePolicyChangeApprovedOrScheduled(address account, bytes4[] memory policySelectors) internal {
		address root = rootOf(account);
		if (root == address(0)) return;
		bytes32 callDataHash = keccak256(msg.data);
		address[] memory approvedBy = new address[](policySelectors.length);
		uint256 approvedCount;
		bool timelocked;
		bool scheduleNeeded;
		uint64 requiredScheduleDelay;
		for (uint256 i = 0; i < policySelectors.length; i++) {
			SelectorTimelock memory timelock = timelockOf(root, policySelectors[i]);
			if (timelock.unlocker == address(0)) continue;
			timelocked = true;
			// One signature approves this entire policy change for every affected lock owned by this unlocker.
			if (_contains(approvedBy, approvedCount, timelock.unlocker)) continue;
			if (useApproval(root, callDataHash, timelock.unlocker)) {
				approvedBy[approvedCount++] = timelock.unlocker;
			} else {
				// The policy-change schedule must satisfy each affected lock whose unlocker did not approve.
				scheduleNeeded = true;
				if (timelock.delay > requiredScheduleDelay) requiredScheduleDelay = timelock.delay;
			}
		}
		if (!timelocked) return;
		if (scheduleNeeded) _useSchedule(root, callDataHash, requiredScheduleDelay);
		emit TimelockOpExecuted(root, callDataHash);
	}

	/// @dev Whether item is among the first count entries of list.
	function _contains(address[] memory list, uint256 count, address item) private pure returns (bool) {
		for (uint256 i = 0; i < count; i++) {
			if (list[i] == item) return true;
		}
		return false;
	}

	/// @dev Uses up the op's schedule: it must exist under the family's current nonce, have waited the delay, and be
	///      inside the grace period. Reverts TimelockOpNotApprovedOrScheduled when there is none.
	function _useSchedule(address root, bytes32 callDataHash, uint64 delay) private {
		TimelockStorage.Layout storage t = TimelockStorage.layout();
		Schedule memory schedule = t.schedules[root][callDataHash];
		if (schedule.scheduledAt == 0 || schedule.nonce != t.nonces[root]) {
			revert IAccountLayerErrors.TimelockOpNotApprovedOrScheduled(root, callDataHash);
		}
		uint256 readyAt = uint256(schedule.scheduledAt) + delay;
		uint256 expiresAt = readyAt + scheduleGracePeriod();
		if (block.timestamp < readyAt) revert IAccountLayerErrors.ScheduleNotReady(root, callDataHash, uint64(readyAt));
		if (block.timestamp > expiresAt) revert IAccountLayerErrors.ScheduleExpired(root, callDataHash, uint64(expiresAt));
		delete t.schedules[root][callDataHash];
	}

	// ==================== Approvals recorded for this transaction ====================
	// executeTimelockOp verifies the unlockers' signatures and records the approvals here; the gate inside the inner
	// call uses them. Transient storage is the channel because the inner call is a delegatecall with the inner
	// function's own calldata, which has no room for approvals. One count per (root, op, unlocker): how many times
	// that unlocker's approval for that exact calldata may still be used in this transaction. Each wrapper requires
	// consumption of its additions; nested wrappers leave any remaining outer approvals available to their caller.

	/// @notice Records one approval by unlocker for the op on root, usable once in this transaction.
	function recordApproval(address root, bytes32 callDataHash, address unlocker) internal {
		bytes32 slot = _approvalSlot(root, callDataHash, unlocker);
		_tstore(slot, _tload(slot) + 1);
	}

	/// @notice Number of approvals still available for this exact tuple, including any supplied by outer wrappers.
	function recordedApprovalCount(address root, bytes32 callDataHash, address unlocker) internal view returns (uint256) {
		return _tload(_approvalSlot(root, callDataHash, unlocker));
	}

	/// @notice Uses up one approval by unlocker for the op on root; false when none is left.
	function useApproval(address root, bytes32 callDataHash, address unlocker) internal returns (bool) {
		bytes32 slot = _approvalSlot(root, callDataHash, unlocker);
		uint256 left = _tload(slot);
		if (left == 0) return false;
		_tstore(slot, left - 1);
		return true;
	}

	// ==================== Running a timelocked op from the wrapper ====================

	/// @notice Runs one op on this diamond with its own calldata and returns its result; inner reverts bubble up
	///         unchanged. Inside a diamond the delegatecall re-enters the fallback with msg.sender, the signer context,
	///         and storage preserved, so the inner entry point's owner check and gate run as usual and the gate reads
	///         the approvals the wrapper recorded.
	function runTimelockedOp(bytes calldata callData) internal returns (bytes memory result) {
		bool success;
		// solhint-disable-next-line avoid-low-level-calls
		(success, result) = address(this).delegatecall(callData);
		if (!success) {
			assembly ("memory-safe") {
				revert(add(result, 32), mload(result))
			}
		}
	}

	// ==================== EIP-712 ====================

	function domainSeparator() internal view returns (bytes32) {
		return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
	}

	function hashApproval(TimelockApproval memory approval) internal view returns (bytes32) {
		bytes32 structHash = keccak256(
			abi.encode(TIMELOCK_APPROVAL_TYPEHASH, approval.account, approval.unlocker, approval.callDataHash, approval.deadline, approval.salt)
		);
		return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
	}

	// ==================== Transient storage ====================

	function _approvalSlot(address root, bytes32 callDataHash, address unlocker) private pure returns (bytes32) {
		return keccak256(abi.encode(TRANSIENT_APPROVAL_SALT, root, callDataHash, unlocker));
	}

	function _tstore(bytes32 slot, uint256 value) private {
		assembly ("memory-safe") {
			tstore(slot, value)
		}
	}

	function _tload(bytes32 slot) private view returns (uint256 value) {
		assembly ("memory-safe") {
			value := tload(slot)
		}
	}
}
