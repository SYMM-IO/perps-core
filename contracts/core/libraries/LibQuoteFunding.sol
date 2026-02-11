// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SharedEvents } from "./SharedEvents.sol";
import { LibFundingRate } from "./LibFundingRate.sol";
import { LibQuote } from "./LibQuote.sol";
import { LibAggregateFunding } from "./LibAggregateFunding.sol";
import { QuoteStorage, Quote, PositionType } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { FundingStorage, FundingFee } from "../storages/FundingStorage.sol";
import { LibAccount } from "./LibAccount.sol";

library LibQuoteFunding {
	/// @notice Calculates the accumulated funding fee for a position
	/// @dev Uses weighted average funding rates over time
	/// @param quoteId The quote ID to calculate funding for
	/// @return fee The net funding fee (positive = trader pays, negative = trader receives)
	function getAccumulatedFundingFee(uint256 quoteId) public view returns (int256 fee) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		FundingFee storage fundingFee = FundingStorage.layout().fundingFees[quote.symbolId][quote.partyB];

		// Early exit conditions:
		// 1. No epoch duration set (accumulated funding not active)
		if (fundingFee.epochDuration == 0) return 0;

		uint256 unpaidEpochs = LibFundingRate.getEpochsSince(fundingFee, quote.lastFundingPaymentTimestamp);

		if (unpaidEpochs == 0) return 0;

		// Calculate epochs in the weighted average
		uint256 epochsSinceLastUpdate = LibFundingRate.getEpochsSinceLastUpdate(fundingFee);
		uint256 epochsBeforeLastUpdate = fundingFee.lastUpdatedEpoch - fundingFee.startEpoch;

		int256 beforeWeightedRate = quote.positionType == PositionType.LONG ? fundingFee.accumulatedLongRate : fundingFee.accumulatedShortRate;
		int256 currentRate = quote.positionType == PositionType.LONG ? fundingFee.currentLongRate : fundingFee.currentShortRate;
		int256 currentFee = (beforeWeightedRate * int256(epochsBeforeLastUpdate)) + (currentRate * int256(epochsSinceLastUpdate));

		// Subtract already paid amount
		fee = (int256(LibQuote.quoteOpenAmount(quote)) * (currentFee - quote.accumulatedPaidFunding)) / 1e18;
	}

	/// @notice Charges accumulated funding fee for a position
	/// @dev Transfers funds between parties based on calculated fee
	/// @param quoteId The position ID to charge funding for
	function chargeAccumulatedFundingFee(uint256 quoteId) public {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		// Load the position
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		// Calculate the unpaid funding fee
		int256 fee = getAccumulatedFundingFee(quoteId);

		// Store old value for aggregate funding update
		int256 oldAccumulatedPaidFunding = quote.accumulatedPaidFunding;
		uint256 openAmount = LibQuote.quoteOpenAmount(quote);

		quote.lastFundingPaymentTimestamp = block.timestamp;
		updateAccumulatedPaidFunding(quoteId);

		// Update aggregate funding tracking for nonce-free Muon verification
		// This must be called after updateAccumulatedPaidFunding updates quote.accumulatedPaidFunding
		LibAggregateFunding.updatePartiesAggregateFunding(quote, oldAccumulatedPaidFunding, openAmount);

		address partyBAllocationKey = LibAccount.partyBAllocationKey(quote.partyB, quote.partyA);
		if (fee > 0) {
			// Positive fee: Trader (PartyA) pays Market Maker (PartyB)
			uint256 feeInUint = uint256(fee);
			accountLayout.allocatedBalances[quote.partyA] -= feeInUint;
			accountLayout.partyBAllocatedBalances[quote.partyB][partyBAllocationKey] += feeInUint;

			emit SharedEvents.BalanceChangePartyA(quote.partyA, feeInUint, SharedEvents.BalanceChangeType.FUNDING_FEE_OUT);
			emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, feeInUint, SharedEvents.BalanceChangeType.FUNDING_FEE_IN);
		} else if (fee < 0) {
			// Negative fee: Market Maker (PartyB) pays Trader (PartyA)
			uint256 feeInUint = uint256(-fee);
			accountLayout.partyBAllocatedBalances[quote.partyB][partyBAllocationKey] -= feeInUint;
			accountLayout.allocatedBalances[quote.partyA] += feeInUint;

			emit SharedEvents.BalanceChangePartyA(quote.partyA, feeInUint, SharedEvents.BalanceChangeType.FUNDING_FEE_IN);
			emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, feeInUint, SharedEvents.BalanceChangeType.FUNDING_FEE_OUT);
		}
	}

	/// @notice Updates the accumulated paid funding for a quote
	/// @param quoteId The quote ID to update the accumulated paid funding for
	function updateAccumulatedPaidFunding(uint256 quoteId) public {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		FundingFee storage fundingFee = FundingStorage.layout().fundingFees[quote.symbolId][quote.partyB];

		if (fundingFee.epochDuration > 0) {
			LibFundingRate.updateAccumulatedRates(fundingFee);
			quote.accumulatedPaidFunding =
				(quote.positionType == PositionType.LONG ? fundingFee.accumulatedLongRate : fundingFee.accumulatedShortRate) *
				int256(LibFundingRate.getEpochsSinceStart(fundingFee));
		}
	}
}
