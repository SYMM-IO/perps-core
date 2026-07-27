// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MuonStorage, SettlementSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { LibMuon } from "./LibMuon.sol";
import { LibAccount } from "../LibAccount.sol";
import { LibSymbolAdjustment } from "../LibSymbolAdjustment.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library LibMuonSettlement {
	/// @notice Verifies a settlement signature for non-cross partyB mode UPNL settlement.
	function verifySettlement(SettlementSig memory settleSig, address partyA, MuonFunction func) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		// == SignatureCheck( ==
		LibMuon.verifyUpnlTimestamp(settleSig.timestamp, func);
		// == ) ==
		bytes memory encodedData;
		uint256[] memory nonces = new uint256[](settleSig.quotesSettlementsData.length);
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		for (uint256 i = 0; i < settleSig.quotesSettlementsData.length; i++) {
			uint256 quoteId = settleSig.quotesSettlementsData[i].quoteId;
			uint256 symbolId = quoteLayout.quotes[quoteId].symbolId;
			// Get Party B nonce for Standard Account Mode only as it is called for settlement in non cross partyB mode
			nonces[i] = LibAccount.getPartyBSignatureNonce(quoteLayout.quotes[quoteId].partyB, partyA, false);

			// Encode the settlement data
			encodedData = abi.encodePacked(
				encodedData, // Append the previously encoded data
				quoteId,
				settleSig.quotesSettlementsData[i].currentPrice,
				settleSig.quotesSettlementsData[i].partyBUpnlIndex,
				LibSymbolAdjustment.basisVersion(symbolId)
			);
		}
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				settleSig.reqId,
				address(this),
				"verifySettlement",
				nonces,
				AccountStorage.layout().partyANonces[partyA],
				encodedData,
				settleSig.upnlPartyBs,
				settleSig.upnlPartyA,
				settleSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, settleSig.sigs, settleSig.gatewaySignature, func);
	}
}
