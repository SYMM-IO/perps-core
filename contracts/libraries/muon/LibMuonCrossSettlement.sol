// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MuonStorage, MasterAccountSettlementSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { LibMuon } from "./LibMuon.sol";
import { LibAccount } from "../LibAccount.sol";

library LibMuonCrossSettlement {
	function verifyMasterAccountSettlement(MasterAccountSettlementSig memory settleSig) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		QuoteStorage.Layout storage quotes = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		// == SignatureCheck( ==
// 		require(block.timestamp <= settleSig.timestamp + muonLayout.upnlValidTime, "LibMuon: Expired signature");
		// == ) ==
		uint256[] memory partyANonces = new uint256[](settleSig.quotesSettlementsData.length);
		bytes memory encodedData;
		address partyA;

		for (uint256 i = 0; i < settleSig.quotesSettlementsData.length; i++) {
			partyA = quotes.quotes[settleSig.quotesSettlementsData[i].quoteId].partyA;
			partyANonces[i] = accountLayout.partyANonces[partyA];
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
				accountLayout.partyBNonces[settleSig.partyB][address(0)], // always uses party B nonce in Master Account Mode
				partyANonces,
				encodedData,
				settleSig.partyB,
				settleSig.upnlPartyB,
				settleSig.partyAs,
				settleSig.upnlPartyAs,
				settleSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, settleSig.sigs, settleSig.gatewaySignature);
	}
}
