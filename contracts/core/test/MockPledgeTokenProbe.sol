// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

/// @notice Reverts on every token interaction so tests can detect a call before the whitelist check.
contract MockPledgeTokenProbe {
	error UnexpectedTokenCall();

	fallback() external {
		revert UnexpectedTokenCall();
	}
}
