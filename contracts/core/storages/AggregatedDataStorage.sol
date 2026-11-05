// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PositionType } from "./QuoteStorage.sol";

/// @notice Aggregated position data for efficient UPNL calculations
/// @dev Tracks total amount and notional value per position type per symbol
struct PartiesAggregatedPositions {
	uint256 aggregatedAmount;
	uint256 aggregatedNotional;
}

/// @notice Aggregated funding payment data for efficient funding calculations
/// @dev Tracks weighted sum of paid funding for position groups
struct PartiesAggregatedFunding {
	int256 weightedPaidFunding;
}

/// @title AggregatedDataStorage
/// @notice Aggregated positions and funding used for UPNL calculations.
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library AggregatedDataStorage {
	bytes32 internal constant AGGREGATED_DATA_STORAGE_SLOT = keccak256("diamond.standard.storage.aggregateddata");

	struct Layout {
		/// @notice Global aggregated positions for cross-margin PartyBs
		/// @dev Maps partyB => symbolId => positionType => aggregates. For cross-mode
		///      PartyBs, this tracks their total exposure across ALL PartyAs combined.
		///      Used for global UPNL calculations in cross-margin mode.
		mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedPositions))) partyBAggregatedPositions;
		/// @notice Per-counterparty aggregated positions from PartyB's perspective
		/// @dev Maps partyB => partyA => symbolId => positionType => aggregates.
		///      Tracks PartyB's exposure to each specific PartyA for isolated UPNL.
		mapping(address => mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedPositions)))) partyBAggregatedPositionsPerPartyA;
		/// @notice Per-counterparty aggregated positions from PartyA's perspective
		/// @dev Maps partyA => partyB => symbolId => positionType => aggregates.
		///      Tracks PartyA's exposure per PartyB for UPNL calculations.
		mapping(address => mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedPositions)))) partyAAggregatedPositionsPerPartyB;
		/// @notice Symbols with open positions for cross-margin PartyBs
		/// @dev Maps partyB => symbolId[]. Only symbols with active positions are here.
		///      Enables iteration over only relevant symbols for UPNL calculations.
		mapping(address => uint256[]) partyBActiveSymbols;
		/// @notice Index lookup for partyBActiveSymbols array
		/// @dev Maps partyB => symbolId => index+1 (0 means not active). The +1 offset
		///      lets us distinguish "not in array" (0) from "at index 0" (1).
		mapping(address => mapping(uint256 => uint256)) partyBActiveSymbolsIndex;
		/// @notice Symbols with open positions per PartyA-PartyB pair (PartyA's view)
		/// @dev Maps partyA => partyB => symbolId[]. Tracks which symbols PartyA has
		///      positions in with each PartyB.
		mapping(address => mapping(address => uint256[])) partyAActiveSymbolsPerPartyB;
		/// @notice Index lookup for partyAActiveSymbolsPerPartyB
		/// @dev Maps partyA => partyB => symbolId => index+1.
		mapping(address => mapping(address => mapping(uint256 => uint256))) partyAActiveSymbolsIndexPerPartyB;
		/// @notice Symbols with open positions per PartyB-PartyA pair (PartyB's view)
		/// @dev Maps partyB => partyA => symbolId[]. Tracks which symbols PartyB has
		///      positions in with each PartyA.
		mapping(address => mapping(address => uint256[])) partyBActiveSymbolsPerPartyA;
		/// @notice Index lookup for partyBActiveSymbolsPerPartyA
		/// @dev Maps partyB => partyA => symbolId => index+1.
		mapping(address => mapping(address => mapping(uint256 => uint256))) partyBActiveSymbolsIndexPerPartyA;
		/// @notice Global aggregated funding for cross-margin PartyBs
		/// @dev Maps partyB => symbolId => positionType => funding aggregates.
		///      Tracks weighted sum of funding payments for cross-mode UPNL.
		mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedFunding))) partyBAggregatedFunding;
		/// @notice Per-counterparty aggregated funding from PartyA's perspective
		/// @dev Maps partyA => partyB => symbolId => positionType => funding.
		///      Used with per-hedger funding rates for accurate PartyA UPNL.
		mapping(address => mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedFunding)))) partyAAggregatedFundingPerPartyB;
		/// @notice Per-counterparty aggregated funding from PartyB's perspective
		/// @dev Maps partyB => partyA => symbolId => positionType => funding.
		///      The PartyB side of funding tracking for isolated mode.
		mapping(address => mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedFunding)))) partyBAggregatedFundingPerPartyA;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = AGGREGATED_DATA_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
