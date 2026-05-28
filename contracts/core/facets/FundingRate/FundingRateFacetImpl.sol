// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonFundingRate } from "../../libraries/muon/LibMuonFundingRate.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibQuoteState } from "../../libraries/extensions/LibQuoteState.sol";
import { LibQuoteFunding } from "../../libraries/LibQuoteFunding.sol";
import { LibFundingRate } from "../../libraries/LibFundingRate.sol";
import { LibPartyBState } from "../../libraries/extensions/LibPartyBState.sol";
import { QuoteStorage, Quote } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import { FundingStorage, FundingFee } from "../../storages/FundingStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { PairUpnlSig } from "../../storages/MuonStorage.sol";
import { PositionType } from "../../storages/QuoteStorage.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

/// @title FundingRateFacetImpl
/// @notice Implements funding rate mechanisms for perpetual futures trading
/// @dev Two funding systems are supported:
///      1. Direct funding rate: Immediate price adjustment based on funding rate
///      2. Accumulated funding: Tracks funding over epochs and applies in bulk
library FundingRateFacetImpl {
	using LibPartyBState for address;
	using LibQuoteState for Quote;

	/// @notice Applies direct funding rate to open positions
	/// @dev This adjusts the open price of positions based on the funding rate.
	///      A positive rate on a LONG position increases openedPrice (hurts PartyA),
	///      while a negative rate on a LONG decreases openedPrice (benefits PartyA).
	/// @param partyA The trader's address
	/// @param quoteIds Array of position IDs to apply funding to
	/// @param rates Array of funding rates (in 1e18 precision, can be negative)
	/// @param upnlSig Signature containing unrealized PnL for solvency checks
	function chargeFundingRate(address partyA, uint256[] memory quoteIds, int256[] memory rates, PairUpnlSig memory upnlSig) internal {
		require(!FundingStorage.layout().legacyFundingDeprecated, "FundingRateFacet: Old Funding Fee Deprecated");

		// Verify the signature contains valid unrealized PnL data
		address signer = LibSigner.getSigner();
		signer.requireNotLiquidating(partyA);
		require(quoteIds.length == rates.length && quoteIds.length > 0, "ChargeFundingFacet: Length not match");

		int256 partyBAvailableBalance = LibAccount.partyBAvailableBalanceForLiquidation(upnlSig.upnlPartyB, signer, partyA);
		int256 partyAAvailableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			upnlSig.upnlPartyA,
			AccountStorage.layout().allocatedBalances[partyA],
			partyA
		);

		uint256 epochDuration;
		uint256 windowTime;

		// Process each position
		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = QuoteStorage.layout().quotes[quoteIds[i]];
			uint256 oldOpenedPrice = quote.openedPrice;

			// Validate quote ownership and status
			require(quote.partyA == partyA, "ChargeFundingFacet: Invalid quote");
			require(quote.partyB == signer, "ChargeFundingFacet: Sender isn't partyB of quote");
			quote.requireOpenPosition();

			// Ensure we're not mixing funding systems
			require(
				FundingStorage.layout().fundingFees[quote.symbolId][quote.partyB].epochDuration == 0,
				"ChargeFundingFacet: Use accumulated funding fee"
			);

			// Get symbol-specific funding parameters
			epochDuration = SymbolStorage.layout().symbols[quote.symbolId].fundingRateEpochDuration;
			require(epochDuration > 0, "ChargeFundingFacet: Zero funding epoch duration");
			windowTime = SymbolStorage.layout().symbols[quote.symbolId].fundingRateWindowTime;

			// Calculate which epoch we're paying for
			uint256 latestEpochTimestamp = (block.timestamp / epochDuration) * epochDuration; //! 1000
			uint256 paidTimestamp;

			// Check if we're within the current epoch's payment window
			if (block.timestamp <= latestEpochTimestamp + windowTime) {
				// Pay for the current epoch
				require(latestEpochTimestamp > quote.lastFundingPaymentTimestamp, "ChargeFundingFacet: Funding already paid for this window");
				paidTimestamp = latestEpochTimestamp;
			} else {
				// We're in the early payment window before the next epoch
				uint256 nextEpochTimestamp = latestEpochTimestamp + epochDuration;
				require(block.timestamp >= nextEpochTimestamp - windowTime, "ChargeFundingFacet: Current timestamp is out of window");
				require(nextEpochTimestamp > quote.lastFundingPaymentTimestamp, "ChargeFundingFacet: Funding already paid for this window");
				paidTimestamp = nextEpochTimestamp;
			}

			// Apply funding rate to position
			if (rates[i] >= 0) {
				// Positive funding: PartyA available balance decreases, PartyB increases
				uint256 priceAdjustment = (quote.openedPrice * uint256(rates[i])) / 1e18;

				if (quote.positionType == PositionType.LONG) {
					// Long positions: increase open price (negative PnL effect)
					quote.openedPrice += priceAdjustment;
				} else {
					// Short positions: decrease open price (positive PnL effect)
					quote.openedPrice -= priceAdjustment;
				}

				// Transfer funding from PartyA to PartyB
				partyAAvailableBalance -= int256((LibQuote.quoteOpenAmount(quote) * priceAdjustment) / 1e18);
				partyBAvailableBalance += int256((LibQuote.quoteOpenAmount(quote) * priceAdjustment) / 1e18);
			} else {
				// Negative funding: PartyA available balance increases, PartyB decreases
				uint256 priceAdjustment = (quote.openedPrice * uint256(-rates[i])) / 1e18;

				if (quote.positionType == PositionType.LONG) {
					// Long positions: decrease open price (positive PnL effect)
					quote.openedPrice -= priceAdjustment;
				} else {
					// Short positions: increase open price (negative PnL effect)
					quote.openedPrice += priceAdjustment;
				}

				// Transfer funding from PartyB to PartyA
				partyAAvailableBalance += int256((LibQuote.quoteOpenAmount(quote) * priceAdjustment) / 1e18);
				partyBAvailableBalance -= int256((LibQuote.quoteOpenAmount(quote) * priceAdjustment) / 1e18);
			}
			// Update open position notionals for both PartiesAggregatedPositions
			LibQuote.updatePartiesAggregatedPositionsNotional(quote, oldOpenedPrice);

			// Mark this epoch as paid
			quote.lastFundingPaymentTimestamp = paidTimestamp;
		}

		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();
		if (tradingLayout.bindState[partyA].partyB != signer || !tradingLayout.isPartyBBindable[signer]) {
			LibMuonFundingRate.verifyPairUpnl(upnlSig, signer, partyA, MuonFunction.Funding);
			// Ensure neither party becomes insolvent after funding payments
			require(partyAAvailableBalance >= 0, "ChargeFundingFacet: PartyA will be insolvent");
			require(partyBAvailableBalance >= 0, "ChargeFundingFacet: PartyB will be insolvent");
		}

		// Increment nonces for replay protection
		LibAccount.increaseBothNonces(signer, partyA);
	}

	/// @notice Updates the epoch duration for accumulated funding calculation
	/// @dev Recalculates weighted averages to maintain consistency when changing epoch duration
	/// @param symbolIds Array of symbol IDs to update
	/// @param durations New epoch durations for each symbol (in seconds)
	/// @param partyB Market maker address
	function setEpochDuration(uint256[] memory symbolIds, uint256[] memory durations, address partyB) internal {
		require(FundingStorage.layout().accumulatedFundingActivated, "FundingRateFacet: New System Not Enabled");
		require(symbolIds.length == durations.length, "FundingRateFacet: Invalid length");

		for (uint256 i = 0; i < symbolIds.length; i++) {
			FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolIds[i]][partyB];
			uint256 timestampForEpoch = 0;

			if (fundingFee.epochDuration != 0) {
				// Update weighted averages before changing epoch duration
				LibFundingRate.updateAccumulatedRates(fundingFee);

				// Snapshot the exact cumulative fee — no re-division of old timestamps
				uint256 oldEpochCount = fundingFee.lastUpdatedEpoch - fundingFee.startEpoch;
				fundingFee.snapshotLongFee += fundingFee.accumulatedLongRate * int256(oldEpochCount);
				fundingFee.snapshotShortFee += fundingFee.accumulatedShortRate * int256(oldEpochCount);

				// Scale only currentRate for the new epoch length
				uint256 durationRatio = ((durations[i] * 1e18) / fundingFee.epochDuration);
				fundingFee.currentLongRate = (fundingFee.currentLongRate * int256(durationRatio)) / 1e18;
				fundingFee.currentShortRate = (fundingFee.currentShortRate * int256(durationRatio)) / 1e18;

				// Reset accumulated to current (fresh weighted average from this point)
				fundingFee.accumulatedLongRate = fundingFee.currentLongRate;
				fundingFee.accumulatedShortRate = fundingFee.currentShortRate;

				// Reset epoch tracking to start fresh from now
				fundingFee.startEpochTimeStamp = fundingFee.lastUpdatedTimeStamp;
				fundingFee.startEpoch = LibFundingRate.getEpochOfTimestamp(fundingFee.lastUpdatedTimeStamp, durations[i]);

				timestampForEpoch = fundingFee.lastUpdatedTimeStamp;
			} else {
				timestampForEpoch = block.timestamp;
				fundingFee.lastUpdatedTimeStamp = block.timestamp;
			}

			// Update epoch duration
			fundingFee.lastUpdatedEpoch = LibFundingRate.getEpochOfTimestamp(timestampForEpoch, durations[i]);
			fundingFee.epochDuration = durations[i];
		}
	}

	/// @notice Updates accumulated funding fees for symbols
	/// @dev Maintains a weighted average of funding rates across all epochs
	/// @param symbolIds Array of symbol IDs
	/// @param longRates New funding rates for long positions in 18 decimals
	/// @param shortRates New funding rates for short positions in 18 decimals
	/// @param marketPrices Current market prices to convert rates to price-adjusted values
	function updateAccumulatedFundingFee(
		uint256[] memory symbolIds,
		int256[] memory longRates,
		int256[] memory shortRates,
		int256[] memory marketPrices
	) internal {
		require(
			symbolIds.length == longRates.length && longRates.length == shortRates.length && symbolIds.length == marketPrices.length,
			"FundingRateFacet: Invalid length"
		);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolIds[i]][LibSigner.getSigner()];

			require(fundingFee.epochDuration > 0, "FundingRateFacet: Epoch duration not set");
			LibFundingRate.updateAccumulatedRates(fundingFee);

			// Convert funding rates to price-adjusted values and store
			fundingFee.currentLongRate = (longRates[i] * marketPrices[i]) / 1e18;
			fundingFee.currentShortRate = (shortRates[i] * marketPrices[i]) / 1e18;

			if (fundingFee.startEpoch == 0) {
				fundingFee.startEpoch = LibFundingRate.getEpochOfTimestamp(block.timestamp, fundingFee.epochDuration);
				fundingFee.startEpochTimeStamp = block.timestamp;
			}
		}
	}

	/// @notice Sets funding fees for both long and short positions
	function setFundingFee(uint256[] memory symbolIds, int256[] memory longRates, int256[] memory shortRates, int256[] memory marketPrices) internal {
		require(FundingStorage.layout().accumulatedFundingActivated, "FundingRateFacet: New System Not Enabled");
		updateAccumulatedFundingFee(symbolIds, longRates, shortRates, marketPrices);
	}

	/// @notice Updates only long position funding fees
	/// @dev Preserves existing short fees while updating long fees
	function setLongFundingFee(uint256[] memory symbolIds, int256[] memory longRates, int256[] memory marketPrices) internal {
		require(FundingStorage.layout().accumulatedFundingActivated, "FundingRateFacet: New System Not Enabled");
		require(symbolIds.length == longRates.length && symbolIds.length == marketPrices.length, "FundingRateFacet: Invalid length");

		int256[] memory shortRates = new int256[](longRates.length);

		// Preserve existing short rates
		for (uint256 i = 0; i < symbolIds.length; i++) {
			FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolIds[i]][LibSigner.getSigner()];
			require(marketPrices[i] > 0, "FundingRateFacet: Invalid market price");
			// Convert back from price-adjusted to rate
			if (marketPrices[i] > 0) {
				shortRates[i] = (fundingFee.currentShortRate * 1e18) / marketPrices[i];
			}
		}
		updateAccumulatedFundingFee(symbolIds, longRates, shortRates, marketPrices);
	}

	/// @notice Updates only short position funding fees
	/// @dev Preserves existing long fees while updating short fees
	function setShortFundingFee(uint256[] memory symbolIds, int256[] memory shortRates, int256[] memory marketPrices) internal {
		require(symbolIds.length == shortRates.length && symbolIds.length == marketPrices.length, "FundingRateFacet: Invalid length");
		require(FundingStorage.layout().accumulatedFundingActivated, "FundingRateFacet: New System Not Enabled");
		int256[] memory longRates = new int256[](shortRates.length);

		// Preserve existing long rates
		for (uint256 i = 0; i < symbolIds.length; i++) {
			FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolIds[i]][LibSigner.getSigner()];
			require(marketPrices[i] > 0, "FundingRateFacet: Invalid market price");
			// Convert back from price-adjusted to rate
			if (marketPrices[i] > 0) {
				longRates[i] = (fundingFee.currentLongRate * 1e18) / marketPrices[i];
			}
		}
		updateAccumulatedFundingFee(symbolIds, longRates, shortRates, marketPrices);
	}

	/// @notice Applies accumulated funding fees to positions
	/// @dev Uses the accumulated funding fee system with weighted averages
	/// @param partyA Trader address
	/// @param partyB Market maker address
	/// @param quoteIds Position IDs to charge
	/// @param upnlSig Unrealized PnL signature for solvency checks
	function chargeAccumulatedFundingFee(address partyA, address partyB, uint256[] memory quoteIds, PairUpnlSig memory upnlSig) internal {
		require(FundingStorage.layout().accumulatedFundingActivated, "FundingRateFacet: New System Not Enabled");
		LibMuonFundingRate.verifyPairUpnl(upnlSig, partyB, partyA, MuonFunction.Funding);

		// Apply accumulated funding to each position
		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = QuoteStorage.layout().quotes[quoteIds[i]];
			require(quote.partyA == partyA, "FundingRateFacet: Invalid quote");
			require(quote.partyB == partyB, "FundingRateFacet: Sender isn't partyB of quote");
			quote.requireOpenPosition();

			// Delegate to library function that handles the actual fee calculation
			LibQuoteFunding.chargeAccumulatedFundingFee(quoteIds[i]);
		}

		// Verify solvency after all funding fees are applied
		int256 partyBAvailableBalance = LibAccount.partyBAvailableBalanceForLiquidation(upnlSig.upnlPartyB, partyB, partyA);
		int256 partyAAvailableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			upnlSig.upnlPartyA,
			AccountStorage.layout().allocatedBalances[partyA],
			partyA
		);

		require(partyAAvailableBalance >= 0, "FundingRateFacet: PartyA will be insolvent");
		require(partyBAvailableBalance >= 0, "FundingRateFacet: PartyB will be insolvent");
	}
}
