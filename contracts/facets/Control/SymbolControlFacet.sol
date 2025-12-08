// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../utils/Accessibility.sol";
import "../../storages/SymbolStorage.sol";
import "../../storages/AccountStorage.sol";
import "./ISymbolControlFacet.sol";

contract SymbolControlFacet is Accessibility, ISymbolControlFacet {
	/// @notice Adds a new trading symbol.
	/// @param name The name of the trading symbol.
	/// @param minAcceptableQuoteValue The minimum acceptable quote value for the symbol.
	/// @param minAcceptablePortionLF The minimum acceptable portion of liquidation fee in quote.
	/// @param tradingFee The trading fee for the symbol.
	/// @param maxLeverage The maximum leverage allowed for the symbol.
	/// @param fundingRateEpochDuration The duration of each funding rate epoch for the symbol.
	/// @param fundingRateWindowTime The window time for calculating the funding rate.
	function addSymbol(
		string memory name,
		uint256 minAcceptableQuoteValue,
		uint256 minAcceptablePortionLF,
		uint256 tradingFee,
		uint256 maxLeverage,
		uint256 fundingRateEpochDuration,
		uint256 fundingRateWindowTime
	) public onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		require(fundingRateWindowTime < fundingRateEpochDuration / 2, "SymbolControlFacet: High window time");
		require(tradingFee <= 1e18, "SymbolControlFacet: High default fee");
		uint256 lastId = ++SymbolStorage.layout().lastId;
		Symbol memory symbol = Symbol(
			lastId,
			name,
			true,
			minAcceptableQuoteValue,
			minAcceptablePortionLF,
			tradingFee,
			maxLeverage,
			fundingRateEpochDuration,
			fundingRateWindowTime
		);
		SymbolStorage.layout().symbols[lastId] = symbol;
		emit AddSymbol(
			lastId,
			name,
			minAcceptableQuoteValue,
			minAcceptablePortionLF,
			tradingFee,
			maxLeverage,
			fundingRateEpochDuration,
			fundingRateWindowTime
		);
	}

	/// @notice Adds a new trading symbol with its type.
	function addSymbolWithType(
		string memory name,
		uint256 minAcceptableQuoteValue,
		uint256 minAcceptablePortionLF,
		uint256 tradingFee,
		uint256 maxLeverage,
		uint256 fundingRateEpochDuration,
		uint256 fundingRateWindowTime,
		uint256 symbolType
	) public onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		addSymbol(name, minAcceptableQuoteValue, minAcceptablePortionLF, tradingFee, maxLeverage, fundingRateEpochDuration, fundingRateWindowTime);
		uint256 id = SymbolStorage.layout().lastId;
		setSymbolTypeInternal(id, symbolType);
	}

	/// @notice Adds multiple symbols with their types in one call.
	function addSymbolsWithType(SymbolWithType[] memory symbolsWithType) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		for (uint256 i; i < symbolsWithType.length; i++) {
			addSymbol(
				symbolsWithType[i].name,
				symbolsWithType[i].minAcceptableQuoteValue,
				symbolsWithType[i].minAcceptablePortionLF,
				symbolsWithType[i].tradingFee,
				symbolsWithType[i].maxLeverage,
				symbolsWithType[i].fundingRateEpochDuration,
				symbolsWithType[i].fundingRateWindowTime
			);
			uint256 id = SymbolStorage.layout().lastId;
			setSymbolTypeInternal(id, symbolsWithType[i].symbolType);
		}
	}

	/// @notice Adds multiple symbols in one call.
	function addSymbols(Symbol[] memory symbols) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		for (uint256 i; i < symbols.length; i++) {
			addSymbol(
				symbols[i].name,
				symbols[i].minAcceptableQuoteValue,
				symbols[i].minAcceptablePortionLF,
				symbols[i].tradingFee,
				symbols[i].maxLeverage,
				symbols[i].fundingRateEpochDuration,
				symbols[i].fundingRateWindowTime
			);
		}
	}

	/// @notice Sets the funding rate params for a specific symbol.
	function setSymbolFundingState(
		uint256 symbolId,
		uint256 fundingRateEpochDuration,
		uint256 fundingRateWindowTime
	) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		require(fundingRateWindowTime < fundingRateEpochDuration / 2, "SymbolControlFacet: High window time");
		symbolLayout.symbols[symbolId].fundingRateEpochDuration = fundingRateEpochDuration;
		symbolLayout.symbols[symbolId].fundingRateWindowTime = fundingRateWindowTime;
		emit SetSymbolFundingState(symbolId, fundingRateEpochDuration, fundingRateWindowTime);
	}

	/// @notice Validates or invalidates a symbol.
	function setSymbolValidationState(uint256 symbolId, bool isValid) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		emit SetSymbolValidationState(symbolId, symbolLayout.symbols[symbolId].isValid, isValid);
		symbolLayout.symbols[symbolId].isValid = isValid;
	}

	/// @notice Sets the maximum leverage for a specific symbol.
	function setSymbolMaxLeverage(uint256 symbolId, uint256 maxLeverage) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		emit SetSymbolMaxLeverage(symbolId, symbolLayout.symbols[symbolId].maxLeverage, maxLeverage);
		symbolLayout.symbols[symbolId].maxLeverage = maxLeverage;
	}

	/// @notice Sets the minimum acceptable values for a specific symbol.
	function setSymbolAcceptableValues(
		uint256 symbolId,
		uint256 minAcceptableQuoteValue,
		uint256 minAcceptablePortionLF
	) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		emit SetSymbolAcceptableValues(
			symbolId,
			symbolLayout.symbols[symbolId].minAcceptableQuoteValue,
			symbolLayout.symbols[symbolId].minAcceptablePortionLF,
			minAcceptableQuoteValue,
			minAcceptablePortionLF
		);
		symbolLayout.symbols[symbolId].minAcceptableQuoteValue = minAcceptableQuoteValue;
		symbolLayout.symbols[symbolId].minAcceptablePortionLF = minAcceptablePortionLF;
	}

	/// @notice Sets the default fee for a specific symbol.
	function setSymbolTradingFee(uint256 symbolId, uint256 tradingFee) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		emit SetSymbolTradingFee(symbolId, symbolLayout.symbols[symbolId].tradingFee, tradingFee);
		symbolLayout.symbols[symbolId].tradingFee = tradingFee;
	}

	/// @notice Sets the type of a symbol (internal).
	function setSymbolTypeInternal(uint256 symbolId, uint256 symbolType) internal {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		symbolLayout.symbolTypes[symbolId] = symbolType;
		emit SetSymbolType(symbolId, symbolType);
	}

	/// @notice Sets the types of multiple symbols.
	function setSymbolTypes(uint256[] calldata symbolIds, uint256[] calldata symbolTypes) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		require(symbolIds.length == symbolTypes.length, "SymbolControlFacet: Array length mismatch");
		for (uint256 i = 0; i < symbolIds.length; i++) {
			setSymbolTypeInternal(symbolIds[i], symbolTypes[i]);
		}
	}

	/// @notice Whitelists a symbol type for a party B.
	function whitelistSymbolType(address partyB, uint256 symbolType) external {
		symbolListingAuthorizationCheck(msg.sender, partyB);
		AccountStorage.layout().partyBWhitelistedSymbolTypes[partyB][symbolType] = true;
		emit WhitelistSymbolType(partyB, symbolType);
	}

	/// @notice Whitelists symbols for a party B.
	function whitelistSymbols(address partyB, uint256[] calldata symbolIds) external {
		symbolListingAuthorizationCheck(msg.sender, partyB);
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		for (uint256 i; i < symbolIds.length; ) {
			uint256 id = symbolIds[i];
			require(!accountLayout.partyBBlacklistedSymbols[partyB][id], "SymbolControlFacet: Blacklist conflict");
			accountLayout.partyBWhitelistedSymbols[partyB][symbolIds[i]] = true;
			unchecked { ++i; }
		}
		emit WhitelistSymbols(partyB, symbolIds);
	}

	/// @notice Removes a symbol type from the whitelist for a party B.
	function removeSymbolTypeFromWhitelist(address partyB, uint256 symbolType) external {
		symbolListingAuthorizationCheck(msg.sender, partyB);
		AccountStorage.layout().partyBWhitelistedSymbolTypes[partyB][symbolType] = false;
		emit RemoveSymbolTypeFromWhitelist(partyB, symbolType);
	}

	/// @notice Removes symbols from the whitelist for a party B.
	function removeSymbolsFromWhitelist(address partyB, uint256[] calldata symbolIds) external {
		symbolListingAuthorizationCheck(msg.sender, partyB);
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		for (uint256 i; i < symbolIds.length; ) {
			accountLayout.partyBWhitelistedSymbols[partyB][symbolIds[i]] = false;
			unchecked { ++i; }
		}
		emit RemoveSymbolsFromWhitelist(partyB, symbolIds);
	}

	/// @notice Blacklists symbols for a party B.
	function blacklistSymbols(address partyB, uint256[] calldata symbolIds) external {
		symbolListingAuthorizationCheck(msg.sender, partyB);
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		for (uint256 i; i < symbolIds.length; ) {
			uint256 id = symbolIds[i];
			require(!accountLayout.partyBWhitelistedSymbols[partyB][id], "SymbolControlFacet: Whitelist conflict");
			accountLayout.partyBBlacklistedSymbols[partyB][symbolIds[i]] = true;
			unchecked { ++i; }
		}
		emit BlacklistSymbols(partyB, symbolIds);
	}

	/// @notice Removes symbols from the blacklist for a party B.
	function removeSymbolsFromBlacklist(address partyB, uint256[] calldata symbolIds) external {
		symbolListingAuthorizationCheck(msg.sender, partyB);
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		for (uint256 i; i < symbolIds.length; ) {
			accountLayout.partyBBlacklistedSymbols[partyB][symbolIds[i]] = false;
			unchecked { ++i; }
		}
		emit RemoveSymbolsFromBlacklist(partyB, symbolIds);
	}

	function symbolListingAuthorizationCheck(address sender, address partyB) private view {
		require(LibAccessibility.hasRole(sender, LibAccessibility.PARTY_B_MANAGER_ROLE) || sender == partyB, "SymbolControlFacet: Not authorized");
	}
}
