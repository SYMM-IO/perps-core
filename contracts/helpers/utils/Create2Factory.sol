// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import { AccessControlEnumerable } from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

contract Create2Factory is AccessControlEnumerable {
	event Deployed(address addr, uint256 salt);

	bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

	constructor(address admin, address deployer) {
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(DEPLOYER_ROLE, deployer);
	}

	function deploy(bytes memory bytecode, uint256 salt) public onlyRole(DEPLOYER_ROLE) returns (address) {
		address addr;
		assembly {
			addr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
			if iszero(extcodesize(addr)) {
				revert(0, 0)
			}
		}
		emit Deployed(addr, salt);
		return addr;
	}

	function getAddress(bytes memory bytecode, uint256 salt) public view returns (address) {
		bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode)));
		return address(uint160(uint256(hash)));
	}
}
