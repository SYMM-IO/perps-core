// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Standing operational-fee allowance state for a (payer, charger) pair.
/// @dev `allowance` is the remaining amount the charger may draw. A reduction is timelocked:
///      `pendingAllowance`/`reductionReadyAt` hold a requested lower remaining allowance that takes effect
///      only at/after `reductionReadyAt` (lazily applied on the next charge; views report it as effective once ready).
///      `feeMultiplier` is a priority signal for chargers; 0 means the default 1x multiplier.
struct AllowanceState {
	uint256 allowance;
	uint256 pendingAllowance;
	/// @dev 0 means no reduction is pending.
	uint256 reductionReadyAt;
	uint256 feeMultiplier;
}

/// @title OperationalFeeStorage
/// @notice Per-(payer, charger) standing operational-fee allowance accounting.
library OperationalFeeStorage {
	bytes32 internal constant OPERATIONAL_FEE_STORAGE_SLOT = keccak256("diamond.standard.storage.operationalfee");

	struct Layout {
		/// @dev Reserved for the deprecated allowances mapping that used layout slot 0. Keeping this slot
		///      unused moves the new mapping to slot 1 so existing on-chain allowance state is ignored.
		bytes32 deprecatedAllowancesSlot;
		/// @notice payer => charger => allowance state
		mapping(address => mapping(address => AllowanceState)) allowances;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = OPERATIONAL_FEE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
