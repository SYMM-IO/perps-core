// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Test hook that replays configured core calls from lifecycle callbacks and records each result.
/// @dev Close and liquidation-settled callbacks always replay; cancel callbacks replay only when enabled. Callbacks
///      triggered by a replayed call are ignored, so each callback replays the list once.
contract LiquidationReentryHook {
	address public immutable core;
	bytes[] private calls;
	bool[] public succeeded;
	bytes[] public results;
	bool public replayOnCancel;
	bool private replaying;

	constructor(address core_) {
		core = core_;
	}

	/// @notice Sets the calls to replay and clears earlier results.
	function configure(bytes[] calldata calls_, bool replayOnCancel_) external {
		calls = calls_;
		delete succeeded;
		delete results;
		replayOnCancel = replayOnCancel_;
	}

	function onClosePosition(uint256, uint256, uint256, address, address) external {
		_replay();
	}

	function onCancelQuote(uint256, address, address) external {
		if (replayOnCancel) _replay();
	}

	function onLiquidationSettled(address) external {
		_replay();
	}

	function _replay() private {
		require(msg.sender == core, "ReentryHook: Only core");
		if (replaying) return;
		replaying = true;
		for (uint256 i; i < calls.length; i++) {
			(bool success, bytes memory result) = core.call(calls[i]);
			succeeded.push(success);
			results.push(result);
		}
		replaying = false;
	}

	/// @dev Accepts the other hook callbacks (open, fee, close-expired) without acting on them.
	fallback() external {}
}
