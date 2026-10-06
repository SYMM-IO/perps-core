# Liquidation Insurance Vault

## Overview

The Liquidation Insurance Vault is a protocol-level mechanism that caps the profit liquidators can extract from PartyA liquidations and redirects any excess to a designated vault address. Without this cap, liquidators could earn disproportionately large fees when liquidating accounts with many positions or unusually high locked liquidation fees (LF). The excess funds collected by the vault serve as protocol revenue and can be used to cover deficits in future overdue liquidations.

## Why It Exists

During PartyA liquidation, the leftover LF (locked LF minus the insolvency deficit) is paid out to the liquidators who processed the liquidation. In a `NORMAL` liquidation where PartyA's losses are smaller than the locked LF, this remainder can be substantial -- especially on accounts with many open positions, each contributing their own LF.

Two problems arise without a cap:

1. **Liquidation fee inflation** -- Liquidators are incentivized to front-run insolvency with high gas bids when the potential payout is large, driving up costs for all users.
2. **No protocol revenue from liquidations** -- All leftover LF goes directly to liquidators, even when the amount far exceeds a reasonable incentive.

The insurance vault solves both problems by bounding per-position liquidator profit to `maxLiquidationProfitPerPosition`. Everything above that threshold flows to the vault.

## Configuration

The vault address and per-position cap are set together via `ControlFacet`:

```solidity
function setLiquidationInsuranceVaultParams(
    address insuranceVault,
    uint256 maxLiquidationProfit
) external onlyRole(LibAccessibility.FEE_ADMIN_ROLE)
```

| Parameter | Description |
| --- | --- |
| `insuranceVault` | Address that receives excess LF. Must be non-zero. |
| `maxLiquidationProfit` | Maximum LF a liquidator can earn **per position** (in collateral token units). |

Both values are stored in `MAStorage`:

```solidity
/// @notice Address that receives excess liquidation fees above the profit cap
address liquidationInsuranceVault;

/// @notice Cap on profit a liquidator can make from a single position
uint256 maxLiquidationProfitPerPosition;
```

The function requires `FEE_ADMIN_ROLE` and emits:

```solidity
event SetLiquidationInsuranceVaultParams(address insuranceVault, uint256 maxLiquidationProfit);
```

Current values can be read via `ViewFacet`:

```solidity
function getLiquidationInsuranceVaultParams() external view returns (address, uint256);
```

## How It Works in the Liquidation Flow

The cap is enforced inside `LibLiquidation.determineLiquidationType`, which is called during `setSymbolsPrice` -- the step where the oracle provides symbol prices and the protocol classifies the liquidation severity.

### The Three Liquidation Types

PartyA liquidation is classified based on how much of the locked balance the deficit consumes:

| Type | Condition | Meaning |
| --- | --- | --- |
| `NORMAL` | deficit < LF | Enough LF remains to pay liquidators. |
| `LATE` | LF <= deficit <= LF + CVA | LF is fully consumed; deficit eats into CVA. |
| `OVERDUE` | deficit > LF + CVA | Both LF and CVA are consumed; PartyB absorbs losses. |

The insurance vault cap only applies to `NORMAL` liquidations, because that is the only type where `remainingLf > 0`.

### The Cap Mechanism

The relevant code in `LibLiquidation.determineLiquidationType`:

```solidity
if (uint256(-availableBalance) < accountLayout.lockedBalances[partyA].lf) {
    uint256 remainingLf = accountLayout.lockedBalances[partyA].lf - uint256(-availableBalance);
    uint256 maxLf = maLayout.maxLiquidationProfitPerPosition
                  * QuoteStorage.layout().partyAPositionsCount[partyA];
    if (remainingLf > maxLf) {
        accountLayout.balances[maLayout.liquidationInsuranceVault] += remainingLf - maxLf;
        remainingLf = maxLf;
    }
    detail.liquidationType = LiquidationType.NORMAL;
    detail.liquidationFee = remainingLf;
}
```

Step by step:

1. **Compute `remainingLf`** -- the locked LF minus the absolute deficit (`|availableBalance|`). This is the total fee pool available to liquidators.
2. **Compute `maxLf`** -- the cap, calculated as `maxLiquidationProfitPerPosition * partyAPositionsCount`. The cap scales linearly with the number of open positions because each position represents work for the liquidator.
3. **Compare and redirect** -- if `remainingLf > maxLf`, the excess (`remainingLf - maxLf`) is credited to the insurance vault's balance, and `remainingLf` is reduced to `maxLf`.
4. **Store the capped fee** -- `detail.liquidationFee` is set to the (possibly capped) `remainingLf`. This is the total amount distributed to liquidators at settlement.

The excess is credited directly to `accountLayout.balances[liquidationInsuranceVault]`, meaning the vault address can withdraw these funds like any other user balance.

### Fee Distribution at Settlement

At the end of the liquidation process, `settlePartyALiquidation` distributes the capped fee equally between the two liquidators who participated:

```solidity
uint256 lf = accountLayout.liquidationDetails[partyA].liquidationFee;
if (lf > 0) {
    accountLayout.allocatedBalances[accountLayout.liquidators[partyA][0]] += lf / 2;
    accountLayout.allocatedBalances[accountLayout.liquidators[partyA][1]] += lf / 2;
}
```

The first liquidator is the one who called `liquidatePartyA` (or `setSymbolsPrice` for deferred liquidations). The second is the one who called `setSymbolsPrice` (or again `setSymbolsPrice` in the deferred flow). Each receives exactly half of the capped `liquidationFee`.

## Example

Suppose:
- PartyA has 100 open positions
- Total locked LF = 10,000 USDC
- Deficit (insolvency amount) = 2,000 USDC
- `maxLiquidationProfitPerPosition` = 50 USDC

Calculation:
1. `remainingLf` = 10,000 - 2,000 = **8,000 USDC**
2. `maxLf` = 50 * 100 = **5,000 USDC**
3. Since 8,000 > 5,000, excess = 8,000 - 5,000 = **3,000 USDC** goes to the insurance vault
4. `detail.liquidationFee` = **5,000 USDC** (split 2,500 to each liquidator at settlement)

## Scope

The insurance vault cap applies **only to PartyA liquidations** (specifically the `NORMAL` type). PartyB liquidations use a different fee distribution mechanism based on `liquidatorShare` and `partyBPositionLiquidatorsShare`, and are not subject to this cap.

## Relevant Files

| File | Role |
| --- | --- |
| `contracts/core/storages/MAStorage.sol` | Stores `liquidationInsuranceVault` and `maxLiquidationProfitPerPosition` |
| `contracts/core/libraries/LibLiquidation.sol` | Implements the cap logic in `determineLiquidationType` |
| `contracts/core/facets/Control/ControlFacet.sol` | `setLiquidationInsuranceVaultParams` setter |
| `contracts/core/facets/Control/IControlFacet.sol` | Interface declaration |
| `contracts/core/facets/Control/IControlEvents.sol` | `SetLiquidationInsuranceVaultParams` event |
| `contracts/core/facets/ViewFacet/ViewFacet.sol` | `getLiquidationInsuranceVaultParams` getter |
| `contracts/core/facets/PartyALiquidation/PartyALiquidationFacetImpl.sol` | Calls `determineLiquidationType` from `setSymbolsPrice`; distributes fee in `settlePartyALiquidation` |
| `contracts/core/facets/PartyALiquidation/DeferredLiquidationFacetImpl.sol` | Calls `determineLiquidationType` from deferred `setSymbolsPrice` |
| `contracts/core/storages/AccountStorage.sol` | Stores `balances` (where vault excess is credited) and `LiquidationDetail.liquidationFee` |
