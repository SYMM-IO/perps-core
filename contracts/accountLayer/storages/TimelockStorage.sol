// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Timelock on one selector of a root sub-account. unlocker == address(0) means the selector is not timelocked.
struct SelectorTimelock {
	address unlocker;
	uint64 delay;
}

/// @notice One schedule for (root sub-account, calldata hash): the owner's public notice that this exact op will run.
/// @dev scheduledAt == 0 means no schedule. Live only while nonce equals the family's current timelock nonce; ready
///      once the longest delay among the selectors the op touches has passed since scheduledAt, and valid for
///      scheduleGracePeriod after that. Approvals are not stored here: they live in transient storage for the one
///      transaction that records them.
struct Schedule {
	uint64 scheduledAt;
	uint32 nonce;
}

/// @notice EIP-712 payload an unlocker signs to let one op run before its delay.
/// @dev unlocker is the signer the signature is checked against, an EOA or an EIP-1271 contract.
struct TimelockApproval {
	address account;
	address unlocker;
	bytes32 callDataHash;
	uint256 deadline;
	bytes32 salt;
}

/// @notice One unlocker's approval with its signature, as recorded to executeTimelockOp.
struct SignedTimelockApproval {
	TimelockApproval approval;
	bytes signature;
}

/// @title TimelockStorage
/// @notice Per-selector timelocks chosen by the account owner, each with its own unlocker and delay.
library TimelockStorage {
	bytes32 internal constant TIMELOCK_STORAGE_SLOT = keccak256("diamond.standard.storage.accountlayer.timelock");

	struct Layout {
		/// @notice Timelock per selector by root sub-account. Selectors are AccountLayer entry selectors and core
		///         selectors carried inside _call.
		mapping(address => mapping(bytes4 => SelectorTimelock)) selectorTimelocks;
		/// @notice Timelock nonce by root sub-account; advances on every setup or clear, which kills every schedule
		mapping(address => uint32) nonces;
		/// @notice Schedules by root sub-account and op calldata hash
		mapping(address => mapping(bytes32 => Schedule)) schedules;
		/// @notice Consumed approval hashes
		mapping(bytes32 => bool) usedApprovals;
		/// @notice Lower bound for a selector delay; zero means no minimum
		uint256 minTimelockDelay;
		/// @notice How long a schedule stays valid once its delay has passed; zero falls back to LibTimelock.DEFAULT_SCHEDULE_GRACE_PERIOD
		uint256 scheduleGracePeriod;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = TIMELOCK_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
