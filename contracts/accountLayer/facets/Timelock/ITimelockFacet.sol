// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SignedTimelockApproval } from "../../storages/TimelockStorage.sol";
import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

interface ITimelockFacetEvents {
	event TimelocksSetup(address indexed subAccount, address indexed unlocker, uint256 delay, bytes4[] selectors);
	event TimelocksCleared(address indexed subAccount, bytes4[] selectors);
	event TimelockNonceAdvanced(address indexed subAccount, uint32 nonce);
	event TimelockOpScheduled(address indexed subAccount, bytes32 indexed callDataHash, uint64 scheduledAt);
	event TimelockOpCancelled(address indexed subAccount, bytes32 indexed callDataHash);
	event TimelockOpApproved(address indexed subAccount, bytes32 indexed callDataHash, address indexed unlocker, bytes32 approvalHash);
	/// @notice Emitted by the gate once per timelocked op it let through, with that op's own calldata hash
	event TimelockOpExecuted(address indexed subAccount, bytes32 indexed callDataHash);
}

interface ITimelockFacet is ITimelockFacetEvents, IAccountLayerErrors {
	/// @notice Puts a timelock, unlocker plus delay, on each selector of a root sub-account.
	/// @dev Each selector has its own timelock, so different selectors may be timelocked by different unlockers with
	///      different delays. Timelocking a selector nobody timelocks yet, or raising a selector's delay under the same
	///      unlocker, is instant. Lowering a selector's delay or handing it to another unlocker is itself a timelocked
	///      op: the selector's current unlocker must approve it, or the owner schedules it; when the changed selectors
	///      belong to several unlockers, every one of them must approve. Every call advances the family's timelock
	///      nonce, which kills every schedule; approvals are used in the same transaction and unaffected. Imported
	///      legacy accounts are rejected: their MultiAccount route would bypass the gate.
	/// @param subAccount Root sub-account (virtual accounts inherit their parent's timelocks)
	/// @param unlocker Address whose per-op approval lets a timelocked op on these selectors run before the delay
	/// @param delay Seconds a scheduled op touching these selectors waits; between minTimelockDelay and 30 days
	/// @param selectors AccountLayer entry selectors and core selectors (carried inside _call) to timelock
	function setupTimelocks(address subAccount, address unlocker, uint256 delay, bytes4[] calldata selectors) external;

	/// @notice Removes the timelock from selectors. Itself a timelocked op whenever a cleared selector was timelocked:
	///         every cleared selector's unlocker must approve it, or the owner schedules it.
	/// @param subAccount Root sub-account
	/// @param selectors Selectors to stop timelocking
	function clearTimelocks(address subAccount, bytes4[] calldata selectors) external;

	/// @notice Schedules one op on the account's family, starting now. The op becomes executable once the longest
	///         delay among the timelocked selectors it touches has passed, for scheduleGracePeriod seconds.
	/// @dev Scheduling the same hash again restarts the clock.
	/// @param account Sub-account or virtual account; resolved to the family's root
	/// @param callDataHash keccak256 of the exact AccountLayer calldata the op will use
	function scheduleTimelockOp(address account, bytes32 callDataHash) external;

	/// @notice Cancels a schedule, pending or ready.
	/// @param account Sub-account or virtual account; resolved to the family's root
	/// @param callDataHash The scheduled op's calldata hash
	function cancelTimelockOp(address account, bytes32 callDataHash) external;

	/// @notice Runs innerCallData on this diamond, first recording the unlockers' approvals for it.
	/// @dev The inner call executes through delegatecall to this diamond, so msg.sender and the signer context are
	///      preserved and ownership is enforced by the inner entry point. The wrapper adds no authority of its own, so a
	///      relayer that authorizes per selector must check its delegate on the op the wrapper carries, as the
	///      InstantLayer does, never on this selector. Each signature is verified against its approval's unlocker, an
	///      EOA or an EIP-1271 contract. Each approval names the exact calldata of the one op it is for: an inner core
	///      call inside innerCallData, the standalone call the entry performs on the side, or innerCallData itself when
	///      the entry selector is the timelocked one; nothing is covered by the calldata around it. Every timelocked op
	///      inside uses one approval from its own unlocker, so a batch with two timelocked inner calls carries two
	///      approvals, and the same inner calldata twice carries two. A failing inner call reverts the whole call,
	///      including the approvals' consumption.
	/// @param approvals Unlocker approvals, each naming its account and the exact calldata it is for; empty relies on schedules
	/// @param innerCallData Exact calldata of the timelocked AccountLayer call
	/// @return The inner call's return data
	function executeTimelockOp(SignedTimelockApproval[] calldata approvals, bytes calldata innerCallData) external returns (bytes memory);
}
