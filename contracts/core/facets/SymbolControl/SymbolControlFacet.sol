// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { SymbolStorage, Symbol, SymbolWithType } from "../../storages/SymbolStorage.sol";
import { PartyBControlStorage } from "../../storages/PartyBControlStorage.sol";
import { ISymbolControlFacet } from "./ISymbolControlFacet.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";

contract SymbolControlFacet is Accessibility, ISymbolControlFacet {
	/// @notice Adds a new trading symbol (e.g., BTC/USD, ETH/USD) to the protocol with its trading parameters.
	/// @param name The human-readable name of the trading symbol (e.g., "BTCUSD").
	/// @param minAcceptableQuoteValue The minimum notional value (in collateral units) required for a quote on this symbol.
	/// @param minAcceptablePortionLF The minimum portion of the position that must be reserved for liquidation fees (in 1e18 precision).
	/// @param tradingFee The base trading fee percentage (in 1e18 precision) charged when opening/closing positions on this symbol.
	/// @param maxLeverage The maximum leverage multiplier allowed for positions on this symbol (e.g., 100 for 100x).
	/// @param fundingRateEpochDuration The time interval in seconds between funding rate calculations.
	/// @param fundingRateWindowTime The time window in seconds during which funding rate can be applied (must be < epochDuration/2).
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

	/// @notice Batch adds multiple trading symbols with their category types in a single transaction for gas efficiency.
	/// @param symbolsWithType Array of SymbolWithType structs containing symbol parameters and their category types.
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

	/// @notice Batch adds multiple trading symbols in a single transaction for gas efficiency.
	/// @param symbols Array of Symbol structs containing the parameters for each symbol to add.
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

	/// @notice Updates the funding rate timing parameters for a symbol. Funding rates balance long/short positions over time.
	/// @param symbolId The unique identifier of the symbol to update.
	/// @param fundingRateEpochDuration The new time interval in seconds between funding rate calculations.
	/// @param fundingRateWindowTime The new time window in seconds during which funding rate can be applied (must be < epochDuration/2).
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

	/// @notice Enables or disables trading for a symbol. Invalid symbols cannot be used for new quotes.
	/// @param symbolId The unique identifier of the symbol to update.
	/// @param isValid True to enable trading on this symbol, false to disable new positions.
	function setSymbolValidationState(uint256 symbolId, bool isValid) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		emit SetSymbolValidationState(symbolId, symbolLayout.symbols[symbolId].isValid, isValid);
		symbolLayout.symbols[symbolId].isValid = isValid;
	}

	/// @notice Updates the maximum leverage allowed for positions on a specific symbol.
	/// @param symbolId The unique identifier of the symbol to update.
	/// @param maxLeverage The new maximum leverage multiplier (e.g., 100 for 100x leverage).
	function setSymbolMaxLeverage(uint256 symbolId, uint256 maxLeverage) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		emit SetSymbolMaxLeverage(symbolId, symbolLayout.symbols[symbolId].maxLeverage, maxLeverage);
		symbolLayout.symbols[symbolId].maxLeverage = maxLeverage;
	}

	/// @notice Updates the minimum quote and liquidation fee requirements for a symbol. Controls position size minimums.
	/// @param symbolId The unique identifier of the symbol to update.
	/// @param minAcceptableQuoteValue The new minimum notional value (in collateral units) required for quotes on this symbol.
	/// @param minAcceptablePortionLF The new minimum portion reserved for liquidation fees (in 1e18 precision).
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

	/// @notice Updates the base trading fee for a specific symbol. This fee applies when no affiliate-specific fee exists.
	/// @param symbolId The unique identifier of the symbol to update.
	/// @param tradingFee The new base trading fee percentage (in 1e18 precision).
	function setSymbolTradingFee(uint256 symbolId, uint256 tradingFee) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		emit SetSymbolTradingFee(symbolId, symbolLayout.symbols[symbolId].tradingFee, tradingFee);
		symbolLayout.symbols[symbolId].tradingFee = tradingFee;
	}

	/// @notice Internal function to set the category type of a symbol.
	/// @param symbolId The unique identifier of the symbol to update.
	/// @param symbolType The category identifier to assign (e.g., 1 for crypto, 2 for forex).
	function setSymbolTypeInternal(uint256 symbolId, uint256 symbolType) internal {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId >= 1 && symbolId <= symbolLayout.lastId, "SymbolControlFacet: Invalid id");
		symbolLayout.symbolTypes[symbolId] = symbolType;
		emit SetSymbolType(symbolId, symbolType);
	}

	/// @notice Batch updates the category types for multiple symbols in a single transaction.
	/// @param symbolIds Array of symbol identifiers to update.
	/// @param symbolTypes Array of category identifiers corresponding to each symbol (must match symbolIds length).
	function setSymbolTypes(uint256[] calldata symbolIds, uint256[] calldata symbolTypes) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		require(symbolIds.length == symbolTypes.length, "SymbolControlFacet: Array length mismatch");
		for (uint256 i = 0; i < symbolIds.length; i++) {
			setSymbolTypeInternal(symbolIds[i], symbolTypes[i]);
		}
	}

	/// @notice Whitelists an entire category of symbols for a Party B, allowing them to accept quotes for all symbols in that category.
	/// @param partyB The address of the Party B to whitelist the symbol type for.
	/// @param symbolType The category identifier to whitelist (e.g., all crypto symbols).
	function whitelistSymbolType(address partyB, uint256 symbolType) external {
		symbolListingAuthorizationCheck(LibSigner.getSigner(), partyB);
		PartyBControlStorage.layout().partyBWhitelistedSymbolTypes[partyB][symbolType] = true;
		emit WhitelistSymbolType(partyB, symbolType);
	}

	/// @notice Whitelists specific symbols for a Party B, allowing them to accept quotes for those individual symbols.
	/// @param partyB The address of the Party B to whitelist symbols for.
	/// @param symbolIds Array of symbol identifiers to whitelist (cannot conflict with blacklisted symbols).
	function whitelistSymbols(address partyB, uint256[] calldata symbolIds) external {
		symbolListingAuthorizationCheck(LibSigner.getSigner(), partyB);
		PartyBControlStorage.Layout storage partyBControlLayout = PartyBControlStorage.layout();
		for (uint256 i; i < symbolIds.length; ) {
			uint256 id = symbolIds[i];
			require(!partyBControlLayout.partyBBlacklistedSymbols[partyB][id], "SymbolControlFacet: Blacklist conflict");
			partyBControlLayout.partyBWhitelistedSymbols[partyB][symbolIds[i]] = true;
			unchecked {
				++i;
			}
		}
		emit WhitelistSymbols(partyB, symbolIds);
	}

	/// @notice Removes a symbol category from a Party B's whitelist, preventing them from accepting new quotes for that category.
	/// @param partyB The address of the Party B to remove the symbol type whitelist from.
	/// @param symbolType The category identifier to remove from the whitelist.
	function removeSymbolTypeFromWhitelist(address partyB, uint256 symbolType) external {
		symbolListingAuthorizationCheck(LibSigner.getSigner(), partyB);
		PartyBControlStorage.layout().partyBWhitelistedSymbolTypes[partyB][symbolType] = false;
		emit RemoveSymbolTypeFromWhitelist(partyB, symbolType);
	}

	/// @notice Removes specific symbols from a Party B's whitelist, preventing them from accepting new quotes for those symbols.
	/// @param partyB The address of the Party B to remove symbols from whitelist.
	/// @param symbolIds Array of symbol identifiers to remove from the whitelist.
	function removeSymbolsFromWhitelist(address partyB, uint256[] calldata symbolIds) external {
		symbolListingAuthorizationCheck(LibSigner.getSigner(), partyB);
		PartyBControlStorage.Layout storage partyBControlLayout = PartyBControlStorage.layout();
		for (uint256 i; i < symbolIds.length; ) {
			partyBControlLayout.partyBWhitelistedSymbols[partyB][symbolIds[i]] = false;
			unchecked {
				++i;
			}
		}
		emit RemoveSymbolsFromWhitelist(partyB, symbolIds);
	}

	/// @notice Blacklists specific symbols for a Party B, explicitly preventing them from accepting quotes for those symbols.
	/// @param partyB The address of the Party B to blacklist symbols for.
	/// @param symbolIds Array of symbol identifiers to blacklist (cannot conflict with whitelisted symbols).
	function blacklistSymbols(address partyB, uint256[] calldata symbolIds) external {
		symbolListingAuthorizationCheck(LibSigner.getSigner(), partyB);
		PartyBControlStorage.Layout storage partyBControlLayout = PartyBControlStorage.layout();
		for (uint256 i; i < symbolIds.length; ) {
			uint256 id = symbolIds[i];
			require(!partyBControlLayout.partyBWhitelistedSymbols[partyB][id], "SymbolControlFacet: Whitelist conflict");
			partyBControlLayout.partyBBlacklistedSymbols[partyB][symbolIds[i]] = true;
			unchecked {
				++i;
			}
		}
		emit BlacklistSymbols(partyB, symbolIds);
	}

	/// @notice Removes specific symbols from a Party B's blacklist, allowing them to accept quotes for those symbols again.
	/// @param partyB The address of the Party B to remove symbols from blacklist.
	/// @param symbolIds Array of symbol identifiers to remove from the blacklist.
	function removeSymbolsFromBlacklist(address partyB, uint256[] calldata symbolIds) external {
		symbolListingAuthorizationCheck(LibSigner.getSigner(), partyB);
		PartyBControlStorage.Layout storage partyBControlLayout = PartyBControlStorage.layout();
		for (uint256 i; i < symbolIds.length; ) {
			partyBControlLayout.partyBBlacklistedSymbols[partyB][symbolIds[i]] = false;
			unchecked {
				++i;
			}
		}
		emit RemoveSymbolsFromBlacklist(partyB, symbolIds);
	}

	/// @notice Verifies that the sender is authorized to modify symbol listings for a Party B (must be PARTY_B_MANAGER or the Party B itself).
	/// @param sender The address attempting the modification.
	/// @param partyB The Party B whose symbol listings are being modified.
	function symbolListingAuthorizationCheck(address sender, address partyB) private view {
		require(LibAccessibility.hasRole(sender, LibAccessibility.PARTY_B_MANAGER_ROLE) || sender == partyB, "SymbolControlFacet: Not authorized");
	}
}
