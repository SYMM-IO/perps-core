// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MuonStorage, SingleUpnlSig, SingleUpnlWithPendingBalanceSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { LibMuon } from "./LibMuon.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library LibMuonAccount {
	/// @notice Verifies Party A UPNL signature against the Muon oracle.
	function verifyPartyAUpnl(SingleUpnlSig memory upnlSig, address partyA, MuonFunction func) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		// == SignatureCheck( ==
		LibMuon.verifyUpnlTimestamp(upnlSig.timestamp, func);
		// == ) ==
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				upnlSig.reqId,
				address(this),
				partyA,
				AccountStorage.layout().partyANonces[partyA],
				upnlSig.upnl,
				upnlSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, upnlSig.sigs, upnlSig.gatewaySignature, func);
	}

	/// @notice Verifies Party A UPNL signature that also includes a pending balance check.
	function verifyPartyAUpnlWithPendingBalance(SingleUpnlWithPendingBalanceSig memory upnlSig, address partyA, MuonFunction func) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		// == SignatureCheck( ==
		LibMuon.verifyUpnlTimestamp(upnlSig.timestamp, func);
		// == ) ==
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				upnlSig.reqId,
				address(this),
				partyA,
				AccountStorage.layout().partyANonces[partyA],
				upnlSig.upnl,
				upnlSig.pendingBalance,
				upnlSig.timestamp,
				LibMuon.getChainId()
			)
		);
		LibMuon.verifyTSSAndGateway(hash, upnlSig.sigs, upnlSig.gatewaySignature, func);
	}
}
