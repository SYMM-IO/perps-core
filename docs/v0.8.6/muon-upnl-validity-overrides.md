# Muon UPNL Validity Overrides

Version: v0.8.6 auditor note.

This document describes the per-function Muon UPNL signature validity configuration added in v0.8.6. The change lets operators use different freshness windows for different protocol operation categories while keeping the existing global `setMuonConfig` value as the fallback.

---

## Summary

Before this change, every UPNL-based Muon signature used the same global validity window:

```solidity
setMuonConfig(upnlValidTime, priceValidTime)
```

That made short-window account operations and longer-window liquidation operations share one value, even though their operational needs are different. For example, deallocation can reasonably require a very fresh signature such as `10` seconds, while PartyA liquidation may need a larger submission window such as `120` seconds.

v0.8.6 adds optional overrides by `MuonFunction`:

```solidity
setMuonFunctionUpnlValidTime(func, upnlValidTime)
```

The override is intentionally controlled by a single setter:

- Passing a nonzero `upnlValidTime` sets the override for that function category.
- Passing `0` clears the override for that function category.
- A cleared or unset function category falls back to the global `upnlValidTime` from `setMuonConfig`.

There is no separate `clear` method and no separate `hasOverride` storage flag. In the per-function mapping, `0` is the unset value.

---

## API Changes

### Set or clear a per-function override

```solidity
function setMuonFunctionUpnlValidTime(
    MuonFunction func,
    uint256 upnlValidTime
) external;
```

Access control:

- Caller must have `MUON_SETTER_ROLE`.

Behavior:

- If `upnlValidTime > 0`, the value is stored in `MuonStorage.upnlValidTimeByFunction[func]`.
- If `upnlValidTime == 0`, the stored override is deleted.
- After deletion, the function category inherits the global `upnlValidTime`.

The setter emits:

```solidity
event SetMuonFunctionUpnlValidTime(
    MuonFunction indexed func,
    bool enabled,
    uint256 upnlValidTime
);
```

Event semantics:

- `enabled == true`: a nonzero override was set.
- `enabled == false`: the override was cleared.
- When clearing, `upnlValidTime` is emitted as `0`.

### Read the effective validity

```solidity
function getMuonFunctionUpnlValidTime(
    MuonFunction func
) external view returns (uint256 upnlValidTime, bool isOverridden);
```

Return semantics:

- If an override is set, `upnlValidTime` is the override and `isOverridden == true`.
- If no override is set, `upnlValidTime` is the global value from `getMuonConfig()` and `isOverridden == false`.

This view returns the effective value used by verification, not the raw mapping slot.

---

## Storage Model

The new storage field is:

```solidity
mapping(MuonFunction => uint256) upnlValidTimeByFunction;
```

The mapping is optional configuration. It does not replace the global `upnlValidTime`.

The invariant is:

```text
effectiveUpnlValidTime(func) =
  upnlValidTimeByFunction[func] == 0
    ? global upnlValidTime
    : upnlValidTimeByFunction[func]
```

Operational note: `0` is reserved as "unset" for per-function overrides. Do not use `0` as an intentional validity window. Operators should keep the global `upnlValidTime` configured to a nonzero value.

---

## MuonFunction Categories

The categories are the same `MuonFunction` enum used by the signature verifier's key and gateway authorization system:

```solidity
enum MuonFunction {
    Trading,
    AccountManagement,
    Settlement,
    ForceClose,
    Funding,
    LiquidationPartyA,
    LiquidationPartyB
}
```

The intended method grouping is:

| Category | Methods / flows |
| --- | --- |
| `Trading` | `sendQuote`, `lockQuote`, `openPosition`, `fillCloseRequest`, `fillCloseRequestToLiquidation`, `emergencyClosePosition`, `openPositions`, `closePositions` |
| `AccountManagement` | `deallocate`, `safeDeallocate`, `deallocateForPartyB`, transfer-allocation flows that verify account UPNL |
| `Settlement` | `settleUpnl`, `settleUpnlUnified`, isolated and cross-PartyB settlement signatures |
| `ForceClose` | `requestToClosePosition`, `forceClosePosition`, force-close settlement, legacy force-close settlement, final force-close steps |
| `Funding` | `chargeFundingRate`, `chargeAccumulatedFundingFee` |
| `LiquidationPartyA` | `liquidatePartyA`, `setSymbolsPrice`, `deferredLiquidatePartyA`, `deferredSetSymbolsPrice` |
| `LiquidationPartyB` | `liquidatePartyB`, `liquidatePositionsPartyB` |

Auditors should treat this table as the operation-level policy surface. It controls the freshness window for timestamp checks, while the same enum also controls which Muon public keys and gateway signers are authorized to sign each category.

Important distinction: the category is passed to the signature verifier for key and gateway authorization on all grouped calls, but the per-function validity window only applies where the on-chain code checks signature freshness against `block.timestamp`.

---

## Effective Validity Resolution

UPNL timestamp checks now go through:

```solidity
LibMuon.verifyUpnlTimestamp(timestamp, func)
```

which resolves the effective validity with:

```solidity
LibMuon.getUpnlValidTime(func)
```

This helper first checks `upnlValidTimeByFunction[func]`. If the mapping value is zero, it falls back to the global `MuonStorage.upnlValidTime`.

The change was applied across the Muon helper libraries that validate UPNL-bearing signatures:

```text
LibMuonAccount
LibMuonPartyA
LibMuonPartyB
LibMuonPartyBBatchActions
LibMuonFundingRate
LibMuonForceActions
LibMuonSettlement
LibMuonUnifiedSettlement
LibMuon
```

PartyA liquidation also uses `LibMuon.getUpnlValidTime(MuonFunction.LiquidationPartyA)` for its explicit liquidation signature freshness check, so it no longer reads the global `upnlValidTime` directly.
