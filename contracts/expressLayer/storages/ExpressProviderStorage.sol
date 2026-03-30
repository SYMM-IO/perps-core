// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { WithdrawInfo, Status, OptionType } from "../types/WithdrawTypes.sol";
import { AffiliateConfig, SponsorConfig } from "../types/ConfigTypes.sol";

/// @title ExpressProviderStorage
/// @notice Diamond storage layout for the ExpressProvider system.
/// @dev Uses a unique keccak256 slot to avoid collisions with other diamond facets.
library ExpressProviderStorage {
	bytes32 internal constant STORAGE_SLOT = keccak256("diamond.standard.storage.expressprovider");

	struct Layout {
		// ── Core addresses ──
		address symmio;
		IERC20 collateral;
		// ── Pool balances ──
		uint256 generalBalance;
		uint256 lockedGeneralBalance;
		mapping(address => uint256) affiliateBalances;
		mapping(address => uint256) lockedAffiliateBalances;
		mapping(address => address) creditLineManagers;
		// ── Per-user state ──
		mapping(address => uint256) nonces;
		mapping(address => mapping(uint256 => WithdrawInfo)) withdrawInfos;
		// ── Security ──
		uint256 securityWindow;
		uint256 tolerancePeriod;
		// ── Fee configuration ──
		mapping(address => AffiliateConfig) affiliateConfigs;
		mapping(address => uint256) collectedFees;
		mapping(address => uint256) collectedOperatorFees;
		mapping(address => mapping(uint256 => uint256)) operatorFees;
		// ── Sponsorship ──
		mapping(address => uint256) sponsorBalances;
		mapping(address => address) sponsors;
		mapping(address => SponsorConfig) sponsorConfigs;
		// ── Validators ──
		uint256 minValidatorSignatures;
		uint256 validatorApprovalTimeout;
		// ── Access control ──
		mapping(address => mapping(bytes32 => bool)) hasRole;
		// ── EIP-712 ──
		bytes32 hashedName;
		bytes32 hashedVersion;
		// ── Initialization guard ──
		bool initialized;
		// ── Reentrancy guard ──
		uint256 reentrancyStatus;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
