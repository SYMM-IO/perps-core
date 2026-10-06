# Aggregated Positions And Fundings For Better UPNL Calculation

This version introduces **on-chain aggregated position tracking** that enables efficient UPNL (Unrealized Profit and Loss) calculations with **O(symbols)** complexity instead of **O(quotes)**.

Previously, calculating UPNL required iterating through all individual quotes. With potentially thousands of quotes per party, this was computationally expensive. The new aggregated position system maintains running totals at the symbol level, dramatically reducing the data needed for UPNL calculations.

## How It Works

### Aggregated Position Storage

For each (party, symbol, positionType) combination, the system tracks:

- **aggregatedAmount**: Total open position size
- **aggregatedNotional**: Sum of (amount × openPrice) for all positions

The **average open price** is derived as: `avgOpenPrice = aggregatedNotional / aggregatedAmount`

### Aggregated Funding Storage

For each (party, symbol, positionType) combination, the system tracks:

- **weightedPaidFunding**: Sum of (openAmount × accumulatedPaidFunding / 1e18) across all quotes

This allows computing funding debt without iterating through individual quotes.

### Active Symbols Tracking

The system maintains arrays of active symbol IDs for each party:

- `partyBActiveSymbols[partyB]` - Global symbols where partyB has positions
- `partyBActiveSymbolsPerPartyA[partyB][partyA]` - Symbols for a specific partyA
- `partyAActiveSymbolsPerPartyB[partyA][partyB]` - Symbols for a specific partyB

This enables efficient iteration through only the relevant symbols.

## View Functions

### Position Aggregates

| Function | Description |
| --- | --- |
| `getPartyBAggregatedPositionBySymbol` | PartyB's global position for a symbol |
| `getPartyBAggregatedPositionBySymbolPerPartyA` | PartyB's position with specific partyA |
| `getPartyAAggregatedPositionBySymbolPerPartyB` | PartyA's position with specific partyB |

### Funding Aggregates

| Function | Description |
| --- | --- |
| `getPartyAAggregateFundingDebt` | PartyA's funding debt for a symbol |
| `getPartyBAggregateFundingDebt` | PartyB's funding debt per partyA |
| `getPartyBGlobalAggregateFundingDebt` | PartyB's global funding debt |

### Paginated Batch Functions

| Function | Description |
| --- | --- |
| `getPartyBAggregatedPositionsByActiveSymbols` | Paginated positions across active symbols |
| `getPartyAAggregatedPositionsByActiveSymbolsPerPartyB` | PartyA positions with partyB |
| `getPartyBAggregatedPositionsByActiveSymbolsPerPartyA` | PartyB positions with partyA |
| `getPartyAAggregateFundingDebtByActiveSymbols` | Paginated funding debt for partyA |
| `getPartyBAggregateFundingDebtByActiveSymbols` | Paginated funding debt for partyB |
| `getPartyBGlobalAggregateFundingDebtByActiveSymbols` | Global paginated funding for partyB |

### Active Symbol Queries

| Function | Description |
| --- | --- |
| `getPartyBActiveSymbolsCount` | Count of partyB's active symbols |
| `getPartyBActiveSymbols` | Paginated list of partyB's active symbol IDs |
| `getPartyAActiveSymbolsCountPerPartyB` | Count of partyA's symbols with partyB |
| `getPartyAActiveSymbolsPerPartyB` | Paginated partyA symbol IDs with partyB |

### UPNL Data Functions (Recommended)

These convenience functions return **both position data and funding debt in a single call**, eliminating the need to fetch positions and funding separately:

| Function | Description |
| --- | --- |
| `getPartyAUpnlData` | PartyA's position + funding data per partyB |
| `getPartyBUpnlData` | PartyB's position + funding data per partyA |
| `getPartyBGlobalUpnlData` | PartyB's global position + funding data |

Each returns an array of `UpnlData`:

```solidity
struct UpnlData {
    uint256 symbolId;
    PositionType positionType;
    uint256 aggregatedAmount;
    uint256 avgOpenPrice;
    int256 fundingDebt;
}
```

## UPNL Calculation

With aggregated data, UPNL can be calculated off-chain as:

```
UPNL = Position UPNL + Funding Debt

Position UPNL (per symbol):
  LONG:  (currentPrice - avgOpenPrice) × aggregatedAmount / 1e18
  SHORT: (avgOpenPrice - currentPrice) × aggregatedAmount / 1e18

Total UPNL = Σ(Position UPNL for each active symbol) + Σ(Funding Debt for each active symbol)
```

## Usage Example

### PartyA UPNL (with specific PartyB)

```solidity
int256 totalUpnl = 0;
uint256 start = 0;

while (true) {
    UpnlData[] memory data = viewFacet.getPartyAUpnlData(partyA, partyB, start, 100);
    if (data.length == 0) break;

    for (uint256 i = 0; i < data.length; i++) {
        uint256 price = getPrice(data[i].symbolId);
        int256 positionUpnl;

        if (data[i].positionType == PositionType.LONG) {
            positionUpnl = int256((price - data[i].avgOpenPrice) * data[i].aggregatedAmount / 1e18);
        } else {
            positionUpnl = int256((data[i].avgOpenPrice - price) * data[i].aggregatedAmount / 1e18);
        }

        totalUpnl += positionUpnl - data[i].fundingDebt;
    }
    start += 100;
}
```
