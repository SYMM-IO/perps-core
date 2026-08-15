// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonSettlement } from "../../libraries/muon/LibMuonSettlement.sol";
import { LibMuonUnifiedSettlement } from "../../libraries/muon/LibMuonUnifiedSettlement.sol";
import { LibSettlement } from "../../libraries/LibSettlement.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { SettlementSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library SettlementFacetImpl {
	/// @notice Settles UPNL for quotes between partyB (caller) and a specific partyA
	function settleUpnl(
		SettlementSig memory settleSig,
		uint256[] memory updatedPrices,
		address partyA
	) internal returns (uint256[] memory newPartyBsAllocatedBalances) {
		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();
		address signer = LibSigner.getSigner();
		if (tradingLayout.bindState[partyA].partyB != signer || !tradingLayout.isPartyBBindable[signer]) {
			LibMuonSettlement.verifySettlement(settleSig, partyA, MuonFunction.Settlement);
		}
		return LibSettlement.settleUpnl(settleSig, updatedPrices, partyA, false);
	}

	/// @notice Unified settlement that works for both crossPartyB and normal partyB modes
	/// @dev Muon verification is skipped only when the caller is settling its own book and
	///      every partyA in the signature is bound to it (oracle-less trading mode).
	function settleUpnlUnified(
		UnifiedSettlementSig memory sig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyAsAllocatedBalances) {
		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();
		address signer = LibSigner.getSigner();
		bool allPartyAsBound = signer == sig.partyB && tradingLayout.isPartyBBindable[signer];
		if (allPartyAsBound) {
			for (uint256 i = 0; i < sig.partyAs.length; i++) {
				if (tradingLayout.bindState[sig.partyAs[i]].partyB != signer) {
					allPartyAsBound = false;
					break;
				}
			}
		}
		if (!allPartyAsBound) {
			bool isCrossPartyB = MAStorage.layout().crossModeEnabledForPartyB[sig.partyB];
			LibMuonUnifiedSettlement.verifyUnifiedSettlement(sig, isCrossPartyB, MuonFunction.Settlement);
		}
		(newPartyAsAllocatedBalances, ) = LibSettlement.settleUpnlUnified(sig, updatedPrices, false, true, allPartyAsBound);
	}

	/// @notice Settles a cross-mode PartyB's uPNL from OTHER solvent counterparties during PartyA liquidation.
	/// @dev Called by the liquidator between liquidatePositionsPartyA and settlePartyALiquidation.
	///      Realizes PartyB's unrealized profit into partyBAllocatedBalances so that
	///      settlePartyALiquidation can collect the full settlement amount.
	/// @param liquidatedPartyA The partyA currently being liquidated
	/// @param sig Unified settlement signature for the cross-mode partyB's positions with OTHER partyAs
	/// @param updatedPrices New opened prices for the settled quotes
	function settlePartyBUpnlForLiquidation(
		address liquidatedPartyA,
		UnifiedSettlementSig memory sig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyAsAllocatedBalances) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(maLayout.liquidationStatus[liquidatedPartyA], "SettlementFacet: PartyA not in liquidation");
		require(maLayout.crossModeEnabledForPartyB[sig.partyB], "SettlementFacet: PartyB not cross-mode");
		require(accountLayout.settlementStates[liquidatedPartyA][sig.partyB].pending, "SettlementFacet: No pending settlement");

		for (uint256 i = 0; i < sig.partyAs.length; i++) {
			require(sig.partyAs[i] != liquidatedPartyA, "SettlementFacet: Cannot settle with liquidated partyA");
		}

		LibMuonUnifiedSettlement.verifyUnifiedSettlement(sig, true, MuonFunction.Settlement);
		uint256 partyBBalanceBefore = accountLayout.partyBAllocatedBalances[sig.partyB][address(0)];
		(newPartyAsAllocatedBalances, ) = LibSettlement.settleUpnlUnified(sig, updatedPrices, true, false, false);
		require(accountLayout.partyBAllocatedBalances[sig.partyB][address(0)] >= partyBBalanceBefore, "SettlementFacet: PartyB balance decreased");
	}
}
