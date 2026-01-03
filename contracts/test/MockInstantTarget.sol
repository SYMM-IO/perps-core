// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

contract MockInstantTarget {
	uint256 public lastValue;
	bytes public lastCalldata;
	bool public shouldRevert;
	string public revertMessage;

	event Called(address caller, uint256 value);

	function setShouldRevert(bool _shouldRevert, string memory _revertMessage) external {
		shouldRevert = _shouldRevert;
		revertMessage = _revertMessage;
	}

	function store(uint256 value) external returns (bytes32) {
		if (shouldRevert) {
			revert(bytes(revertMessage).length > 0 ? revertMessage : "MockInstantTarget: revert");
		}

		lastValue = value;
		lastCalldata = msg.data;
		emit Called(msg.sender, value);
		return bytes32(value);
	}

	/// @notice Returns a tuple of two uint256 values for testing sourceOffsets
	function getTuple(uint256 a, uint256 b) external pure returns (uint256, uint256) {
		return (a, b);
	}

	/// @notice Returns a tuple of three values for testing sourceOffsets with different types
	function getTriple(uint256 a, address b, bytes32 c) external pure returns (uint256, address, bytes32) {
		return (a, b, c);
	}

	/// @notice View function that returns the caller's address
	function getCallerAddress() external view returns (address) {
		return msg.sender;
	}
}
