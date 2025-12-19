Master Account Migration

Overview
- Adds a dedicated migration flow for PartyB accounts moving from normal mode to master account mode.
- Migration aggregates allocated, locked, and pending locked balances into the master bucket.
- Migration is one-time per PartyB; once completed, it cannot be restarted.

Flow
1) beginMasterAccountMigration(partyB, initializeMasterBalances)
   - Requires MIGRATION_ROLE and master account feature enabled.
   - Sets migration paused flag for PartyB to block PartyB actions.
   - Optionally resets master bucket balances to zero for a clean aggregation.
   - Emits BeginMasterAccountMigration with a migrationId.

2) migrateMasterAccountQuotes(partyB, partyAs)
   - Accepts batches of Party A addresses supplied offchain.
   - Aggregates balances for each unique PartyA in the provided list.
   - Uses migrationId + partyBMigrationProcessedPartyA to ensure each PartyA is aggregated only once.
   - Emits MigrateMasterAccountQuotes with counts.

3) finalizeMasterAccountMigration(partyB)
   - Sets masterAccountMode true and marks migration complete.
   - Unpauses PartyB migration gate.
   - Emits FinalizeMasterAccountMigration.

Notes
- Master account operations require migration completion.
- PartyB actions are blocked during migration via a migration pause check.
- The migrationId is incremented per migration attempt and is used to de-duplicate PartyA processing.

Interfaces
- IMasterAccountMigrationFacet
- IMasterAccountMigrationEvents

Implementation
- MasterAccountMigrationFacet
- MasterAccountMigrationFacetImpl
