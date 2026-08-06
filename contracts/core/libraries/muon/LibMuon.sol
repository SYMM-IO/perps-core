// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MuonStorage, SingleUpnlSig, SingleUpnlWithPendingBalanceSig } from "../../storages/MuonStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { IMuonSignatureVerifier, MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";
import { LibAccount } from "../LibAccount.sol";

library LibMuon {
	using ECDSA for bytes32;

	/// @notice Returns the current chain ID.
	function getChainId() internal view returns (uint256 id) {
		assembly {
			id := chainid()
		}
	}

	// CONTEXT for commented out lines
	// We're utilizing muon signatures for asset pricing and user uPNLs calculations.
	// Even though these signatures are necessary for full testing of the system, particularly when invoking various methods.
	// The process of creating automated functional signature for tests has proven to be either impractical or excessively time-consuming. therefore, we've established commenting out the necessary code as a workaround specifically for testing.
	// Essentially, during testing, we temporarily disable the code sections responsible for validating these signatures. The sections I'm referring to are located within the LibMuon file. Specifically, the body of the 'verifyTSSAndGateway' method is a prime candidate for temporary disablement. In addition, several 'require' statements within other functions of this file, which examine the signatures' expiration status, also need to be temporarily disabled.
	// However, it is crucial to note that these lines should not be disabled in the production deployed version.
	// We emphasize this because they are only disabled for testing purposes.
	/// @notice Verifies the TSS signature and gateway signature through the MuonSignatureVerifier with per-category authorization.
	function verifyTSSAndGateway(
		bytes32 hash,
		IMuonSignatureVerifier.SchnorrSign memory sign,
		bytes memory gatewaySignature,
		MuonFunction func
	) internal view {
		// == SignatureCheck( ==
		IMuonSignatureVerifier(GlobalAppStorage.layout().signatureVerifier).verify(hash, sign, gatewaySignature, func);
		// == ) ==
	}

	/// @notice Verifies the TSS signature and gateway signature without per-category authorization checks.
	function verifyTSSAndGateway(bytes32 hash, IMuonSignatureVerifier.SchnorrSign memory sign, bytes memory gatewaySignature) internal view {
		// == SignatureCheck( ==
		IMuonSignatureVerifier(GlobalAppStorage.layout().signatureVerifier).verify(hash, sign, gatewaySignature);
		// == ) ==
	}

	function getUpnlValidTime(MuonFunction func) internal view returns (uint256) {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		uint256 functionValidTime = muonLayout.upnlValidTimeByFunction[func];
		return functionValidTime == 0 ? muonLayout.upnlValidTime : functionValidTime;
	}

	function verifyUpnlTimestamp(uint256 timestamp, MuonFunction func) internal view {
		require(block.timestamp <= timestamp + getUpnlValidTime(func), "LibMuon: Expired signature");
	}

	/// @notice Longest UPNL signature validity currently reachable, across the global setting and every per-function override.
	/// @dev For guarantees that must outlive any signature still in flight, whatever category minted it. Used by
	///      SymbolAdjustmentFacet.finalizeRestatement to ensure old-basis signatures have expired before quote storage
	///      is rewritten, which is what lets Muon payloads stay free of a basis-version field.
	function maxUpnlValidTime() internal view returns (uint256 maxValidTime) {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		maxValidTime = muonLayout.upnlValidTime;
		for (uint256 i = 0; i <= uint256(type(MuonFunction).max); i++) {
			uint256 functionValidTime = muonLayout.upnlValidTimeByFunction[MuonFunction(i)];
			if (functionValidTime > maxValidTime) maxValidTime = functionValidTime;
		}
	}

	/// @notice Verifies Party B UPNL signature (uses per-partyA nonce in normal mode, zero in cross mode).
	function verifyPartyBUpnl(SingleUpnlSig memory upnlSig, address partyB, address partyA, MuonFunction func) internal view {
		verifyPartyBUpnl(upnlSig, partyB, partyA, false, func);
	}

	/// @notice Verifies Party B UPNL signature with configurable cross partyB nonce usage.
	function verifyPartyBUpnl(SingleUpnlSig memory upnlSig, address partyB, address partyA, bool useCrossCounter, MuonFunction func) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		// == SignatureCheck( ==
		verifyUpnlTimestamp(upnlSig.timestamp, func);
		// == ) ==
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				upnlSig.reqId,
				address(this),
				partyB,
				partyA,
				LibAccount.getPartyBSignatureUpnlCounter(partyB, partyA, useCrossCounter),
				upnlSig.upnl,
				upnlSig.timestamp,
				getChainId()
			)
		);
		verifyTSSAndGateway(hash, upnlSig.sigs, upnlSig.gatewaySignature, func);
	}

	/// @notice Verifies Party B UPNL signature that also carries pendingBalance and scaledLockedBalance.
	function verifyPartyBUpnlWithPendingBalance(
		SingleUpnlWithPendingBalanceSig memory upnlSig,
		address partyB,
		address partyA,
		bool useCrossCounter,
		MuonFunction func
	) internal view {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		// == SignatureCheck( ==
		verifyUpnlTimestamp(upnlSig.timestamp, func);
		// == ) ==
		bytes32 hash = keccak256(
			abi.encodePacked(
				muonLayout.muonAppId,
				upnlSig.reqId,
				address(this),
				partyB,
				partyA,
				LibAccount.getPartyBSignatureUpnlCounter(partyB, partyA, useCrossCounter),
				upnlSig.upnl,
				upnlSig.pendingBalance,
				upnlSig.scaledLockedBalance,
				upnlSig.timestamp,
				getChainId()
			)
		);
		verifyTSSAndGateway(hash, upnlSig.sigs, upnlSig.gatewaySignature, func);
	}
}
