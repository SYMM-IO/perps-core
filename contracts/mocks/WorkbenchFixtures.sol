// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

/// @dev Local workbench integration fixtures; never part of a deployment manifest.
contract WorkbenchFacetV1 {
	function workbenchVersion() external pure returns (uint256) {
		return 1;
	}
}

contract WorkbenchFacetV2 {
	function workbenchVersion() external pure returns (uint256) {
		return 2;
	}

	function workbenchAdded() external pure returns (bool) {
		return true;
	}
}

contract WorkbenchSafeFixture {
	address public signer;
	uint256 public nonce;
	constructor(address signer_) {
		signer = signer_;
	}
	function getOwners() external view returns (address[] memory result) {
		result = new address[](1);
		result[0] = signer;
	}
	function getThreshold() external pure returns (uint256) {
		return 1;
	}
	function VERSION() external pure returns (string memory) {
		return "workbench-test-fixture";
	}
	function execute(address target, bytes calldata data) external {
		require(msg.sender == signer, "signer");
		(bool success, bytes memory result) = target.call(data);
		require(success, string(result));
		nonce++;
	}
}

/// @dev Minimal configuration surface routed through a real Diamond in workbench tests.
contract WorkbenchSystemFacet {
	mapping(address => mapping(bytes32 => bool)) private roles;
	address private verifier;
	function setupWorkbenchAdmin(address admin) external {
		require(verifier == address(0), "already setup");
		roles[admin][bytes32(0)] = true;
	}
	function hasRole(address user, bytes32 role) external view returns (bool) {
		return roles[user][role];
	}
	function grantRole(address user, bytes32 role) external {
		require(roles[msg.sender][bytes32(0)], "admin");
		roles[user][role] = true;
	}
	function revokeRole(address user, bytes32 role) external {
		require(roles[msg.sender][bytes32(0)], "admin");
		roles[user][role] = false;
	}
	function setSignatureVerifierAddress(address value) external {
		require(roles[msg.sender][bytes32(0)], "admin");
		verifier = value;
	}
	function getSignatureVerifier() external view returns (address) {
		return verifier;
	}
	function getCollateral() external pure returns (address) {
		return address(0);
	}
	function isPartyB(address) external pure returns (bool) {
		return true;
	}
}
