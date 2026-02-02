// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LockedValuesOps, LockedValues } from "../../libraries/LibLockedValues.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibAggregateFunding } from "../../libraries/LibAggregateFunding.sol";
import { LibFundingRate } from "../../libraries/LibFundingRate.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, PositionType } from "../../storages/QuoteStorage.sol";
import { FundingStorage, FundingFee } from "../../storages/FundingStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { MigrationStorage } from "../../storages/MigrationStorage.sol";

library MigrationFacetImpl {
	using LockedValuesOps for LockedValues;

	/**
	 * @notice Backfills v0.8.5 quote-derived state for existing active positions
	 * @dev This function is idempotent - calling it multiple times with the same quote IDs will not cause issues.
	 *      For each migrated quote, it backfills:
	 *      - aggregated positions/funding + active symbols (used by new UPNL/funding flows)
	 *      - quote.accumulatedPaidFunding baseline (when accumulated funding is configured)
	 *      - partyBPositionsCount[partyB][address(0)] total positions counter
	 *      - connectedPartyBs / isConnectedPartyB (bounded by maxPartyAConnectionLimit)
	 * @param quoteIds Array of quote IDs to migrate
	 * @return quotesMigrated Number of quotes actually migrated (excluding already migrated or invalid quotes)
	 */
	function migrateQuotes(uint256[] calldata quoteIds) internal returns (uint256 quotesMigrated) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		MigrationStorage.Layout storage migrationLayout = MigrationStorage.layout();

		for (uint256 i = 0; i < quoteIds.length; i++) {
			uint256 quoteId = quoteIds[i];

			// Skip if already migrated
			if (migrationLayout.quoteMigrated[quoteId]) continue;

			Quote storage quote = quoteLayout.quotes[quoteId];

			// Only process active positions (OPENED, CLOSE_PENDING, CANCEL_CLOSE_PENDING)
			if (
				quote.quoteStatus != QuoteStatus.OPENED &&
				quote.quoteStatus != QuoteStatus.CLOSE_PENDING &&
				quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING
			) {
				continue;
			}

			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			if (openAmount == 0) continue;

			// Backfill v0.8.5 derived state for this quote.
			// Initialize accumulatedPaidFunding if funding is enabled.
			_initializeQuoteFunding(quote);

			// Populate aggregated positions (handles active symbols internally)
			LibQuote.addToPartyBAggregatedPositions(quote, openAmount);
			LibQuote.addToPartyAAggregatedPositions(quote, openAmount);

			// Populate aggregate funding
			LibAggregateFunding.addToPartiesAggregateFunding(quote, openAmount);

			// Backfill v0.8.5 derived state not covered by the aggregate libs.
			quoteLayout.partyBPositionsCount[quote.partyB][address(0)] += 1;
			_backfillConnection(accountLayout, maLayout.maxPartyAConnectionLimit, quote.partyA, quote.partyB);

			migrationLayout.quoteMigrated[quoteId] = true;
			quotesMigrated++;
		}
	}

	function _backfillConnection(
		AccountStorage.Layout storage accountLayout,
		uint256 maxPartyAConnectionLimit,
		address partyA,
		address partyB
	) private {
		if (!accountLayout.isConnectedPartyB[partyA][partyB]) {
			require(accountLayout.connectedPartyBs[partyA].length < maxPartyAConnectionLimit, "MigrationFacet: PartyA max connection limit exceeded");
			accountLayout.connectedPartyBs[partyA].push(partyB);
			accountLayout.isConnectedPartyB[partyA][partyB] = true;
		}
	}

	/**
	 * @notice Initializes the accumulatedPaidFunding for a quote if funding is enabled
	 * @dev Sets the initial accumulatedPaidFunding based on current funding rates
	 *      This ensures that when funding is later charged, the quote starts from the correct baseline
	 * @param quote The quote to initialize funding for
	 */
	function _initializeQuoteFunding(Quote storage quote) internal {
		FundingStorage.Layout storage fundingLayout = FundingStorage.layout();
		FundingFee storage fundingFee = fundingLayout.fundingFees[quote.symbolId][quote.partyB];

		// Skip if no funding fee configured for this symbol/partyB
		if (fundingFee.epochDuration == 0) return;

		// Skip if already initialized (non-zero value)
		if (quote.accumulatedPaidFunding != 0) return;

		// Update accumulated rates to current epoch
		LibFundingRate.updateAccumulatedRates(fundingFee);

		// Calculate the current accumulated fee that would be used for this position type
		int256 rate = quote.positionType == PositionType.LONG ? fundingFee.accumulatedLongRate : fundingFee.accumulatedShortRate;

		// Set the accumulatedPaidFunding to current rate * epochs since start
		// This means when funding is charged later, it will be calculated relative to this baseline
		uint256 epochsSinceStart = LibFundingRate.getEpochsSinceStart(fundingFee);
		quote.accumulatedPaidFunding = rate * int256(epochsSinceStart);
	}

	/**
	 * @notice Migrates partyB locked values to the cross bucket (address(0))
	 * @dev This aggregates all per-partyA balances into the cross bucket for cross partyB mode.
	 *      Should be called during the v0.8.4 -> v0.8.5 upgrade while the system is paused.
	 *      This function is idempotent per partyB - calling it twice will revert.
	 * @param partyB The partyB to migrate
	 * @param partyAs Array of partyA addresses that have balances with this partyB
	 * @return partyAsProcessed Number of partyAs actually processed
	 */
	function migrateCrossLockedValues(address partyB, address[] calldata partyAs) internal returns (uint256 partyAsProcessed) {
		MigrationStorage.Layout storage migrationLayout = MigrationStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!migrationLayout.partyBLockedValuesMigrated[partyB], "MigrationFacet: Already migrated");

		for (uint256 i = 0; i < partyAs.length; i++) {
			address partyA = partyAs[i];

			// Aggregate allocated balances to cross bucket
			accountLayout.partyBAllocatedBalances[partyB][address(0)] += accountLayout.partyBAllocatedBalances[partyB][partyA];

			// Aggregate locked balances to cross bucket (only for pre-v8.5 data)
			accountLayout.partyBLockedBalances[partyB][address(0)].add(accountLayout.partyBLockedBalances[partyB][partyA]);

			// Aggregate pending locked balances to cross bucket (only for pre-v8.5 data)
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].add(accountLayout.partyBPendingLockedBalances[partyB][partyA]);

			partyAsProcessed++;
		}

		migrationLayout.partyBLockedValuesMigrated[partyB] = true;
	}
}
