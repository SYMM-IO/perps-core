// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.22;

/// @dev Test-only state layout with a nonenumerable mapping.
contract StorageMigrationTarget {
	uint256 public config;
	mapping(address => uint256) public nonces;
	function setConfig(uint256 value) external {
		config = value;
	}
	function setNonce(address account, uint256 value) external {
		nonces[account] = value;
	}
}
