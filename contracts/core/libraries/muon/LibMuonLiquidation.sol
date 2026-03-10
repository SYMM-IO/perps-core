// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MuonStorage, SingleUpnlSig, LiquidationSig, DeferredLiquidationSig, QuotePriceSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { LibMuon } from "./LibMuon.sol";

library LibMuonLiquidation {
	/// @notice Verifies Party B UPNL signature for liquidation (uses per-partyA nonce in normal mode, zero in cross mode).
	function verifyPartyBUpnl(SingleUpnlSig memory upnlSig, address partyB, address partyA) internal view {
		LibMuon.verifyPartyBUpnl(upnlSig, partyB, partyA); // Uses useCrossNonce=false: per-partyA nonce in normal mode, zero in cross mode.
	}

	/// @notice Verifies a liquidation signature containing symbol prices and UPNL for Party A.
	function verifyLiquidationSig(LiquidationSig memory liquidationSig, address partyA) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		require(liquidationSig.prices.length == liquidationSig.symbolIds.length, "LibMuon: Invalid length");
		LibMuon.verifyNotStaleAfterEpochChange(liquidationSig.timestamp, partyA);
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				liquidationSig.reqId,
				liquidationSig.liquidationId,
				address(this),
				"verifyLiquidationSig",
				partyA,
				AccountStorage.layout().partyANonces[partyA],
				liquidationSig.upnl,
				liquidationSig.totalUnrealizedLoss,
				liquidationSig.symbolIds,
				liquidationSig.prices,
				liquidationSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, liquidationSig.sigs, liquidationSig.gatewaySignature);
	}

	/// @notice Verifies a deferred liquidation signature that includes block number and timestamp data.
	function verifyDeferredLiquidationSig(DeferredLiquidationSig memory liquidationSig, address partyA) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		require(liquidationSig.prices.length == liquidationSig.symbolIds.length, "LibMuon: Invalid length");
		LibMuon.verifyNotStaleAfterEpochChange(liquidationSig.timestamp, partyA);
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				liquidationSig.reqId,
				liquidationSig.liquidationId,
				address(this),
				"verifyDeferredLiquidationSig",
				partyA,
				AccountStorage.layout().partyANonces[partyA],
				liquidationSig.upnl,
				liquidationSig.totalUnrealizedLoss,
				liquidationSig.symbolIds,
				liquidationSig.prices,
				liquidationSig.timestamp,
				liquidationSig.liquidationBlockNumber,
				liquidationSig.liquidationTimestamp,
				liquidationSig.liquidationAllocatedBalance,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, liquidationSig.sigs, liquidationSig.gatewaySignature);
	}

	/// @notice Verifies a quote prices signature for liquidation position settlement.
	function verifyQuotePrices(QuotePriceSig memory priceSig) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		require(priceSig.prices.length == priceSig.quoteIds.length, "LibMuon: Invalid length");
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				priceSig.reqId,
				address(this),
				priceSig.quoteIds,
				priceSig.prices,
				priceSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, priceSig.sigs, priceSig.gatewaySignature);
	}
}
