// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MuonStorage, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { LibMuon } from "./LibMuon.sol";
import { LibSymbolAdjustment } from "../LibSymbolAdjustment.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library LibMuonUnifiedSettlement {
	/// @notice Verifies a unified settlement signature for both cross and normal partyB modes.
	function verifyUnifiedSettlement(UnifiedSettlementSig memory settleSig, bool isCrossPartyB, MuonFunction func) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		// == SignatureCheck( ==
		LibMuon.verifyUpnlTimestamp(settleSig.timestamp, func);
		// == ) ==

		// Encode quote data
		bytes memory encodedData;
		for (uint256 i = 0; i < settleSig.quotesSettlementsData.length; i++) {
			uint256 quoteId = settleSig.quotesSettlementsData[i].quoteId;
			uint256 symbolId = QuoteStorage.layout().quotes[quoteId].symbolId;
			encodedData = abi.encodePacked(
				encodedData,
				quoteId,
				settleSig.quotesSettlementsData[i].currentPrice,
				settleSig.quotesSettlementsData[i].partyAIndex,
				LibSymbolAdjustment.basisVersion(symbolId)
			);
		}

		// Get partyA nonces
		uint256[] memory partyAUpnlCounters = new uint256[](settleSig.partyAs.length);
		for (uint256 i = 0; i < settleSig.partyAs.length; i++) {
			partyAUpnlCounters[i] = accountLayout.partyAUpnlCounters[settleSig.partyAs[i]];
		}

		bytes32 hash;
		if (isCrossPartyB) {
			// CrossPartyB mode: use cross nonce and aggregated UPNL
			hash = keccak256(
				abi.encodePacked(
					muonLayout.muonAppId,
					settleSig.reqId,
					address(this),
					"verifyUnifiedSettlement",
					isCrossPartyB,
					settleSig.partyB,
					uint256(0), // nonce is not used in cross mode
					partyAUpnlCounters,
					encodedData,
					settleSig.upnlPartyB, // aggregated UPNL
					settleSig.partyAs,
					settleSig.upnlPartyAs,
					settleSig.timestamp,
					LibMuon.getChainId()
				)
			);
		} else {
			// Normal mode: use per-partyA nonces for partyB and per-partyA UPNLs
			uint256[] memory partyBUpnlCounters = new uint256[](settleSig.partyAs.length);
			for (uint256 i = 0; i < settleSig.partyAs.length; i++) {
				partyBUpnlCounters[i] = accountLayout.partyBUpnlCounters[settleSig.partyB][settleSig.partyAs[i]];
			}

			hash = keccak256(
				abi.encodePacked(
					muonLayout.muonAppId,
					settleSig.reqId,
					address(this),
					"verifyUnifiedSettlement",
					isCrossPartyB,
					settleSig.partyB,
					partyBUpnlCounters, // per-partyA nonces
					partyAUpnlCounters,
					encodedData,
					settleSig.upnlPartyBPerPartyA, // per-partyA UPNLs
					settleSig.partyAs,
					settleSig.upnlPartyAs,
					settleSig.timestamp,
					LibMuon.getChainId()
				)
			);
		}

		LibMuon.verifyTSSAndGateway(hash, settleSig.sigs, settleSig.gatewaySignature, func);
	}
}
