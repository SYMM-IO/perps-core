# Liquidation Escrow

## Overview

The liquidation escrow mechanism prevents a PartyA from recovering pending trading fees through the liquidation reimbursement path when their liquidation is classified as `LATE` or `OVERDUE`. Without this mechanism, a PartyA whose positions are liquidated at a severe deficit can still receive back the trading fees from their cancelled pending quotes -- effectively recovering funds that should be available to compensate PartyBs for haircut losses.

This is especially relevant in [oracle-less trading](oracle-less-trading.md) mode, where a bound PartyA can submit fabricated UPNL values to bypass the available balance check in `sendQuote`. By sending many quotes with inflated UPNL, the PartyA drains their `allocatedBalances` into trading fees while keeping positions open. When liquidated as `LATE` or `OVERDUE`, the pending quotes are cancelled and their fees are refunded. Without the escrow, these refunded fees would go straight back to the PartyA at settlement -- the exact funds they drained to worsen the liquidation severity.

The vulnerability exists without oracle-less mode too, but the impact is negligible because the Muon oracle enforces accurate UPNL values, which limits how much excess fee draining is possible.

## How It Works

During PartyA liquidation, two types of funds accumulate before settlement:

**Pending fee reimbursement** (`partyAReimbursement`) -- When `liquidatePendingPositionsPartyA` cancels pending quotes (SENT, LOCKED, CANCEL_PENDING), each quote's trading fee is refunded to `partyAReimbursement`. This is the attack vector -- these fees were deducted from `allocatedBalances` when the quote was created, and the attacker wants them back.

**Deferred excess balance** (`partyADeferredBalance`) -- In [deferred liquidation](clearing-house.md), where the Muon oracle proves historical insolvency, the PartyA may have deposited additional funds since the insolvency point. The difference between the current `allocatedBalances` and the historical `liquidationAllocatedBalance` is the excess. This excess is legitimate -- it's funds the PartyA added after the fact -- and is always returned to the PartyA regardless of liquidation type.

At settlement (`settlePartyALiquidation`), the routing depends on the liquidation type:

| Liquidation Type | Pending Fee Reimbursement | Deferred Excess |
|------------------|--------------------------|-----------------|
| NORMAL | Returned to PartyA | Returned to PartyA |
| LATE | Moved to `liquidationEscrow` | Returned to PartyA |
| OVERDUE | Moved to `liquidationEscrow` | Returned to PartyA |

In `NORMAL` liquidation, the deficit is smaller than the locked LF, meaning PartyBs are made whole. There is no fairness concern with returning fees to the PartyA.

In `LATE` and `OVERDUE` liquidation, the deficit exceeds the locked LF and eats into CVA. PartyBs absorb losses (haircuts). Returning fees to the PartyA in this case would be unfair -- the ClearingHouse needs these funds to compensate affected PartyBs.

## Settlement Code

The routing logic in `settlePartyALiquidation`:

```solidity
uint256 deferredBalance = accountLayout.partyADeferredBalance[partyA];
uint256 reimbursement = accountLayout.partyAReimbursement[partyA];

LiquidationType liqType = accountLayout.liquidationDetails[partyA].liquidationType;
if (liqType == LiquidationType.LATE || liqType == LiquidationType.OVERDUE) {
    // Deferred balance always goes back to partyA
    // Reimbursement (pending fees) goes to escrow for CH distribution
    accountLayout.allocatedBalances[partyA] = deferredBalance;
    if (reimbursement > 0) {
        accountLayout.liquidationEscrow[partyA] += reimbursement;
        emit LiquidationEscrowCreated(partyA, liquidationId, reimbursement);
    }
} else {
    // NORMAL: everything goes back to partyA
    accountLayout.allocatedBalances[partyA] = deferredBalance + reimbursement;
}
accountLayout.partyADeferredBalance[partyA] = 0;
accountLayout.partyAReimbursement[partyA] = 0;
```

The escrow uses `+=` rather than `=` because a PartyA could be liquidated multiple times before the ClearingHouse distributes the escrow from the first liquidation.

## ClearingHouse Distribution

After settlement, the escrowed funds sit in `liquidationEscrow[partyA]` until the ClearingHouse distributes them via `distributeFromLiquidationEscrow`. This function follows the same routing pattern as `distributeForClearingHouse` -- it supports distributing to both PartyA addresses (`allocatedBalances`) and PartyBs (`partyBAllocatedBalances`):

