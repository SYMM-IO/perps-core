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
			LibMuonSettlement.verifySettlement(settleSig, partyA);
		}
		return LibSettlement.settleUpnl(settleSig, updatedPrices, partyA, false);
	}

	/// @notice Unified settlement that works for both crossPartyB and normal partyB modes
	function settleUpnlUnified(
		UnifiedSettlementSig memory sig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyAsAllocatedBalances) {
		bool isCrossPartyB = MAStorage.layout().crossModeEnabledForPartyB[sig.partyB];
		LibMuonUnifiedSettlement.verifyUnifiedSettlement(sig, isCrossPartyB);
		(newPartyAsAllocatedBalances, ) = LibSettlement.settleUpnlUnified(sig, updatedPrices, false);
	}
}
