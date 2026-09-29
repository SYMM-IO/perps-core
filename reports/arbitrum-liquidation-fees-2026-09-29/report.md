# Arbitrum liquidation fee report

**Verified liquidator earnings: 22,678.707102 USDC. Of this, 1,288.154906 USDC has been withdrawn and 21,390.552196 USDC remains in Core. The zero address has no balance in the checked internal accounting buckets on either deployment.**

Snapshot: Arbitrum One, chain ID **42161**, block **510,021,942**, **29 September 2026, 12:01:57 UTC** / 14:01:57 Berlin.

Block hash: `0x02108e7eaee8df4cd3411f5c780298bba7457a4c7bfb55d216132746dae88dae`.

The version names below are the supplied deployment labels. “All-time” covers each Core address's lifetime, including earlier implementations at that address. Values are gross fees denominated in USDC, before transaction costs; they are not net operating profit or a USD market valuation. Tables round to six decimals; the evidence retains exact 18-decimal accounting values.

## All-time earnings and remaining balances

| Deployment   | Core                                                                                                                 |     Earned (USDC) | Withdrawn (USDC) | Remaining in Core (USDC) |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------: | ---------------: | -----------------------: |
| v0.8.6.2     | [0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A](https://arbiscan.io/address/0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A) |         90.206617 |         0.000000 |                90.206617 |
| v0.8.5       | [0x8F06459f184553e5d04F07F868720BDaCAB39395](https://arbiscan.io/address/0x8F06459f184553e5d04F07F868720BDaCAB39395) |     22,588.500486 |     1,288.154906 |            21,300.345580 |
| **Combined** |                                                                                                                      | **22,678.707102** | **1,288.154906** |        **21,390.552196** |

Remaining amounts are primarily **allocated balances inside Core**, rather than USDC held by the recipient wallet. Collection still requires the applicable deallocation and withdrawal flow. The current `deallocateCooldown()` is 259,200 seconds (3 days) on the newer Core and 43,200 seconds (12 hours) on the older Core; these values alone do not establish immediate withdrawal eligibility.

Exact reconciliation, in USDC units:

```text
22,678.707102419609042698 earned
 = 1,288.154906 withdrawn
 + 21,390.552196419609042698 remaining in Core
```

## Who earned the fees

| Core label | Credited address                                                                                                                        | All-time earned (USDC) | Remaining in Core (USDC) |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------: | -----------------------: |
| v0.8.5     | [0x7ECBEB26Cf76ca8680c851336B97D4BE8521918C](https://arbiscan.io/address/0x7ECBEB26Cf76ca8680c851336B97D4BE8521918C)                    |          20,171.710152 |            20,171.710152 |
| v0.8.5     | [0xE7f100009A7F06AA08A9D956e9607B5D9481faC1](https://arbiscan.io/address/0xE7f100009A7F06AA08A9D956e9607B5D9481faC1)                    |           2,257.940327 |               969.785421 |
| v0.8.5     | [0x5Df743F2a8d6155d0497D434D1BB59f6F09E112a](https://arbiscan.io/address/0x5Df743F2a8d6155d0497D434D1BB59f6F09E112a)                    |             109.925960 |               109.925960 |
| v0.8.5     | [0x18Ad5aA8948F2B5a571A6f7096a41df68F1301ef](https://arbiscan.io/address/0x18Ad5aA8948F2B5a571A6f7096a41df68F1301ef)                    |              46.786949 |                46.786949 |
| v0.8.5     | **Current proxy:** [0xc587c76a41B9981977D170660C15c0aAbe56B4aA](https://arbiscan.io/address/0xc587c76a41B9981977D170660C15c0aAbe56B4aA) |               2.137099 |                 2.137099 |
| v0.8.6.2   | **Current proxy:** [0xCfB0a84674229500836e662C229530a98bCE11Cc](https://arbiscan.io/address/0xCfB0a84674229500836e662C229530a98bCE11Cc) |              90.206617 |                90.206617 |

Both current proxies' `symmioAddress()` getters match their supplied Cores. Both have zero free internal balance, zero wallet USDC, and no `FeeWithdrawn` events. Their allocated balances exactly equal their historical fee credits.

Most older-Core earnings therefore remain with an earlier liquidator address, especially `0x7ECB…918C`; checking only the current proxy would miss almost all historical earnings. The supplied Fees Manager `0xc9B7…95e1` is not a recipient of these recorded liquidation rewards.

The withdrawal is attributable to `0xE7f1…faC1`. A successful receipt contains both the Core `Withdraw` event and the matching USDC transfer of **1,288.154906 USDC** to `0xb8b9102302F4A0cfc0C531c2f818392D1d2eC162`: [withdrawal transaction](https://arbiscan.io/tx/0x58c7ef581c07c455b2ffd30e187422deeb1c608120cf42325d3508e4c8bb4796).

That liquidator retains 969.785419794923877736 USDC allocated plus 0.000000909053574956 USDC of free accounting dust. The dust is below one USDC token base unit, since USDC has six decimals.

## Liquidation activity and coverage

| Metric                                               |  v0.8.6.2 address | v0.8.5 address |
| ---------------------------------------------------- | ----------------: | -------------: |
| First observed Party A liquidation                   | 10 September 2026 |    8 July 2024 |
| Party A liquidations started                         |                74 |            902 |
| Standard Party A settlements                         |                73 |            902 |
| Settled through Clearing House takeover              |                 1 |              0 |
| Party A settlements paying a positive liquidator fee |                40 |            504 |
| Isolated Party B liquidation starts                  |                 0 |              2 |
| Observed soft-liquidation penalty events             |                 0 |              0 |

All recorded fee-credit transactions match Party A settlements. The two isolated Party B starts did not contribute positive `LF_IN` credits to this ledger.

The newer Core's exceptional account, `0x652b2E3e3850801Ed22c600b13535FbcF93b2664`, was [taken over](https://arbiscan.io/tx/0x7635ca24b7d6c92055bd3b558a318831f31bc871898834857683a85e9cc174a5) and [settled through the Clearing House](https://arbiscan.io/tx/0xc1e2342acdb487e783b0a0ea341bc92fc658d9b10eef7579c9a158115c52be8f). Its liquidation flag is false and its liquidation detail is cleared at the snapshot. It is not an unfinished normal settlement, and no liquidator reward is included for it.

The older Core emitted **792 old-format settlement events**, of which **788 duplicate modern-format settlements**. Only **four** additional settlements predate modern fee-credit events. Their historical storage proves another **1,114.284146211465491456 USDC** paid to `0xE7f1…faC1`. These are included once. Historical storage reconstruction also exactly matched modern fee events for all 788 overlapping settlements, with zero mismatches.

## Current liquidation fee rules

| Setting or behavior                                  | v0.8.6.2                                                      | v0.8.5                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Party A liquidator-profit cap                        | 100 USDC per position                                         | 100 USDC per position                                                                   |
| Party A reward recipient in reviewed version source  | Liquidation starter receives the capped reward                | Starter and first recorded price setter each receive half; they may be the same address |
| `liquidatorShare()` for isolated Party B liquidation | 10% to initiator; remainder allocated to position liquidators | 50% to initiator; remainder allocated to position liquidators                           |
| Insurance recipient                                  | `0x77A955776Ee1dd3E9C800c3214ed489441d74b94`                  | Main multisig `0xdf4188959bC1711e5B999fC527901DAAe1630C78`                              |
| Insurance recipient's free / allocated Core balance  | 0 / 0                                                         | 0 / 0                                                                                   |
| Soft-liquidation penalty recipient                   | Same address as insurance recipient                           | Same address as insurance recipient                                                     |

The reserve called LF is not necessarily the amount ultimately earned. For normal Party A liquidation, the reward is the remaining LF after the liquidation shortfall, capped by `maxLiquidationProfitPerPosition × starting position count`. Excess above the cap goes to the insurance recipient's free Core balance. Late and overdue liquidations can leave no LF reward. Finalization credits the liquidator's allocated Core balance.

The 10% / 50% `liquidatorShare()` settings concern **Party B liquidation**, not a percentage of Party A collateral or a protocol share of every Party A reward.

The older Core previously configured a 1 USDC per-position cap at block 454,823,198 and changed it to 100 at block 468,590,973. Earlier rewards must not be evaluated against today's cap.

No positive net insurance credit was found across all 74 newer-Core liquidation-start blocks and 108 older-Core pricing blocks after insurance configuration. All 73 newer and 110 older standard settlements checked in that configured period remained below their applicable aggregate cap. Both insurance internal balances are zero. This insurance check uses block-level balance differences rather than transaction-level storage traces; hypothetical offsetting movements within the same block are not independently excluded by those differences alone. No insurance amount has been added to the liquidator earnings total.

## Current symbol fee minimums

| Deployment | Symbol count | Minimum LF / locked Party A collateral                                      |
| ---------- | -----------: | --------------------------------------------------------------------------- |
| v0.8.6.2   |          238 | **0.3% for all 238 symbols**                                                |
| v0.8.5     |        3,777 | **3% for 10 BTC/ETH listings; 4% for 3,679 listings; 0.4% for 88 listings** |

The older Core's 88 listings at **0.4%** are IDs **3690–3777**. This is one tenth of the 4% setting on most older listings. The inventory includes inactive and duplicate listings.

These rates apply to locked collateral, not position notional:

```text
LF >= minAcceptablePortionLF × (CVA + LF + Party A maintenance margin)
```

For example, a 0.3% floor against 100 USDC total locked collateral requires at least 0.30 USDC LF; a 4% floor requires 4 USDC. Actual quote reserves can exceed the floor, and liquidation losses can reduce the eventual payout.

The newer Core's default notional LF floor is zero and no notional-floor change events were found. The older Core has no installed selector for that getter. This report does not recommend or execute configuration changes.

## Zero-address balance check

Address checked: `0x0000000000000000000000000000000000000000`, at the same pinned block.

| Internal bucket                                            |                v0.8.6.2 |                  v0.8.5 |
| ---------------------------------------------------------- | ----------------------: | ----------------------: |
| Free balance: `balanceOf(0)`                               |                       0 |                       0 |
| Allocated Party A balance                                  |                       0 |                       0 |
| Party A locked and pending CVA, LF and maintenance margin  |                All zero |                All zero |
| Party B allocated, locked and pending amounts for `(0, 0)` |                All zero |                All zero |
| Cross-mode balances owned by Party B `0`                   |                All zero |                All zero |
| Reserve-vault balance for Party B `0`                      |                       0 |                       0 |
| Party A reimbursement                                      |                       0 |                       0 |
| Party A deferred balance                                   |                       0 |                       0 |
| Liquidation escrow                                         |                       0 |                       0 |
| Party B liquidation settlement reserve                     |                       0 |                       0 |
| Withdrawal requests                                        | None; last request ID 0 | None; last request ID 0 |

The USDC token's own `balanceOf(0)` is also zero. Real solvers' intentional cross-margin allocation keys of `address(0)` are separate from funds owned by the zero address and are not classified here as stranded zero-address funds. This is a current balance check, not a reconstruction of all historical zero-address inflows and recoveries.

## Evidence and reproducibility

- `evidence.json` contains exact totals, recipients, state reads, raw zero-address responses, the withdrawal receipt, collateral history, source revisions and cross-provider checks.
- `fee-ledger.json` contains 1,040 modern `LF_IN` event credits and four additional legacy settlement credits, including transaction identifiers and raw amounts.
- `verify-evidence.cjs` checks ledger uniqueness, integer sums, recipient reconciliation, the successful USDC withdrawal receipt and zero-address buckets using the saved evidence.

Modern event history was retrieved from block 0 through the snapshot using the official Arbitrum RPC and independently cross-checked through Tenderly's public RPC. The event and fee sets agreed exactly. Legacy settlement counts were also cross-checked. Historical role grants and all observed liquidation callers supplied the candidate recipient set; current and historical source paths credit liquidator rewards to those participants.

For a modern credit, query `eth_getLogs` against the listed Core with topic 0 `0x12f926682e9716435703a506b436993346a19a8d2f4378b264fee4c5a87f34a2` (`BalanceChangePartyA(address,uint256,uint8)`), topic 1 the padded recipient address, and range `0x0` through `0x1e665136`. Decode data as `(uint256 amount, uint8 reason)` and sum **reason 8** only. Core accounting uses 18 decimals; USDC transfer events use six.

For each of the four additional legacy settlements, the ledger records the slot and historical block used in `eth_getStorageAt`. The slot is `keccak256(abi.encode(partyA, uint256(keccak256("diamond.standard.storage.account")) + 11)) + 5`, the historical `liquidationDetails[partyA].liquidationFee`. The reviewed implementation leaves that field intact when it clears liquidation type; actual payout is `2 × floor(fee / 2)`. Duplicate legacy and modern emissions are excluded.

Source revisions inspected in this checkout:

```text
v0.8.6.2: 0eb4b51fdffd15d4d442a63593cdda7cd94873f4
  contracts/core/libraries/liquidation/LibPartyALiquidationShared.sol
  contracts/core/libraries/liquidation/LibPartyALiquidationProcess.sol
v0.8.5: 6aace1560476374dc7002e677a45dbd48b30b6d1
  contracts/core/facets/PartyALiquidation/PartyALiquidationFacetImpl.sol
  contracts/core/libraries/LibLiquidation.sol
Legacy v0.8.2: 93f63fe6bfbdde27de719c96fbb53f3c1ad0798f
  contracts/facets/liquidation/LiquidationFacetImpl.sol
  contracts/storages/AccountStorage.sol
```

Use `git show REVISION:PATH` to reproduce a source read. Source revisions establish accounting semantics; this report is not a complete runtime-bytecode parity audit of every historical upgrade. Current settings and amounts come from pinned chain reads and receipts. The older Core briefly configured another collateral token during initial setup, but switched to the supplied USDC before the earliest observed liquidation; every included fee is therefore reported in USDC units.
