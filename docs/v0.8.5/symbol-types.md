# **Symbol Types**

At the first day of Symmio we only had Binance pairs available but nowadays we have a lot more like the vibe lowcaps markets. In order to distinguish between them on the contract level and even limit the solvers to only work on a group of symbols we added symbolType to symbol (but in a backward compatible way and with adding a new mapping instead of changing the original symbol structure). The following methods are added to have this functionality:

```solidity
function addSymbolWithType(
		string memory name,
		uint256 minAcceptableQuoteValue,hassle
		uint256 minAcceptablePortionLF,
		uint256 tradingFee,
		uint256 maxLeverage,
		uint256 fundingRateEpochDuration,
		uint256 fundingRateWindowTime,
		uint256 symbolType
	) external;

function setSymbolTypes(uint256[] calldata symbolIds, uint256[] calldata symbolTypes) external;

function setPartyBWhitelistedSymbolTypeStatus(
		address partyB,
		uint256 symbolType,
		bool isWhiteList
	) external;

function getSymbolWithType(uint256 symbolId) external view returns (SymbolWithType memory)

function isWhitelistedSymbolType(address partyB, uint256 symbolType) external view returns (bool)
```

This feature improves risk isolation and regulatory compliance for PartyBs.
