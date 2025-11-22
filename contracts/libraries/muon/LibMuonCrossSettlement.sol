// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../storages/MuonStorage.sol";
import "../../storages/AccountStorage.sol";
import "./LibMuon.sol";

library LibMuonCrossSettlement {
	function verifyCrossSettlement(CrossSettlementSig memory settleSig) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		QuoteStorage.Layout storage quotes = QuoteStorage.layout();
		// == SignatureCheck( ==
		require(block.timestamp <= settleSig.timestamp + muonLayout.upnlValidTime, "LibMuon: Expired signature");
		// == ) ==
		bytes memory encodedData;
		uint256[] memory partyBNonces = new uint256[](settleSig.quotesSettlementsData.length);
		uint256[] memory partyANonces = new uint256[](settleSig.quotesSettlementsData.length);
		address partyA;
		for (uint256 i = 0; i < settleSig.quotesSettlementsData.length; i++) {
			partyA = quotes.quotes[settleSig.quotesSettlementsData[i].quoteId].partyA;
			partyBNonces[i] = AccountStorage.layout().partyBNonces[quotes.quotes[settleSig.quotesSettlementsData[i].quoteId].partyB][partyA];
			partyANonces[i] = AccountStorage.layout().partyANonces[partyA];
			encodedData = abi.encodePacked(
				encodedData, // Append the previously encoded data
				settleSig.quotesSettlementsData[i].quoteId,
				settleSig.quotesSettlementsData[i].currentPrice
			);
		}
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				settleSig.reqId,
				address(this),
				"verifyCrossSettlement",
				partyBNonces,
				partyANonces,
				encodedData,
				settleSig.upnlPartyBs,
				settleSig.upnlPartyAs,
				settleSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, settleSig.sigs, settleSig.gatewaySignature);
	}
}
