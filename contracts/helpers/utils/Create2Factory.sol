// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.8.18;

import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";

/// @notice Minimal CREATE2 factory for deploying contracts to deterministic addresses
contract Create2Factory {
	event Deployed(address addr, bytes32 salt);

	/// @notice Deploys a contract using CREATE2
	/// @param salt The salt used to compute the address
	/// @param bytecode The creation bytecode (including constructor args)
	/// @return addr The address of the deployed contract
	function deploy(bytes32 salt, bytes memory bytecode) external payable returns (address addr) {
		addr = Create2.deploy(msg.value, salt, bytecode);
		emit Deployed(addr, salt);
	}

	/// @notice Computes the address of a contract deployed via this factory
	/// @param salt The salt used in deployment
	/// @param bytecodeHash The keccak256 hash of the creation bytecode
	/// @return The predicted address
	function computeAddress(bytes32 salt, bytes32 bytecodeHash) external view returns (address) {
		return Create2.computeAddress(salt, bytecodeHash);
	}
}
