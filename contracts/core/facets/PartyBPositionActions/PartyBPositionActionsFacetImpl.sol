// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonPartyB } from "../../libraries/muon/LibMuonPartyB.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { LibPartyBPositionsActions } from "../../libraries/LibPartyBPositionsActions.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library PartyBPositionActionsFacetImpl {
	using LockedValuesOps for LockedValues;

	/// @notice Opens a position for a single quote with solvency verification and connection tracking
	function openPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		PairUpnlAndPriceSig memory upnlSig
	) internal returns (uint256 currentId) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		require(!appLayout.partyBOpenPositionsPausedPerPartyB[quote.partyB], "PartyBFacet: PartyB open positions paused");
		require(MAStorage.layout().affiliateStatus[quote.affiliate] || quote.affiliate == address(0), "PartyBFacet: Invalid affiliate");
		require(quote.affiliate == address(0) || appLayout.affiliateShutdownTime[quote.affiliate] == 0, "PartyBFacet: Affiliate shutdown scheduled");
		require(accountLayout.suspendedAddresses[quote.partyA] == false, "PartyBFacet: PartyA is suspended");
		require(!accountLayout.suspendedAddresses[LibSigner.getSigner()], "PartyBFacet: Sender is Suspended");
		require(!appLayout.partyBEmergencyStatus[quote.partyB], "PartyBFacet: PartyB is in emergency mode");
		require(!appLayout.emergencyMode, "PartyBFacet: System is in emergency mode");

		// Check symbol restriction based on connections
		require(
			LibConnections.isSymbolAllowedForPartyA(quote.partyA, quote.symbolId),
			"PartyBFacet: Symbol not allowed due to connection restrictions"
		);

		currentId = LibPartyBPositionsActions.openPosition(quoteId, filledAmount, openedPrice);

		if (quote.quoteStatus == QuoteStatus.OPENED) {
			LibConnections.addConnection(quote.partyA, quote.partyB);
		}

		if (
			TradingModeStorage.layout().bindState[quote.partyA].partyB != quote.partyB || !TradingModeStorage.layout().isPartyBBindable[quote.partyB]
		) {
			LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId, MuonFunction.Trading);

			uint256[] memory quoteIds = new uint256[](1);
			uint256[] memory filledAmounts = new uint256[](1);
			uint256[] memory marketPrices = new uint256[](1);
			quoteIds[0] = quoteId;
			filledAmounts[0] = filledAmount;
			marketPrices[0] = upnlSig.price;
			LibSolvency.requireSolventAfterOpenPosition(
				quoteIds,
				filledAmounts,
				marketPrices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				quote.partyB,
				quote.partyA
			);
		}

		LibAccount.increaseBothUpnlCounters(quote.partyB, quote.partyA);
	}

	/// @notice Verifies solvency and fills a close request for a single quote
	function fillCloseRequest(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, PairUpnlAndPriceSig memory upnlSig) internal {
		_fillCloseRequest(quoteId, filledAmount, closedPrice, upnlSig);
	}

	/// @notice Accepts a cancel close request, returning the quote to OPENED status
	function acceptCancelCloseRequest(uint256 quoteId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		require(quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING, "PartyBFacet: Invalid state");
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.OPENED;
		quote.requestedClosePrice = 0;
		quote.quantityToClose = 0;
	}

	/// @notice Fills a close request up to the maximum amount that keeps PartyA at the edge of liquidation.
	/// @dev IMPORTANT BACKWARD-COMPATIBILITY WARNING:
	///      This legacy method reserves room for protocol closeFee only. It does NOT reserve room for solver fees
	///      charged through LibSolverFee, so a solver fee charged after this call can still make PartyA liquidatable.
	///      Use the fee-aware PartyBSolverFeeActionsFacet.fillCloseRequestToLiquidation overload when the close will include solver fees.
	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig
	) internal returns (uint256 filledAmount) {
		// Validate the request and calculate the max close amount that keeps PartyA at liquidation threshold
		(filledAmount, ) = LibPartyBPositionsActions.calculateCloseToLiquidationAmount(
			quoteId,
			type(uint256).max,
			closedPrice,
			upnlSig.price,
			upnlSig.upnlPartyA,
			0
		);

		_fillCloseRequest(quoteId, filledAmount, closedPrice, upnlSig);

		return filledAmount;
	}

	function _fillCloseRequest(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, PairUpnlAndPriceSig memory upnlSig) private {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		TradingModeStorage.Layout storage tradingModeLayout = TradingModeStorage.layout();
		address signer = LibSigner.getSigner();
		if (tradingModeLayout.bindState[quote.partyA].partyB != signer || !tradingModeLayout.isPartyBBindable[signer]) {
			LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId, MuonFunction.Trading);

			uint256[] memory quoteIds = new uint256[](1);
			uint256[] memory filledAmounts = new uint256[](1);
			uint256[] memory closedPrices = new uint256[](1);
			uint256[] memory marketPrices = new uint256[](1);
			quoteIds[0] = quoteId;
			filledAmounts[0] = filledAmount;
			closedPrices[0] = closedPrice;
			marketPrices[0] = upnlSig.price;

			LibSolvency.requireSolventAfterClosePosition(
				quoteIds,
				filledAmounts,
				closedPrices,
				marketPrices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				quote.partyB,
				quote.partyA
			);
		}

		LibAccount.increaseBothUpnlCounters(quote.partyB, quote.partyA);
		LibPartyBPositionsActions.fillCloseRequest(quoteId, filledAmount, closedPrice);
	}
}
