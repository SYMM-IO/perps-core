// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../storages/MuonStorage.sol";
import "../../storages/AccountStorage.sol";
import "./LibMuon.sol";
import "../LibAccount.sol";

library LibMuonPartyB {
	function verifyPairUpnlAndPrice(PairUpnlAndPriceSig memory upnlSig, address partyB, address partyA, uint256 symbolId) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		// == SignatureCheck( ==
		require(block.timestamp <= upnlSig.timestamp + muonLayout.upnlValidTime, "LibMuon: Expired signature");
		// == ) ==
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				upnlSig.reqId,
				address(this),
				partyB,
				partyA,
				LibAccount.getPartyBSignatureNonce(partyB, partyA,false),
				AccountStorage.layout().partyANonces[partyA],
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				symbolId,
				upnlSig.price,
				upnlSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, upnlSig.sigs, upnlSig.gatewaySignature);
	}

	function verifyPartyBUpnl(SingleUpnlSig memory upnlSig, address partyB, address partyA) internal view {
		LibMuon.verifyPartyBUpnl(upnlSig, partyB, partyA); // Here the nonce should be zero in master account mode as it is called while opening, closing or locking quotes.
		
	}
}
