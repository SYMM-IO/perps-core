# Ordered symbol synchronization

These scripts copy a complete ordered symbol catalog between compatible Core Diamonds through the target `SymmioSymbolManager`.
They are intended for exact ID parity, not name-based deduplication.

The checked-in configurations target:

- `hyperevm-to-arbitrum.json`: HyperEVM v0.8.6 Core `0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB` to Arbitrum
  v0.8.6 Core `0x573310dB6d160B26026B8706EBe9831c7dEF1D09` through Symbol Manager
  `0x902a529f5f1E9BCEBe7BC6e785A70aC2Db07Ad2c`.
- `hyperevm-v0.8.5-to-arbitrum-v0.8.6.json`: HyperEVM v0.8.5 Core `0x57331038c21982116EE9b0906E4a5c5cB52dcE2e`
  to Arbitrum v0.8.6 Core `0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A` through Symbol Manager
  `0x3FB153ee0a18B2726a54E132C173AC73D8c05e20`.

Both flows use HyperEVM chain `999` and Arbitrum One chain `42161`. Select the configuration matching the Core version; their snapshots and
assignment reports use separate output paths.

RPC URLs and signer secrets do not belong in the JSON inputs. The scripts use the named Hardhat networks, so configure `RPC_HYPEREVM`,
`RPC_ARBITRUM`, and the signer through the existing environment or encrypted Hardhat keystore flow.

## Safety model

Core does not accept a requested symbol ID. `addSymbolsWithType` always assigns `lastId + 1`, and it always creates the symbol as valid even
when the input struct says otherwise. Exact parity is therefore possible only when the target catalog is an exact prefix of the source catalog.
The fetch script proves that condition before producing an actionable snapshot. The assignment script rechecks it before every window.

For source-invalid entries, the assignment script adds the ordered ID and then calls `deactivateSymbols`. An EOA executes those as two
transactions, so there is a short interval in which the newly added entries are valid. The report preserves both actions and will prioritize
the missing deactivation on resume if the process stops between them. Operators who require atomic add-and-deactivate semantics must execute
the generated actions as one reviewed Safe multisend from a Safe that already holds both manager roles.

The target manager's live daily limits remain authoritative. The checked-in config uses `batchSize: "all"`, which consumes all currently
available addition capacity while reserving validation capacity for source-invalid symbols. If either live limit is smaller than the missing
catalog, the script stops at that limit and resumes safely on the next run. A stale on-chain counter is treated as zero only after
`lastResetTimestamp + 24 hours`, matching the manager's next mutating call.

## 1. Fetch and compare

```bash
SYMBOL_SYNC_CONFIG=scripts/symbols/config/hyperevm-to-arbitrum.json \
  ./node_modules/.bin/hardhat run --no-compile scripts/symbols/fetchSymbols.ts --network arbitrum
```

The generated snapshot contains:

- pinned source and target blocks;
- every source symbol and its ID, validation state, type, fee, leverage, minimums, and funding timing;
- the target prefix comparison and any blocking conflict;
- Symbol Manager wiring, pause state, daily counters, Core role, and enumerable operator role holders;
- a SHA-256 digest binding all assignment inputs.

The default output is `scripts/output/symbol-sync/hyperevm-to-arbitrum.snapshot.json`.

## 2. Build a transaction plan

```bash
SYMBOL_SYNC_INPUT=scripts/output/symbol-sync/hyperevm-to-arbitrum.snapshot.json \
SYMBOL_SYNC_AUTHORITY=0xYourOperatorAddress \
  ./node_modules/.bin/hardhat run --no-compile scripts/symbols/assignSymbols.ts --network arbitrum
```

Plan mode never broadcasts. It reads live target state, verifies the snapshot digest and manager wiring, checks the supplied authority's roles,
calculates the current daily window, simulates actions that already exist in current state with `eth_call`, and writes exact calldata to the
assignment report. A deactivation that depends on IDs created by the preceding addition is marked `deferred` until that addition confirms.

The default report is `scripts/output/symbol-sync/hyperevm-to-arbitrum.assignment.json`.

## 3. Execute and resume

Use the existing signer configuration. For example, with a key stored in the Hardhat keystore:

```bash
USE_KEYSTORE=true \
KEYSTORE_DEPLOYER_KEY=SYMBOL_OPERATOR \
KEYSTORE_ACCOUNTS=SYMBOL_OPERATOR \
SYMBOL_SYNC_INPUT=scripts/output/symbol-sync/hyperevm-to-arbitrum.snapshot.json \
EXECUTE=true \
CONFIRM_CHAIN_ID=42161 \
  ./node_modules/.bin/hardhat run --no-compile scripts/symbols/assignSymbols.ts --network arbitrum
```

Rerun the same command and report path after a daily reset. Each run:

1. reconciles every write-ahead transaction hash already in the report;
2. refuses to rebroadcast an action whose transaction outcome is unresolved;
3. recomputes target state rather than trusting prior progress;
4. submits at most the current addition/validation capacity;
5. writes the hash before waiting for the receipt;
6. verifies the target catalog again and records `complete`, `ready`, or `waiting-daily-limit`.

Do not edit a snapshot after fetching it. Its digest is the assignment intent; fetch a new snapshot and start a new report when the desired
HyperEVM catalog changes.

## SYMMIO operator menu

The same flow is exposed through `./symmio` under **Other maintenance scripts**:

1. **Fetch ordered symbol synchronization snapshot**
2. **Apply ordered symbol synchronization**

The operator task owns the input selection, signer, typed chain confirmation, transaction journal, pause/resume state, and final post-state
verification. It currently exposes the EOA modes that match the deployed manager's operator-role model. A Safe must first hold both
`SYMBOL_ADDER_ROLE` and `SYMBOL_REMOVER_ROLE`, after which the report actions can be moved into a separately reviewed atomic Safe multisend.
Direct scripts remain available as auditable low-level adapters.
