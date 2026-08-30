// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBExecutionFacet } from "./IPartyBExecutionFacet.sol";
import { IPartyBQuoteActionsFacet } from "../PartyBQuoteActions/IPartyBQuoteActionsFacet.sol";
import { IPartyBPositionActionsFacet } from "../PartyBPositionActions/IPartyBPositionActionsFacet.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { LibSolverFee } from "../../libraries/LibSolverFee.sol";
import { QuoteStorage, Quote, SolverFeeType } from "../../storages/QuoteStorage.sol";
import { SingleUpnlSig, PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

/// @notice Party B convenience execution and standalone solver fee charging.
/// @dev Trade execution stays on the ordinary PartyB facets. Solver fees are separate fixed-amount draws
///      bounded by the quote-time rate caps and routed by an arbitrary tag.
contract PartyBExecutionFacet is Accessibility, Pausable, IPartyBExecutionFacet {
	/// @notice Locks a pending quote and opens the position in one call without charging a solver fee.
	/// @dev Gas-optimized replacement for separate lockQuote and openPosition calls. Both legs run through
	///      the diamond, so the ordinary modifiers, state transitions, hooks, and events remain authoritative.
	function lockAndOpenPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		SingleUpnlSig memory lockSig,
		PairUpnlAndPriceSig memory upnlSig
	) external whenNotPartyBOpenPositionsPaused onlyPartyB notLiquidated(quoteId) {
		_callFacet(abi.encodeCall(IPartyBQuoteActionsFacet.lockQuote, (quoteId, lockSig)));
		_callFacet(abi.encodeCall(IPartyBPositionActionsFacet.openPosition, (quoteId, filledAmount, openedPrice, upnlSig)));
	}

	/// @notice Charges a fixed solver fee from PartyA's allocated balance against the quote's selected rate cap.
	/// @dev This call performs no Muon or post-fee solvency check. It enforces an unsuspended PartyA, lifecycle,
	///      caller ownership, the cumulative quote-time cap, sufficient allocated balance, and safe receiver routing.
	///      A successful charge may make PartyA liquidatable. OPEN fees are charged after opening; CLOSE fees are
	///      charged against an unexpired close request before its fill executes.
	function chargeSolverFee(
		uint256 quoteId,
		SolverFeeType feeType,
		uint256 amount,
		bytes calldata tag
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		bytes32 tagHash = keccak256(tag);
		address receiver = LibSolverFee.chargeSolverFee(quoteId, feeType, amount, tagHash);
		emit SolverFeeCharged(quoteId, quote.partyA, quote.partyB, receiver, quote.symbolId, feeType, amount, tag);
	}

	/// @dev Runs a sibling facet function through the diamond so its modifiers, guards, and events execute verbatim.
	function _callFacet(bytes memory callData) private {
		// solhint-disable-next-line avoid-low-level-calls
		(bool success, bytes memory result) = address(this).delegatecall(callData);
		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}
	}
}
