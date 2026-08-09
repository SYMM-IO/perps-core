// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonLiquidation } from "../muon/LibMuonLiquidation.sol";
import { LibPartyALiquidationSnapshotGuards } from "./LibPartyALiquidationSnapshotGuards.sol";
import { LibPartyALiquidationShared } from "./LibPartyALiquidationShared.sol";
import { LibSymbolAdjustment } from "../LibSymbolAdjustment.sol";
import { AccountStorage, LiquidationDetail, LiquidationPartyBSymbolSnapshot } from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LiquidationSnapshotSig } from "../../storages/MuonStorage.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library LibPartyALiquidationSnapshotSetup {
	/// @notice Verifies a signed liquidation snapshot and starts PartyA liquidation.
	function liquidatePartyAWithSnapshot(address partyA, LiquidationSnapshotSig memory liquidationSig) public {
		LibMuonLiquidation.verifyLiquidationSnapshotSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);
		_requireHistoricalLiquidationFields(liquidationSig);
		require(liquidationSig.states.length == 0, "LiquidationFacet: Unexpected snapshot states");
		_startHistoricalPartyALiquidation(partyA, liquidationSig);
		LibPartyALiquidationSnapshotGuards.enablePartyBSymbolSnapshotPricing(partyA);
	}

	/// @notice Applies Muon-signed snapshot prices/funding state for an in-progress PartyA liquidation.
	function setSymbolsPriceWithSnapshot(address partyA, LiquidationSnapshotSig memory liquidationSig) public {
		LibMuonLiquidation.verifyLiquidationSnapshotSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);
		_requireHistoricalLiquidationFields(liquidationSig);
		_requireExistingSnapshotLiquidationMatches(partyA, liquidationSig);
		_applySnapshotPrices(partyA, liquidationSig);
	}

	/// @notice Verifies a signed liquidation snapshot, starts liquidation, and applies its signed price/funding state.
	function startAndSetSymbolsPriceWithSnapshot(address partyA, LiquidationSnapshotSig memory liquidationSig) public {
		LibMuonLiquidation.verifyLiquidationSnapshotSig(liquidationSig, partyA, MuonFunction.LiquidationPartyA);
		_requireHistoricalLiquidationFields(liquidationSig);
		_startHistoricalPartyALiquidation(partyA, liquidationSig);
		LibPartyALiquidationSnapshotGuards.enablePartyBSymbolSnapshotPricing(partyA);
		_applySnapshotPrices(partyA, liquidationSig);
	}

	function _startHistoricalPartyALiquidation(address partyA, LiquidationSnapshotSig memory liquidationSig) private {
		LibPartyALiquidationShared.startPartyALiquidation(
			partyA,
			liquidationSig.liquidationId,
			liquidationSig.upnl,
			liquidationSig.totalUnrealizedLoss,
			liquidationSig.timestamp,
			liquidationSig.liquidationTimestamp,
			liquidationSig.liquidationAllocatedBalance
		);
	}

	function _applySnapshotPrices(address partyA, LiquidationSnapshotSig memory liquidationSig) private {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		require(accountLayout.liquidationDetails[partyA].timestamp == liquidationSig.timestamp, "LiquidationFacet: Invalid liquidation timestamp");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		LibPartyALiquidationShared.validateLiquidationPriceSetup(partyA, liquidationSig.liquidationId);

		for (uint256 index = 0; index < liquidationSig.states.length; index++) {
			LibSymbolAdjustment.requireNotFrozen(liquidationSig.states[index].symbolId);
			accountLayout.liquidationPartyBSymbolSnapshots[partyA][liquidationSig.liquidationId][liquidationSig.states[index].partyB][
				liquidationSig.states[index].symbolId
			] = LiquidationPartyBSymbolSnapshot({
				isSet: true,
				price: liquidationSig.states[index].price,
				cumulativeLongFee: liquidationSig.states[index].cumulativeLongFee,
				cumulativeShortFee: liquidationSig.states[index].cumulativeShortFee
			});
		}
	}

	function _requireHistoricalLiquidationFields(LiquidationSnapshotSig memory liquidationSig) private pure {
		require(liquidationSig.liquidationBlockNumber != 0, "LiquidationFacet: Missing liquidation block");
		require(liquidationSig.liquidationTimestamp != 0, "LiquidationFacet: Missing liquidation timestamp");
	}

	function _requireExistingSnapshotLiquidationMatches(address partyA, LiquidationSnapshotSig memory liquidationSig) private view {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		LiquidationDetail storage detail = accountLayout.liquidationDetails[partyA];
		require(keccak256(detail.liquidationId) == keccak256(liquidationSig.liquidationId), "LiquidationFacet: Invalid liquidationId");
		require(detail.timestamp == liquidationSig.timestamp, "LiquidationFacet: Invalid liquidation timestamp");
		require(detail.involvedPartyBCounts == 0, "LiquidationFacet: Positions already liquidated");
		LibPartyALiquidationSnapshotGuards.requirePartyBSymbolSnapshotPricingEnabled(accountLayout, partyA);
		require(detail.liquidationTimestamp == liquidationSig.liquidationTimestamp, "LiquidationFacet: Invalid liquidation timestamp");
	}
}
