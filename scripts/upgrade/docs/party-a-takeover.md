# PartyA ClearingHouse takeover runner

`scripts/upgrade/runPartyATakeover.ts` completes or resumes an `OVERDUE` PartyA liquidation after
`takeoverPartyALiquidation(partyA)` has already been called.

The runner is intentionally limited to a single configured PartyB. It refuses:

- non-`OVERDUE` liquidations;
- open positions belonging to a different PartyB;
- distributions without a confirmed close-accounting journal;
- settlement states that cannot be explained by the configured PartyB;
- live execution by a signer without `CLEARING_HOUSE_ROLE`.

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
- current Muon prices and symbols;
- accrued funding debt;
- PartyA price PnL and the net PartyB claim;
- PartyA allocation and reimbursement amounts;
- the takeover pool distribution amount;
- the PartyB settlement cleanup list.

No private key, price, quote ID, or transfer amount belongs in the config.

Override the config path with `PARTY_A_TAKEOVER_CONFIG_FILE`.

## Read-only inspection

Inspection is the default and does not require the keystore:

```bash
USE_KEYSTORE=false \
TAKEOVER_STEP=inspect \
npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
```

It prints the current takeover state, obtains fresh prices from the SYMMIO Muon oracle, reads funding
debt, and calculates the current PartyB claim.

## Authenticated dry run

Dry run is the default. Using the keystore lets the runner verify the role and static-call the
currently selected transaction without broadcasting it:

```bash
USE_KEYSTORE=true \
KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER \
TAKEOVER_STEP=positions \
npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
```

For `TAKEOVER_STEP=all`, a live-RPC dry run can only static-call the pending and position-close calls.
Later calls depend on state changes that a read-only RPC cannot persist.

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
| `inspect`    | Read state, fetch Muon prices, and calculate accounting                       |
| `pending`    | Call `liquidatePendingPositionsForClearingHouse(partyA, [])` when needed      |
| `positions`  | Fetch fresh prices and close every open position in bounded batches           |
| `deallocate` | Pull PartyA allocation and reimbursement into the takeover pool               |
| `distribute` | Credit the complete recovery pool to PartyB's isolated PartyA bucket          |
| `settle`     | Derive the settlement cleanup list and call `settlePartyATakeover`            |
| `all`        | Run `pending`, `positions`, `deallocate`, `distribute`, and `settle` in order |

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

- already-empty pending/open-position sets are skipped;
- empty PartyA allocation/reimbursement is skipped;
- an empty takeover pool is skipped;
- an already-settled takeover is reported as complete.

Each submitted transaction is static-called first, gas-estimated, awaited, and checked against its
expected post-state.

## Accounting journal

After each confirmed position-close transaction, the runner writes the quote price, price PnL,
funding debt, net PartyA PnL, Muon block/timestamp, and receipt to:

```text
scripts/upgrade/output/party-a-takeover-<chainId>-<partyA>.json
```

This ignored local file is the proof used by a later `distribute` invocation. Distribution is refused
when no confirmed journal exists or when the confirmed PartyB claim is smaller than the recovery pool.

Override the path with `PARTY_A_TAKEOVER_JOURNAL_FILE`, for example when rehearsing on a fork.

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
