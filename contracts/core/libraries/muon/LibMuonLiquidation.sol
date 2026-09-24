// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import {
	MuonStorage,
	SingleUpnlSig,
	LiquidationSig,
	DeferredLiquidationSig,
	QuotePriceSig,
	LiquidationSnapshotSig,
	LiquidationPartyBSymbolState
} from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { SymbolAdjustmentStorage, SymbolAdjustment } from "../../storages/SymbolAdjustmentStorage.sol";
import { LibMuon } from "./LibMuon.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library LibMuonLiquidation {
	bytes32 private constant LIQUIDATION_PRICE_BASIS_DOMAIN = keccak256("SYMMIO_LIQUIDATION_PRICE_BASIS_V1");

	/// @notice Verifies Party B UPNL signature for liquidation (uses per-partyA nonce in normal mode, zero in cross mode).
	function verifyPartyBUpnl(SingleUpnlSig memory upnlSig, address partyB, address partyA, MuonFunction func) internal view {
		LibMuon.verifyPartyBUpnl(upnlSig, partyB, partyA, func); // Uses useCrossCounter=false: per-partyA nonce in normal mode, zero in cross mode.
	}

	/// @notice Verifies a liquidation signature containing symbol prices and UPNL for Party A.
	function verifyLiquidationSig(LiquidationSig memory liquidationSig, address partyA, MuonFunction func) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		require(liquidationSig.prices.length == liquidationSig.symbolIds.length, "LibMuon: Invalid length");
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				liquidationSig.reqId,
				liquidationSig.liquidationId,
				address(this),
				"verifyLiquidationSig",
				partyA,
				AccountStorage.layout().partyAUpnlCounters[partyA],
				liquidationSig.upnl,
				liquidationSig.totalUnrealizedLoss,
				liquidationSig.symbolIds,
				liquidationSig.prices,
				liquidationSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(
			_bindLiquidationPriceBasis(hash, liquidationSig.symbolIds),
			liquidationSig.sigs,
			liquidationSig.gatewaySignature,
			func
		);
	}

	/// @notice Verifies a liquidation snapshot signature that commits historical insolvency plus PartyB-symbol price and funding states.
	function verifyLiquidationSnapshotSig(LiquidationSnapshotSig memory liquidationSig, address partyA, MuonFunction func) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				liquidationSig.reqId,
				liquidationSig.liquidationId,
				address(this),
				"verifyLiquidationSnapshotSig",
				partyA,
				AccountStorage.layout().partyAUpnlCounters[partyA],
				liquidationSig.upnl,
				liquidationSig.totalUnrealizedLoss,
				_hashPartyBSymbolStates(liquidationSig.states),
				liquidationSig.timestamp,
				liquidationSig.liquidationBlockNumber,
				liquidationSig.liquidationTimestamp,
				liquidationSig.liquidationAllocatedBalance,
				LibMuon.getChainId()
			)
		);
		uint256[] memory symbolIds = new uint256[](liquidationSig.states.length);
		for (uint256 i = 0; i < symbolIds.length; i++) {
			symbolIds[i] = liquidationSig.states[i].symbolId;
		}
		LibMuon.verifyTSSAndGateway(_bindLiquidationPriceBasis(hash, symbolIds), liquidationSig.sigs, liquidationSig.gatewaySignature, func);
	}

	function _hashPartyBSymbolStates(LiquidationPartyBSymbolState[] memory states) private pure returns (bytes32) {
		return keccak256(abi.encode(states));
	}

	/// @notice Verifies a deferred liquidation signature that includes block number and timestamp data.
	function verifyDeferredLiquidationSig(DeferredLiquidationSig memory liquidationSig, address partyA, MuonFunction func) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		require(liquidationSig.prices.length == liquidationSig.symbolIds.length, "LibMuon: Invalid length");
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				liquidationSig.reqId,
				liquidationSig.liquidationId,
				address(this),
				"verifyDeferredLiquidationSig",
				partyA,
				AccountStorage.layout().partyAUpnlCounters[partyA],
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
		LibMuon.verifyTSSAndGateway(
			_bindLiquidationPriceBasis(hash, liquidationSig.symbolIds),
			liquidationSig.sigs,
			liquidationSig.gatewaySignature,
			func
		);
	}

	/// @notice Verifies a quote prices signature for liquidation position settlement.
	function verifyQuotePrices(QuotePriceSig memory priceSig, MuonFunction func) internal view {
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
		uint256[] memory symbolIds = new uint256[](priceSig.quoteIds.length);
		for (uint256 i = 0; i < symbolIds.length; i++) {
			symbolIds[i] = QuoteStorage.layout().quotes[priceSig.quoteIds[i]].symbolId;
		}
		LibMuon.verifyTSSAndGateway(_bindLiquidationPriceBasis(hash, symbolIds), priceSig.sigs, priceSig.gatewaySignature, func);
	}

	/// @dev Muon must sign this envelope over the existing payload hash, using the same on-chain state as its price calculation.
	///      Opening a window advances its epoch; completing abort/finalization changes restating to false. Neither a future
	///      timestamp nor a later window can make an earlier price-basis signature valid again. Preserve order and duplicates.
	function _bindLiquidationPriceBasis(bytes32 payloadHash, uint256[] memory symbolIds) private view returns (bytes32) {
		bytes32[] memory priceBases = new bytes32[](symbolIds.length);
		for (uint256 i = 0; i < symbolIds.length; i++) {
			SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolIds[i]];
			priceBases[i] = keccak256(abi.encode(symbolIds[i], adjustment.restatementEpoch, adjustment.restating));
		}
		return keccak256(abi.encode(LIQUIDATION_PRICE_BASIS_DOMAIN, payloadHash, priceBases));
	}
}
