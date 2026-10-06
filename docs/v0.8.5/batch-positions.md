# **Batch Position Management**

Under heavy loads, when PartyB is receiving a large number of requests, obtaining a Muon signature for each one and then sending them individually to the contract can slow down solver response times.

To address this, we added **batch methods** to the contract. These methods still require new Muon signatures, but they allow multiple positions to be opened or closed in a single transaction using one **batch signature**.

### **`openPositions` / `fillCloseRequests`**

```solidity
	function openPositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory openedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external;

	function fillCloseRequests(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external;
```
