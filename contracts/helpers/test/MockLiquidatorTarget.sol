// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Minimal mock used only for SymmioLiquidator tests. Records the last call
///         and exposes a reverting function so revert bubbling can be verified.
contract MockLiquidatorTarget {
	bytes public lastCalldata;
	uint256 public callCount;

	error MockRevert(uint256 code);

	/// @notice Succeeds and records the calldata. Has the same selector as
	///         IPartyALiquidationFacet.liquidatePendingPositionsPartyA(address)
	function liquidatePendingPositionsPartyA(address) external {
		lastCalldata = msg.data;
		callCount += 1;
	}

	/// @notice Reverts with a custom error to test revert bubbling.
	function revertMe() external pure {
		revert MockRevert(42);
	}

	/// @notice Reverts with no data to test the generic fallback message.
	function silentRevert() external pure {
		assembly {
			revert(0, 0)
		}
	}

	/// @notice Accepts native transfers so native-withdraw tests can fund the liquidator.
	receive() external payable {}
}
