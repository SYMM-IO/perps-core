// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MuonStorage, PairUpnlAndPriceSig, SingleUpnlSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { LibMuon } from "./LibMuon.sol";
import { LibAccount } from "../LibAccount.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library LibMuonPartyB {
	/// @notice Verifies a pair UPNL and price signature for Party B position actions.
	function verifyPairUpnlAndPrice(
		PairUpnlAndPriceSig memory upnlSig,
		address partyB,
		address partyA,
		uint256 symbolId,
		MuonFunction func
	) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		// == SignatureCheck( ==
		LibMuon.verifyUpnlTimestamp(upnlSig.timestamp, func);
		// == ) ==
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				upnlSig.reqId,
				address(this),
				partyB,
				partyA,
				LibAccount.getPartyBSignatureNonce(partyB, partyA, false),
				AccountStorage.layout().partyANonces[partyA],
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				symbolId,
				upnlSig.price,
				upnlSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, upnlSig.sigs, upnlSig.gatewaySignature, func);
	}

	/// @notice Verifies Party B UPNL signature, delegating to LibMuon (uses per-partyA nonce in normal mode, zero in cross mode).
	function verifyPartyBUpnl(SingleUpnlSig memory upnlSig, address partyB, address partyA, MuonFunction func) internal view {
		LibMuon.verifyPartyBUpnl(upnlSig, partyB, partyA, func); // Uses useCrossNonce=false: nonce is zero in cross partyB mode, per-partyA nonce otherwise.
	}
}
