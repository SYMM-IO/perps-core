// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LockedValuesOps, LockedValues } from "../../libraries/LibLockedValues.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibAggregateFunding } from "../../libraries/LibAggregateFunding.sol";
import { LibFundingRate } from "../../libraries/LibFundingRate.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, PositionType } from "../../storages/QuoteStorage.sol";
import { FundingStorage, FundingFee } from "../../storages/FundingStorage.sol";
import { MigrationStorage } from "../../storages/MigrationStorage.sol";

library MigrationFacetImpl {
	using LockedValuesOps for LockedValues;

	/// @notice Backfills v0.8.5 quote-derived state for existing quotes
	/// @dev This function is idempotent - calling it multiple times with the same quote IDs will not cause issues.
	///      For PENDING/LOCKED/CANCEL_PENDING quotes, it backfills:
	///      - partyAReservedOpenFees (prevents balanceLimitPerUser bypass via fee refund)
	///      For OPENED/CLOSE_PENDING/CANCEL_CLOSE_PENDING quotes, it backfills:
	///      - aggregated positions/funding + active symbols (used by new UPNL/funding flows)
	///      - quote.accumulatedPaidFunding baseline (when accumulated funding is configured)
	///      - partyBPositionsCount[partyB][address(0)] total positions counter
	///      - connectedPartyBs / isConnectedPartyB via LibConnections.addConnection (bounded by maxPartyAConnectionLimit)
	/// @param quoteIds Array of quote IDs to migrate
	/// @return quotesMigrated Number of quotes actually migrated (excluding already migrated or invalid quotes)
	function migrateQuotes(uint256[] calldata quoteIds) internal returns (uint256 quotesMigrated) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MigrationStorage.Layout storage migrationLayout = MigrationStorage.layout();

		for (uint256 i = 0; i < quoteIds.length; i++) {
			uint256 quoteId = quoteIds[i];

			// Skip if already migrated
			if (migrationLayout.quoteMigrated[quoteId]) continue;

			Quote storage quote = quoteLayout.quotes[quoteId];

			// Skip non-existent quotes (default storage has status PENDING but partyA == address(0))
			if (quote.partyA == address(0)) continue;

			if (
				quote.quoteStatus == QuoteStatus.PENDING || quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING
			) {
				// Backfill reserved open fees for pending/locked quotes
				LibAccount.reserveOpenTradingFee(quote.partyA, LibQuote.getOpenTradingFee(quoteId));
				migrationLayout.quoteMigrated[quoteId] = true;
				quotesMigrated++;
				continue;
			}

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
			LibConnections.addConnection(quote.partyA, quote.partyB);

			migrationLayout.quoteMigrated[quoteId] = true;
			quotesMigrated++;
		}
	}

	/// @notice Initializes the accumulatedPaidFunding for a quote if funding is enabled
	/// @dev Sets the initial accumulatedPaidFunding based on current funding rates
	///      This ensures that when funding is later charged, the quote starts from the correct baseline
	/// @param quote The quote to initialize funding for
	function _initializeQuoteFunding(Quote storage quote) internal {
		FundingStorage.Layout storage fundingLayout = FundingStorage.layout();
		FundingFee storage fundingFee = fundingLayout.fundingFees[quote.symbolId][quote.partyB];

		// Skip if no funding fee configured for this symbol/partyB
		if (fundingFee.epochDuration == 0) return;

		// Skip if already initialized (non-zero value)
		if (quote.accumulatedPaidFunding != 0) return;

		// Update accumulated rates to current epoch
		LibFundingRate.updateAccumulatedRatesAndEmit(fundingFee, quote.symbolId, quote.partyB);

		// Calculate the current accumulated fee that would be used for this position type
		int256 rate = quote.positionType == PositionType.LONG ? fundingFee.accumulatedLongRate : fundingFee.accumulatedShortRate;

		// Set the accumulatedPaidFunding to snapshot + current rate * epochs since start
		// This means when funding is charged later, it will be calculated relative to this baseline
		int256 snapshot = quote.positionType == PositionType.LONG ? fundingFee.snapshotLongFee : fundingFee.snapshotShortFee;
		uint256 epochsSinceStart = LibFundingRate.getEpochsSinceStart(fundingFee);
		quote.accumulatedPaidFunding = snapshot + rate * int256(epochsSinceStart);
	}

	/// @notice Migrates partyB locked/pending locked values to the cross bucket (address(0))
	/// @dev This aggregates per-partyA locked and pending locked balances into the cross bucket.
	///      Should be called during the v0.8.4 -> v0.8.5 upgrade while the system is paused.
	///      Allocated balances are NOT aggregated — the cross bucket is an independent pool.
	///      This function is idempotent - already migrated partyA pairs are skipped.
	///      Can be called in multiple batches if the partyAs array is too large for a single transaction.
	/// @param partyB The partyB to migrate
	/// @param partyAs Array of partyA addresses that have balances with this partyB
	/// @return partyAsProcessed Number of partyAs actually processed (excluding already migrated)
	function migrateCrossLockedValues(address partyB, address[] calldata partyAs) internal returns (uint256 partyAsProcessed) {
		MigrationStorage.Layout storage migrationLayout = MigrationStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		for (uint256 i = 0; i < partyAs.length; i++) {
			address partyA = partyAs[i];

			// Skip if already migrated
			if (migrationLayout.crossLockedValuesMigrated[partyB][partyA]) continue;

			// Aggregate locked balances to cross bucket (only for pre-v8.5 data)
			accountLayout.partyBLockedBalances[partyB][address(0)].add(accountLayout.partyBLockedBalances[partyB][partyA]);

			// Aggregate pending locked balances to cross bucket (only for pre-v8.5 data)
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].add(accountLayout.partyBPendingLockedBalances[partyB][partyA]);

			migrationLayout.crossLockedValuesMigrated[partyB][partyA] = true;
			partyAsProcessed++;
		}
	}
}
