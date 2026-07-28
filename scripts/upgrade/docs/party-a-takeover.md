# PartyA ClearingHouse takeover runner

`scripts/upgrade/runPartyATakeover.ts` initiates, completes, or resumes a PartyA ClearingHouse
takeover. `TAKEOVER_STEP=all` calls `takeoverPartyALiquidation(partyA)` automatically when the PartyA
is liquidated but the takeover has not started.

The runner is intentionally limited to a single configured PartyB. It refuses:

- non-`OVERDUE` liquidations that still have open or pending positions;
- open positions belonging to a different PartyB;
- settlement states in which the configured PartyB owes PartyA after CVA;
- settlement states that cannot be explained by the configured PartyB;
- live execution by a signer without `CLEARING_HOUSE_ROLE`.

`NORMAL` and `LATE` liquidations are supported after their open and pending positions have already
been processed. In that stage, the runner derives PartyB's remaining recovery from the existing
settlement state:

```text
PartyB recovery = settlement CVA - settlement actualAmount
```

This includes both CVA returned to PartyB and a negative PartyA PnL amount.

## Minimum safe config

The network-specific config is:

```text
scripts/upgrade/config/partyATakeover-<network>.json
```

Example:

```json
{
	"chainId": 999,
	"diamondAddress": "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB",
	"partyA": "0x518fCA8AAB001c4f3A14c388ba4f821D46d6BF41",
	"partyB": "0xf62a670cda28FfAE65eE2a42D6cf6CF05EC5E775"
}
```

The script derives all other inputs:

- active quote IDs and the remaining quantities;
- the Muon-signed prices frozen by the original liquidation;
- accrued funding debt;
- PartyA price PnL and the net PartyB claim;
- PartyA allocation and reimbursement amounts;
- the takeover pool distribution amount;
- the PartyB settlement cleanup list.

No private key, price, quote ID, or transfer amount belongs in the config. Current market prices are
not used because `LATE` and `OVERDUE` positions must retain the original liquidation accounting.

Override the config path with `PARTY_A_TAKEOVER_CONFIG_FILE`.

## Read-only inspection

Inspection is the default and does not require the keystore:

```bash
USE_KEYSTORE=false \
TAKEOVER_STEP=inspect \
npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
```

It prints the current takeover state, reads the original liquidation prices from contract storage,
reads accrued funding debt, and calculates the PartyB claim.

## Authenticated dry run

Dry run is the default. Using the keystore lets the runner verify the role and static-call the
currently selected transaction without broadcasting it:

```bash
USE_KEYSTORE=true \
KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER \
TAKEOVER_STEP=positions \
npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
```

For `TAKEOVER_STEP=all`, when takeover has not started, a live-RPC dry run static-calls the takeover
transaction and prints the derived recovery target. Later calls depend on the takeover state change,
which a read-only RPC cannot persist. Use the fork rehearsal for a stateful proof of every step.

## Execute one step

Set `DRY_RUN=false` only after the authenticated dry run succeeds:

```bash
USE_KEYSTORE=true \
KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER \
DRY_RUN=false \
TAKEOVER_STEP=positions \
npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
```

Supported steps:

| Step         | Action                                                                        |
| ------------ | ----------------------------------------------------------------------------- |
| `inspect`    | Read state, recover frozen liquidation prices, and calculate accounting       |
| `takeover`   | Initiate takeover when PartyA is liquidated and no takeover is active          |
| `pending`    | Call `liquidatePendingPositionsForClearingHouse(partyA, [])` when needed      |
| `positions`  | Close every open position at its frozen liquidation price in bounded batches  |
| `deallocate` | Pull only the outstanding PartyB recovery from PartyA allocation/reimbursement |
| `distribute` | Credit PartyB's confirmed recovery and return any excess pool to PartyA        |
| `settle`     | Derive the settlement cleanup list and call `settlePartyATakeover`            |
| `all`        | Run `takeover` through `settle` in order, skipping completed stages           |

The default position batch size is one quote to remain comfortably below HyperEVM's fast-block gas
limit. Override it with `POSITION_BATCH_SIZE` only after reviewing the printed gas estimates.

## Execute the complete flow

```bash
USE_KEYSTORE=true \
KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER \
DRY_RUN=false \
TAKEOVER_STEP=all \
npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
```

Every step is resumable:

- an already-active takeover is reused;
- already-empty pending/open-position sets are skipped;
- only the outstanding confirmed PartyB recovery is deallocated;
- an empty takeover pool is skipped;
- an already-settled takeover is reported as complete.

Each submitted transaction is static-called first, gas-estimated, awaited, and checked against its
expected post-state.

## Accounting journal

After each confirmed position-close or recovery-distribution transaction, the runner writes its
accounting inputs and receipt to:

```text
scripts/upgrade/output/party-a-takeover-<chainId>-<partyA>.json
```

For positions closed by the runner, this ignored local file records the quote, symbol, frozen price
source and timestamp, price PnL, funding debt, and net PartyA PnL. For a liquidation that reached the
settlement stage before takeover, the on-chain pending settlement is the accounting source instead.
Confirmed distributions are journaled so rerunning later stages does not deallocate the same recovery
twice.

Override the path with `PARTY_A_TAKEOVER_JOURNAL_FILE`, for example when rehearsing on a fork.

## Frozen liquidation prices

The ClearingHouse close function accepts raw `prices[]` without verifying a new Muon signature. The
runner does not interpret that as permission to reprice an already-liquidated position. It recovers
the values committed during the original liquidation:

- legacy liquidation: `AccountStorage.symbolsPrices[partyA][symbolId]`;
- snapshot liquidation: the signed PartyB-symbol snapshot for the liquidation ID.

The storage locations are derived from the append-only `AccountStorage.Layout` used by this contract
version. The runner fails closed when a legacy price timestamp does not equal the active liquidation
timestamp, when a signed snapshot is missing, or when any stored price is zero.

## HyperEVM big-block mode

The runner queries `eth_usingBigBlocks` for the signer. Normal takeover transactions should use fast
blocks. Live execution stops when big-block mode is enabled unless `ALLOW_BIG_BLOCKS=true` is supplied
after explicit review.

Disable big blocks with:

```bash
USE_KEYSTORE=true \
KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER \
npx hardhat hyperevm:disable-big-blocks --network hyperevm
```

When fast-block mode is active, the runner refuses any transaction whose estimate exceeds its
`1,900,000` gas safety threshold.

## Fork-only rehearsal

Account impersonation is available only when the selected Hardhat network name starts with `fork-`.
Always direct the rehearsal journal to a temporary path:

```bash
FORK_BLOCK_NUMBER=<block> \
PARTY_A_TAKEOVER_CONFIG_FILE=./scripts/upgrade/config/partyATakeover-hyperevm.json \
PARTY_A_TAKEOVER_JOURNAL_FILE=/tmp/party-a-takeover-fork.json \
FORK_IMPERSONATE_CLEARING_HOUSE=<clearing-house-address> \
DRY_RUN=false \
TAKEOVER_STEP=all \
npx hardhat run scripts/upgrade/runPartyATakeover.ts --network fork-hyperevm
```

The runner rejects `FORK_IMPERSONATE_CLEARING_HOUSE` on non-fork network names.
