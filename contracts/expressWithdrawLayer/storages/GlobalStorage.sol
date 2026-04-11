// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { WithdrawInfo } from "../types/WithdrawTypes.sol";

/// @title GlobalStorage
/// @notice Core diamond storage: addresses, withdraw state, security config, access control, and EIP-712.
library GlobalStorage {
	bytes32 internal constant STORAGE_SLOT = keccak256("diamond.standard.storage.global");

	struct Layout {
		// ── Core addresses ──
		address symmio;
		IERC20 collateral;
		// ── Per-user state ──
		mapping(address => uint256) nonces;
		mapping(address => mapping(uint256 => WithdrawInfo)) withdrawInfos;
		// ── Security ──
		uint256 securityWindow;
		uint256 tolerancePeriod;
		// ── Access control ──
		mapping(address => mapping(bytes32 => bool)) hasRole;
		// ── EIP-712 ──
		bytes32 hashedName;
		bytes32 hashedVersion;
		// ── Initialization guard ──
		bool initialized;
		// ── Reentrancy guard ──
		uint256 reentrancyStatus;
		// ── Accelerate (promote STANDARD → INSTANT) per-request nonce ──
		mapping(address => mapping(uint256 => uint256)) accelerateNonces;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
