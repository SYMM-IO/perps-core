// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Tracks funding rates and their weighted averages over time
/// @dev Funding rates are stored as price-adjusted values (rate * marketPrice)
///      to avoid repeated multiplication during fee calculations
struct FundingFee {
	// Current epoch's funding rates (price-adjusted: rate * marketPrice / 1e18)
	int256 currentLongRate; // Current rate for long positions
	int256 currentShortRate; // Current rate for short positions
	// Weighted average rates over all tracked epochs
	int256 accumulatedLongRate; // Historical weighted average for longs
	int256 accumulatedShortRate; // Historical weighted average for shorts
	// Epoch tracking
	uint256 lastUpdatedEpoch; // Epoch number when rates were last updated
	uint256 lastUpdatedTimeStamp;
	uint256 startEpochTimeStamp;
	uint256 startEpoch; // Epoch when funding tracking started
	uint256 epochDuration; // Duration of each funding period in seconds
}

/// @title FundingStorage
/// @notice Funding rate configuration and system flags
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library FundingStorage {
	bytes32 internal constant FUNDING_STORAGE_SLOT = keccak256("diamond.standard.storage.funding");

	struct Layout {
		/// @notice Flag to disable the old per-quote funding iteration system
		/// @dev The old system required iterating through quotes to charge funding. When true,
		///      the new accumulative funding system is used exclusively. Set true once all
		///      solvers have migrated to the new system.
		bool legacyFundingDeprecated;
		/// @notice Enables the new accumulated funding rate system
		/// @dev The new system tracks weighted average funding rates at the symbol level.
		///      Both this and legacyFundingDeprecated control the funding transition.
		bool accumulatedFundingActivated;
		/// @notice Funding rate configuration per symbol per PartyB
		/// @dev Maps symbolId => partyB => FundingFee. Each hedger sets their own funding
		///      rates for each symbol. Contains current rates, accumulated averages,
		///      and epoch tracking for the weighted average funding system.
		mapping(uint256 => mapping(address => FundingFee)) fundingFees;
		/// @notice Timestamp of last epoch duration change per PartyB
		/// @dev Used to invalidate stale UPNL signatures after epoch duration updates.
		///      Signatures with timestamp before this are rejected, since funding is
		///      included in UPNL and changing the epoch alters accrued funding.
		mapping(address => uint256) lastEpochDurationChangeTimestamp;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = FUNDING_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
