# Custom open/close fee for affiliates

Before this update, platform fees were only charged on **open** and were defined by the `tradingFee` parameter of a symbol. Now, we have additional close fee for closing positions and more flexible fee structure.

The `tradingFee` parameter acts as a default fee, while affiliates can set fee ratios for themselves on both **open** and **close sides**.

Also the affiliates can set a fee ratio for all positions or set fees per symbol or set fees per symbol and user. The priority for fee used in a position should be like this:

1. Affiliate defined fee for user and symbol (`affiliateFeeForUser[affiliate][user][symbolId]`)
2. Affiliate defined default fee for user (`affiliateFeeForUser[affiliate][user][0]` - symbolId 0 = default)
3. Affiliate defined fee for symbol (`affiliateFee[affiliate][symbolId]`)
4. Affiliate defined default fee for all symbols (`affiliateFee[affiliate][0]` - symbolId 0 = default)
5. Symmio default fee which is there in the symbol struct (`symbols[symbolId].tradingFee`)

**Note:** For both `affiliateFee` and `affiliateFeeForUser`, symbolId 0 is used as the default fee when no symbol-specific fee is set.

To support this, the following methods have been added in the control facet:

```solidity
// Set custom affiliate fee per user and symbol (supports batch operations):
function setAffiliateFeeForUser(
    address affiliate,
    address[] calldata users,
    uint256[] calldata symbolIds,
    uint256[] calldata openFees,
    uint256[] calldata closeFees
) external;

// Set affiliate fee per symbol (supports batch operations, use symbolId 0 for default):
function setAffiliateFee(
    address affiliate,
    uint256[] calldata symbolIds,
    uint256[] calldata openFees,
    uint256[] calldata closeFees
) external;

// Set minimum affiliate fee threshold:
function setMinAffiliateFee(uint256 minAffiliateFee) external;
```

The methods can be called either by the affiliate manager or by the affiliates themselves. In the latter case, frontends may need to update their contract to support these function calls through their contract (restricted to admin privileges only).

Before this feature, in order to support multiple fees for multiple frontends, we had to duplicate symbols with the exact same name and configuration, differing only in their tradingFees. After upgrading to version 0.8.5 and coordinating the changes with all partners, the old duplicate symbols will be removed.

## Close fee in solvency checks

With the introduction of close fees, the solvency checking logic has been updated to account for this new fee when determining if PartyA will remain solvent after closing a position. The close fee is deducted from PartyA's available balance in the
solvency calculation:

```solidity
// In getAvailableBalanceAfterClosePosition
uint256 closeFee = (filledAmount * closedPrice * quote.closeFee) / 1e36;
partyAAvailableBalance -= int256(closeFee);
```

This is applied in all code paths that check solvency after close:

- fillCloseRequest
- fillCloseRequestToLiquidation (new)
- Force close operations
- Batch close operations

Fill close request to liquidation threshold.

### **FllCloseRequestToLiquidation**

A new method **fillCloseRequestToLiquidation** has been added for PartyB (solvers/hedgers) to handle edge cases where fillCloseRequest would revert due to PartyA insolvency after close.

**The problem:** A user may appear solvent based on their upnl, but become insolvent after the close operation due to the difference between market price and closed price. With the introduction of close fees, this edge case becomes more likely since the
fee adds another factor that can push PartyA into insolvency. When this happens, fillCloseRequest reverts with "LibSolvency: Available balance is lower than zero", leaving positions stuck in CLOSE_PENDING status.

**The solution:** fillCloseRequestToLiquidation calculates and executes the maximum close amount that brings PartyA exactly to the liquidation threshold (available balance = 0). After this partial close, a small market move would make PartyA liquidatable.

```solidity
unction fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig
) external returns (uint256 filledAmount)
```

Usage:

Solvers can use this method for all LIMIT close requests. It behaves identically to fillCloseRequest when PartyA is solvent, but handles the edge case where the close operation would push PartyA into insolvency by performing a partial close instead of
reverting.

Key behaviors:

- Only works with LIMIT orders (MARKET orders must be filled completely)
- If full close is safe, it closes the full quantityToClose
- If full close would make PartyA insolvent, it calculates a partial amount
- Reverts with "Full close keeps PartyA insolvent" if PartyA is so deeply insolvent that even a beneficial close can't help (PartyA should be liquidated instead)
- Reverts with "Cannot close any amount" if PartyA is already insolvent and closing would make it worse

**View function:**

A corresponding view function is available to preview the result before submitting a transaction:

```solidity
function getMaxCloseAmountToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		uint256 marketPrice,
		int256 upnlPartyA
) external view returns (uint256 maxCloseAmount, bool canCloseAll);
```

This returns:

- maxCloseAmount: The amount that will be filled
- canCloseAll: Whether the full quantityToClose can be filled without insolvency
