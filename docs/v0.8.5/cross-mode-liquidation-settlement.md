# Cross-Mode Settlement During Liquidation

Cross-mode PartyBs hold their collateral in a single pooled bucket. Because solvency is evaluated against aggregate uPNL across all counterparties, a PartyB's raw allocated balance can be much lower than the total value it actually controls -- most of the value may sit as unrealized profit in open positions. When one of those counterparties gets liquidated and the settlement requires the PartyB to pay, the system needs a way to convert that unrealized profit into allocated balance first. This is what `settlePartyBUpnlForLiquidation` does.

## Why This Is Needed

In cross mode, `partyBAvailableForQuote` includes unrealized PnL:

```
available = allocatedBalances[partyB][address(0)]
          - totalLockedBalances(partyB)
          + aggregateUPNL
```

A PartyB with 200 allocated, 130 locked, and +500 uPNL has an available balance of 570. It could legally deallocate all 200 and still be solvent. But `settlePartyALiquidation` draws from the raw `partyBAllocatedBalances` -- it does not factor in uPNL. If the PartyB owes 50 from a liquidation settlement and its allocated balance is 0 (plus 22 from CVA return = 22), that is not enough.

Isolated PartyBs do not have this gap. Their balance is per-PartyA and cannot be boosted by profits from other counterparties, so the protocol simply caps the payment at whatever is available. Cross-mode PartyBs, on the other hand, have a shared pool that _can_ be funded from other positions -- so the protocol requires the liquidator to do that before settling.

In practice, this scenario is rare. Symmio's off-chain monitoring enforces stricter balance requirements on solvers than the on-chain solvency threshold -- solvers are required to maintain a buffer well above the contract minimum. If a solver's balance drops below the off-chain threshold, [soft liquidation](soft-liquidation.md) penalties are applied before hard insolvency is ever reached. This reduces the likelihood of a cross-mode PartyB having insufficient allocated balance during a PartyA liquidation, but the on-chain guard exists as a safety net for the cases that slip through.

## `settlePartyBUpnlForLiquidation`

Located on `SettlementFacet`, this function lets a liquidator realize a cross-mode PartyB's uPNL from positions with other (non-liquidated) PartyAs before the liquidation settlement.

```solidity
function settlePartyBUpnlForLiquidation(
    address liquidatedPartyA,
    UnifiedSettlementSig memory sig,
    uint256[] memory updatedPrices
) external whenNotLiquidationPaused onlyRole(LIQUIDATOR_ROLE)
```

**Access control:** Requires `LIQUIDATOR_ROLE`. Respects the liquidation pause flag.

**Validations:**
- `liquidatedPartyA` must be in an active liquidation
- The PartyB in the signature must be cross-mode
- A pending settlement must exist for this PartyB with the liquidated PartyA
- None of the PartyAs in the settlement signature can be the liquidated PartyA (cannot settle with a party being liquidated)

**Mechanics:** Delegates to `LibSettlement.settleUpnlUnified` with `privilegedMode = true`, which bypasses the "caller must have a position" check and settlement cooldowns. This adjusts `openedPrice` on the settled quotes, transferring funds from the solvent PartyAs' allocated balances into the PartyB's cross bucket. After this call, the PartyB has enough allocated balance to cover the liquidation settlement.

**Concurrent liquidations:** Because `settleUpnlUnified` requires that none of the target PartyAs are in liquidation themselves (`!liquidationStatus[partyA]`), the liquidator cannot settle the PartyB's uPNL using positions with a PartyA that is also being liquidated. If the PartyB's profitable positions are concentrated with a concurrently liquidated PartyA, the liquidator must wait for that liquidation to complete first, then settle with positions from other solvent PartyAs. If no solvent PartyAs remain, the ClearingHouse takes over.

## Settlement Guard in `settlePartyALiquidation`

When a PartyB's allocated balance (after CVA return) is less than the settle amount, behavior depends on mode:

- **Isolated PartyB:** Payment is capped at the available balance. The shortfall is absorbed since isolated PartyBs cannot source funds from other PartyAs.

- **Cross-mode PartyB:** The transaction reverts with `"LiquidationFacet: Settle cross partyB uPNL first"`. The liquidator has two options: call `settlePartyBUpnlForLiquidation` to realize the PartyB's uPNL and fund the cross bucket, then retry the settlement; or, if settlement alone cannot cover the shortfall, the ClearingHouse takes over the liquidation entirely and handles the unwinding through [its own flow](clearing-house.md).

```solidity
} else {
    require(
        !maLayout.crossModeEnabledForPartyB[partyB],
        "LiquidationFacet: Settle cross partyB uPNL first"
    );
    // Isolated: cap at available balance
    settleAmounts[i] = int256(accountLayout.partyBAllocatedBalances[partyB][allocKey]);
    accountLayout.partyBAllocatedBalances[partyB][allocKey] = 0;
}
```

## Liquidation Flow

When a PartyA liquidation involves a cross-mode PartyB whose allocated balance is insufficient:

```
1. liquidatePartyA(partyA, sig)
   └─ Sets liquidationStatus[partyA] = true

2. setSymbolsPrice(partyA, sig)
   └─ Sets liquidation prices for each symbol

3. liquidatePositionsPartyA(partyA, quoteIds[])
   └─ Closes positions, computes settleAmounts
   └─ May trigger dispute if cross PartyB can't cover

4. resolveLiquidationDispute(partyA, partyBs[], amounts[], false)
   └─ Admin resolves dispute, clears disputed flag
   └─ (only needed if dispute was triggered in step 3)

5. settlePartyALiquidation(partyA, [isolatedPartyBs])
   └─ Settle isolated PartyBs first (capped payment if needed)

6. settlePartyBUpnlForLiquidation(partyA, sig, prices[])
   └─ Realize cross PartyB's uPNL from other solvent PartyAs
   └─ Increases PartyB's allocated balance

7. settlePartyALiquidation(partyA, [crossPartyB])
   └─ Now succeeds with sufficient balance
```

Steps 5--7 can be combined if the liquidator settles uPNL before attempting any settlement. Step 4 is only needed when the dispute flag is set.

## Isolated vs Cross-Mode Behavior

<table>
<tr><td><strong>Scenario</strong></td><td><strong>Isolated PartyB</strong></td><td><strong>Cross-Mode PartyB</strong></td></tr>
<tr><td>Balance >= settleAmount</td><td>Full payment</td><td>Full payment</td></tr>
<tr><td>Balance < settleAmount</td><td>Capped at available balance (shortfall absorbed)</td><td>Reverts -- liquidator must call <code>settlePartyBUpnlForLiquidation</code> first</td></tr>
<tr><td>Rationale</td><td>Isolated PartyB cannot source funds from other PartyAs</td><td>Cross PartyB can realize uPNL from positions with other solvent PartyAs</td></tr>
</table>

## Event

```solidity
event SettlePartyBUpnlForLiquidation(
    address indexed liquidatedPartyA,
    address indexed partyB,
    bytes settlementId,
    UnifiedQuoteSettlementData[] settlementData,
    uint256[] updatedPrices,
    address[] partyAs,
    uint256[] newPartyAsAllocatedBalances,
    uint256 newPartyBAllocatedBalance
);
```

Emitted by `SettlementFacet` when a liquidator realizes a cross-mode PartyB's uPNL during a PartyA liquidation.
