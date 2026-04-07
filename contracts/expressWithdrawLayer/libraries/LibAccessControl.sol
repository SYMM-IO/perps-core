// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { GlobalStorage } from "../storages/GlobalStorage.sol";

/// @title LibAccessControl
/// @notice Role-based access control and EIP-712 signature helpers for the ExpressProvider diamond.
library LibAccessControl {
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
	bytes32 public constant LOCKER_ROLE = keccak256("LOCKER_ROLE");
	bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant SPONSOR_MANAGER_ROLE = keccak256("SPONSOR_MANAGER_ROLE");
	bytes32 public constant FEE_CLAIMER_ROLE = keccak256("FEE_CLAIMER_ROLE");
	bytes32 public constant UNLOCK_ROLE = keccak256("UNLOCK_ROLE");
	bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE");

	bytes32 public constant WITHDRAW_OPTION_TYPEHASH =
		keccak256(
			"WithdrawOption(address user,uint256 nonce,uint8 optionType,uint256 availableAt,address affiliate,uint256 affiliateAmount,uint256 creditAmount,uint256 fee,uint256 operatorFee,uint256 maxUserFee,bytes32 partsHash,uint256 deadline)"
		);

	bytes32 public constant VALIDATOR_APPROVAL_TYPEHASH =
		keccak256("ValidatorApproval(address user,uint256 nonce,uint256 amount,uint256 timestamp,uint256 symmioNonce,address symmio)");

	bytes32 private constant TYPE_HASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

	error AccessDenied(bytes32 role);

	function hasRole(bytes32 role, address account) internal view returns (bool) {
		return GlobalStorage.layout().hasRole[account][role];
	}

	function enforceRole(bytes32 role) internal view {
		if (!hasRole(role, msg.sender)) revert AccessDenied(role);
	}

	function grantRole(address account, bytes32 role) internal {
		GlobalStorage.layout().hasRole[account][role] = true;
	}

	function revokeRole(address account, bytes32 role) internal {
		GlobalStorage.layout().hasRole[account][role] = false;
	}

	function domainSeparatorV4() internal view returns (bytes32) {
		GlobalStorage.Layout storage s = GlobalStorage.layout();
		return keccak256(abi.encode(TYPE_HASH, s.hashedName, s.hashedVersion, block.chainid, address(this)));
	}

	function hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
		return keccak256(abi.encodePacked("\x19\x01", domainSeparatorV4(), structHash));
	}
}
