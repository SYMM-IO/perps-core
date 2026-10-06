// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import { ISymmio } from "../interfaces/ISymmio.sol";

/// @notice Minimal mock implementing the Symmio subset used by SymmioSymbolManager tests.
/// @dev Named distinctly from contracts/helpers/test/MockSymmio.sol (used by FeeDistributor tests) to avoid TypeChain collisions.
contract MockSymbolManagerSymmio is ISymmio {
	mapping(uint256 => Symbol) public mockSymbols;
	mapping(uint256 => uint256) private symbolForceCloseGapRatios;
	mapping(uint256 => uint256) private symbolMinAcceptableNotionalLFRates;
	mapping(uint256 => bool) private symbolMinAcceptableNotionalLFRateOverrides;
	Symbol[] public symbolList;

	function setMockSymbol(uint256 symbolId, Symbol memory symbol) public {
		mockSymbols[symbolId] = symbol;
		symbolList.push(symbol);
	}

	function getSymbol(uint256 symbolId) external view returns (Symbol memory) {
		return mockSymbols[symbolId];
	}

	function getSymbols(uint256 start, uint256 size) external view returns (Symbol[] memory) {
		uint256 end = start + size;
		if (end > symbolList.length) {
			end = symbolList.length;
		}
		Symbol[] memory result = new Symbol[](end - start);
		for (uint256 i = start; i < end; i++) {
			result[i - start] = symbolList[i];
		}
		return result;
	}

	function setSymbolTradingFee(uint256 symbolId, uint256 tradingFee) external {
		mockSymbols[symbolId].tradingFee = tradingFee;
	}

	function setSymbolValidationState(uint256 symbolId, bool isValid) external {
		mockSymbols[symbolId].isValid = isValid;
	}

	function setSymbolMaxLeverage(uint256 symbolId, uint256 maxLeverage) external {
		mockSymbols[symbolId].maxLeverage = maxLeverage;
	}

	function setSymbolAcceptableValues(uint256 symbolId, uint256 minAcceptableQuoteValue, uint256 minAcceptablePortionLF) external {
		mockSymbols[symbolId].minAcceptableQuoteValue = minAcceptableQuoteValue;
		mockSymbols[symbolId].minAcceptablePortionLF = minAcceptablePortionLF;
	}

	function setSymbolMinAcceptableNotionalLFRate(uint256 symbolId, uint256 minAcceptableNotionalLFRate) external {
		symbolMinAcceptableNotionalLFRates[symbolId] = minAcceptableNotionalLFRate;
		if (symbolId != 0) {
			symbolMinAcceptableNotionalLFRateOverrides[symbolId] = true;
		}
	}

	function clearSymbolMinAcceptableNotionalLFRateOverride(uint256 symbolId) external {
		delete symbolMinAcceptableNotionalLFRates[symbolId];
		delete symbolMinAcceptableNotionalLFRateOverrides[symbolId];
	}

	function getSymbolMinAcceptableNotionalLFRate(uint256 symbolId) external view returns (uint256 rate, bool hasOverride) {
		hasOverride = symbolId != 0 && symbolMinAcceptableNotionalLFRateOverrides[symbolId];
		rate = hasOverride ? symbolMinAcceptableNotionalLFRates[symbolId] : symbolMinAcceptableNotionalLFRates[0];
	}

	function setSymbolFundingState(uint256 symbolId, uint256 fundingRateEpochDuration, uint256 fundingRateWindowTime) external {
		mockSymbols[symbolId].fundingRateEpochDuration = fundingRateEpochDuration;
		mockSymbols[symbolId].fundingRateWindowTime = fundingRateWindowTime;
	}

	function setForceCloseGapRatio(uint256 symbolId, uint256 _forceCloseGapRatio) external {
		symbolForceCloseGapRatios[symbolId] = _forceCloseGapRatio;
	}

	function forceCloseGapRatio(uint256 symbolId) external view returns (uint256) {
		return symbolForceCloseGapRatios[symbolId];
	}

	function addSymbols(Symbol[] memory _symbols) external {
		for (uint256 i = 0; i < _symbols.length; i++) {
			mockSymbols[_symbols[i].symbolId] = _symbols[i];
			symbolList.push(_symbols[i]);
		}
	}

	function addSymbolsWithType(SymbolWithType[] memory _symbolsWithType) external {
		for (uint256 i = 0; i < _symbolsWithType.length; i++) {
			Symbol memory s = Symbol({
				symbolId: _symbolsWithType[i].symbolId,
				name: _symbolsWithType[i].name,
				isValid: _symbolsWithType[i].isValid,
				minAcceptableQuoteValue: _symbolsWithType[i].minAcceptableQuoteValue,
				minAcceptablePortionLF: _symbolsWithType[i].minAcceptablePortionLF,
				tradingFee: _symbolsWithType[i].tradingFee,
				maxLeverage: _symbolsWithType[i].maxLeverage,
				fundingRateEpochDuration: _symbolsWithType[i].fundingRateEpochDuration,
				fundingRateWindowTime: _symbolsWithType[i].fundingRateWindowTime
			});
			mockSymbols[_symbolsWithType[i].symbolId] = s;
			symbolList.push(s);
		}
	}
}