```solidity
function distributeFromLiquidationEscrow(
    address partyA,
    address[] memory receivers,
    address[] memory allocationKeys,
    uint256[] memory amounts
) external onlyRole(CLEARING_HOUSE_ROLE)
```

The ClearingHouse operator decides how to distribute the escrowed funds. Typical uses:

- **Compensate PartyBs** -- Return funds to PartyBs who suffered CVA haircuts from the `LATE`/`OVERDUE` liquidation.
- **Return to PartyA** -- If investigation shows the fees were legitimate (not from an attack), the ClearingHouse can return them.
- **Split** -- Distribute partially to PartyBs and partially to PartyA.

The function validates that the total distributed amount does not exceed the escrow balance.

## ClearingHouse Takeover (Unaffected)

The escrow mechanism does not affect the ClearingHouse takeover flow. When the ClearingHouse takes over a PartyA liquidation (`takeoverPartyALiquidation`), it settles via `settlePartyATakeover` instead of `settlePartyALiquidation`. In the takeover flow:

- Both `partyAReimbursement` and `partyADeferredBalance` are released directly to `allocatedBalances[partyA]`.
- The ClearingHouse already has full control over the PartyA's funds via `deallocateForClearingHouse` (including pulling from `partyAReimbursement` via `REIMBURSEMENT_KEY = address(1)`).
- No escrow routing is needed because the ClearingHouse can distribute funds however it sees fit through the takeover lifecycle.

## Deferred Liquidation and Escrow

In a deferred liquidation with excess balance, the deferred extraction always zeroes out the PartyA's available balance. This means `determineLiquidationType` always classifies the result as `NORMAL` (since `-availableBalance = 0 < lockedLf`). Consequently, a deferred liquidation with positive excess never triggers the escrow -- both the deferred balance and the pending fee reimbursement are returned to the PartyA.

The only way a deferred liquidation produces `LATE` or `OVERDUE` is when there is no excess (i.e., the PartyA hasn't deposited additional funds since the historical insolvency). In that case, the behavior is identical to a non-deferred liquidation.

## Storage

Two new mappings in `AccountStorage.Layout`:

```solidity
/// @notice Escrowed funds from LATE/OVERDUE liquidations awaiting CH distribution
mapping(address => uint256) liquidationEscrow;

/// @notice PartyA's excess balance from deferred liquidation.
/// Always returned to partyA at settlement regardless of liquidation type.
/// Not accessible by clearing house via REIMBURSEMENT_KEY.
mapping(address => uint256) partyADeferredBalance;
```

## View Functions

```solidity
function getLiquidationEscrow(address partyA) external view returns (uint256);
function getPartyADeferredBalance(address partyA) external view returns (uint256);
```

## Events

```solidity
/// Emitted when pending fees are moved to escrow during LATE/OVERDUE settlement
event LiquidationEscrowCreated(address indexed partyA, bytes liquidationId, uint256 amount);

/// Emitted when the ClearingHouse distributes escrowed funds
event DistributeFromLiquidationEscrow(
    address indexed partyA,
    address[] receivers,
    address[] allocationKeys,
    uint256[] amounts
);
```

## Relevant Files

| File | Role |
| --- | --- |
| `contracts/core/storages/AccountStorage.sol` | `liquidationEscrow` and `partyADeferredBalance` mappings |
| `contracts/core/facets/PartyALiquidation/PartyALiquidationFacetImpl.sol` | Fee accumulation in `liquidatePendingPositionsPartyA`; escrow routing in `settlePartyALiquidation` |
| `contracts/core/facets/PartyALiquidation/DeferredLiquidationFacetImpl.sol` | Deferred excess extraction to `partyADeferredBalance` |
| `contracts/core/facets/ClearingHouse/ClearingHouseFacetImpl.sol` | `distributeFromLiquidationEscrow`; `settlePartyATakeover` releases both balances |
| `contracts/core/facets/ClearingHouse/ClearingHouseFacet.sol` | External `distributeFromLiquidationEscrow` with role check |
| `contracts/core/facets/ViewFacet/ViewFacet.sol` | `getLiquidationEscrow` and `getPartyADeferredBalance` getters |
