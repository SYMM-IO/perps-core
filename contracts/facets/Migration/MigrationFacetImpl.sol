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
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, PositionType } from "../../storages/QuoteStorage.sol";
import { SymbolStorage, FundingFee } from "../../storages/SymbolStorage.sol";
import { MigrationStorage } from "../../storages/MigrationStorage.sol";

library MigrationFacetImpl {
	using LockedValuesOps for LockedValues;

	/**
	 * @notice Begins the migration process for a partyB by pausing their actions
	 * @dev This must be called before migrating quotes and locked values
	 * @param partyB The partyB to begin migration for
	 */
	function beginMigration(address partyB) internal {
		MigrationStorage.Layout storage migrationLayout = MigrationStorage.layout();

		require(MAStorage.layout().partyBStatus[partyB], "MigrationFacet: Address is not PartyB");
		require(!migrationLayout.partyBMigrationPaused[partyB], "MigrationFacet: Migration already in progress");

		migrationLayout.partyBMigrationPaused[partyB] = true;
	}

	/**
	 * @notice Finalizes the migration process for a partyB
	 * @dev This enables master account mode and unpauses the partyB
	 *      Should be called after all quotes and locked values have been migrated
	 * @param partyB The partyB to finalize migration for
	 * @param enableMasterMode Whether to enable master account mode after migration
	 */
	function finalizeMigration(address partyB, bool enableMasterMode) internal {
		MigrationStorage.Layout storage migrationLayout = MigrationStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(migrationLayout.partyBMigrationPaused[partyB], "MigrationFacet: Migration not in progress");

		if (enableMasterMode) {
			require(GlobalAppStorage.layout().masterAccountEnabled, "MigrationFacet: Master account feature disabled");
			require(migrationLayout.partyBLockedValuesMigrated[partyB], "MigrationFacet: Locked values not migrated");
			accountLayout.masterAccountMode[partyB] = true;
		}

		migrationLayout.partyBMigrationPaused[partyB] = false;
	}

	/**
	 * @notice Migrates quotes to populate aggregated positions, funding, and active symbols
	 * @dev This function is idempotent - calling it multiple times with the same quote IDs will not cause issues
	 * @param quoteIds Array of quote IDs to migrate
	 * @return quotesMigrated Number of quotes actually migrated (excluding already migrated or invalid quotes)
	 */
	function migrateQuotes(uint256[] calldata quoteIds) internal returns (uint256 quotesMigrated) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
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

			// Initialize accumulatedPaidFunding if funding is enabled
			_initializeQuoteFunding(quote);

			// Populate aggregated positions (handles active symbols internally)
			LibQuote.addToPartyBAggregatedPositions(quote, openAmount);
			LibQuote.addToPartyAAggregatedPositions(quote, openAmount);

			// Populate aggregate funding
			LibAggregateFunding.addToPartiesAggregateFunding(quote, openAmount);

			migrationLayout.quoteMigrated[quoteId] = true;
			quotesMigrated++;
		}
	}

	/**
	 * @notice Initializes the accumulatedPaidFunding for a quote if funding is enabled
	 * @dev Sets the initial accumulatedPaidFunding based on current funding rates
	 *      This ensures that when funding is later charged, the quote starts from the correct baseline
	 * @param quote The quote to initialize funding for
	 */
	function _initializeQuoteFunding(Quote storage quote) internal {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		FundingFee storage fundingFee = symbolLayout.fundingFees[quote.symbolId][quote.partyB];

		// Skip if no funding fee configured for this symbol/partyB
		if (fundingFee.epochDuration == 0) return;

		// Skip if already initialized (non-zero value)
		if (quote.accumulatedPaidFunding != 0) return;

		// Update accumulated rates to current epoch
		LibFundingRate.updateAccumulatedRates(fundingFee);

		// Calculate the current accumulated fee that would be used for this position type
		int256 rate = quote.positionType == PositionType.LONG
			? fundingFee.accumulatedLongRate
			: fundingFee.accumulatedShortRate;

		// Set the accumulatedPaidFunding to current rate * epochs since start
		// This means when funding is charged later, it will be calculated relative to this baseline
		uint256 epochsSinceStart = LibFundingRate.getEpochsSinceStart(fundingFee);
		quote.accumulatedPaidFunding = rate * int256(epochsSinceStart);
	}

	/**
	 * @notice Migrates partyB locked values to the master bucket (address(0))
	 * @dev This aggregates all per-partyA locked values into the master bucket for master account mode.
	 *      IMPORTANT: This function should ONLY be called for quotes created BEFORE v8.5 upgrade.
	 *      For quotes created after v8.5, locked values are already in master bucket and this would double-count.
	 *      Use setPartyBMigrationComplete instead for partyBs with only v8.5 data.
	 * @param partyB The partyB to migrate
	 * @param partyAs Array of partyA addresses that have balances with this partyB
	 * @return partyAsProcessed Number of partyAs actually processed
	 */
	function migrateMasterAccountLockedValues(
		address partyB,
		address[] calldata partyAs
	) internal returns (uint256 partyAsProcessed) {
		MigrationStorage.Layout storage migrationLayout = MigrationStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!migrationLayout.partyBLockedValuesMigrated[partyB], "MigrationFacet: Already migrated");

		for (uint256 i = 0; i < partyAs.length; i++) {
			address partyA = partyAs[i];

			// Aggregate allocated balances to master bucket
			accountLayout.partyBAllocatedBalances[partyB][address(0)] += accountLayout.partyBAllocatedBalances[partyB][partyA];

			// Aggregate locked balances to master bucket (only for pre-v8.5 data)
			accountLayout.partyBLockedBalances[partyB][address(0)].add(accountLayout.partyBLockedBalances[partyB][partyA]);

			// Aggregate pending locked balances to master bucket (only for pre-v8.5 data)
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].add(
				accountLayout.partyBPendingLockedBalances[partyB][partyA]
			);

			partyAsProcessed++;
		}

		migrationLayout.partyBLockedValuesMigrated[partyB] = true;
	}

	/**
	 * @notice Migrates only allocated balances to master bucket (for v8.5 data where locked values are already maintained)
	 * @dev Use this for partyBs whose positions were all created after v8.5, where locked values are already in master bucket
	 * @param partyB The partyB to migrate
	 * @param partyAs Array of partyA addresses that have balances with this partyB
	 * @return partyAsProcessed Number of partyAs actually processed
	 */
	function migrateAllocatedBalances(
		address partyB,
		address[] calldata partyAs
	) internal returns (uint256 partyAsProcessed) {
		MigrationStorage.Layout storage migrationLayout = MigrationStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!migrationLayout.partyBLockedValuesMigrated[partyB], "MigrationFacet: Already migrated");

		for (uint256 i = 0; i < partyAs.length; i++) {
			address partyA = partyAs[i];

			// Only aggregate allocated balances to master bucket
			// Locked/pending are already in master bucket for v8.5 data
			accountLayout.partyBAllocatedBalances[partyB][address(0)] += accountLayout.partyBAllocatedBalances[partyB][partyA];

			partyAsProcessed++;
		}

		migrationLayout.partyBLockedValuesMigrated[partyB] = true;
	}
}
