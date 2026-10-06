# Soft Liquidation

Currently, the system only supports hard liquidation for PartyBs. This means that if a PartyB's liquidity ever drops below the amount required to cover their total position uPNL, we immediately take their entire balance and close all of their positions — even if they have thousands of them. It's an extremely harsh, all-or-nothing approach.

## What can we do instead?

For example, suppose a PartyB's locked balance is $200. If their balance falls below $200, we can still perform a hard liquidation as before.

But we can introduce earlier "warning" stages:

- At **$350**, we send the PartyB an on-chain notice:

    > "You're running low on funds — take action."
    >
- At **$300**, we send another on-chain notice, this time with a penalty:

    > "You're still not addressing this — we're deducting $50."
    >

The tiers at which warnings and penalties trigger, as well as the penalty amounts, will be configurable off-chain. This allows us to treat new PartyBs differently from well-established ones, being more lenient with well-established ones.

Even if the PartyB reaches the $200 hard-liquidation threshold, we may still choose to apply another soft-liquidation cycle instead of immediately hard liquidating — up until a final limit such as $150.

## Why are we doing this?

Hard liquidations cause major disruptions to user experience across all frontends. We know these solvers are reliable and will eventually replenish their funds—they just may be delayed for trivial reasons. A softer, tiered approach stabilizes the system without punishing them excessively.

## Contract Implementation

We add a method in `ClearingHouseFacet` that emits an event and charges a penalty. This method is callable by addresses with the `SOFT_LIQUIDATOR_ROLE`.

### Method Signature

```solidity
function softPartyBLiquidation(
    address partyB,
    address partyA,
    uint256 penaltyFromAllocated,
    uint256 penaltyFromBalance
) external
```

### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `partyB` | `address` | The PartyB being soft liquidated |
| `partyA` | `address` | The specific PartyA whose allocation to deduct from. Pass `address(0)` for cross-mode PartyBs |
| `penaltyFromAllocated` | `uint256` | Amount to deduct from the allocated balance |
| `penaltyFromBalance` | `uint256` | Amount to deduct from the unallocated balance |

### Behavior

- **Cross-mode PartyBs** (`partyA = address(0)`): Penalties are deducted from the PartyB's cross-allocated balance and/or unallocated balance
- **Non-cross-mode PartyBs** (`partyA = specific address`): Penalties are deducted from the PartyB's allocation for that specific PartyA and/or their unallocated balance

Penalty amounts are transferred to the configured `softLiquidationPenaltyCollector` address.

### Event

```solidity
event SoftPartyBLiquidation(
    address indexed partyB,
    address indexed partyA,
    uint256 penaltyFromAllocated,
    uint256 penaltyFromBalance
)
```
