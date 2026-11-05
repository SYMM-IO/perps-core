// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

import { ISymmio } from "./interfaces/ISymmio.sol";
import { AccessControlEnumerable } from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title SymmioSymbolManager
/// @notice Manages symbols and their properties for the Symmio protocol
/// @dev Implements role-based access control and daily operation limits
contract SymmioSymbolManager is AccessControlEnumerable, Pausable {
	// ------------------------------------------------------------------------------------------ //
	//                                      Roles & Constants                                     //
	// ------------------------------------------------------------------------------------------ //

	bytes32 public constant SYMBOL_ADDER_ROLE = keccak256("SYMBOL_ADDER_ROLE");
	bytes32 public constant SYMBOL_REMOVER_ROLE = keccak256("SYMBOL_REMOVER_ROLE");
	bytes32 public constant SYMBOL_TRADING_FEE_MANAGER_ROLE = keccak256("SYMBOL_TRADING_FEE_MANAGER_ROLE");
	bytes32 public constant SYMBOL_MAX_LEVERAGE_MANAGER_ROLE = keccak256("SYMBOL_MAX_LEVERAGE_MANAGER_ROLE");
	bytes32 public constant SYMBOL_FUNDING_STATE_MANAGER_ROLE = keccak256("SYMBOL_FUNDING_STATE_MANAGER_ROLE");
	bytes32 public constant SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE = keccak256("SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE");
	bytes32 public constant SYMBOL_FORCE_CLOSE_GAP_RATIO_MANAGER_ROLE = keccak256("SYMBOL_FORCE_CLOSE_GAP_RATIO_MANAGER_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	// ------------------------------------------------------------------------------------------ //
	//                                      Struct Definitions                                    //
	// ------------------------------------------------------------------------------------------ //

	/// @notice Stores daily limits for different operations
	/// @dev Used to prevent excessive modifications within a 24-hour period
	struct Operations {
		uint256 symbolAddition;
		uint256 tradingFee;
		uint256 validationState;
		uint256 maxLeverage;
		uint256 acceptableValues;
		uint256 fundingState;
		uint256 forceCloseGapRatio;
	}

	// ------------------------------------------------------------------------------------------ //
	//                                      State Variables                                       //
	// ------------------------------------------------------------------------------------------ //

	address public symmioAddress;
	Operations public dailyLimits;
	Operations public dailyOperations;
	uint256 public lastResetTimestamp;
	uint256 public minForceCloseGapRatio;
	uint256 public maxForceCloseGapRatio;

	/// @notice Stores unique hashes of symbol properties to prevent duplicates
	mapping(bytes32 => bool) public addedSymbolHashes;
	/// @notice Array of all symbol hashes for tracking purposes
	bytes32[] public symbolHashes;

	// ------------------------------------------------------------------------------------------ //
	//                                            Errors                                          //
	// ------------------------------------------------------------------------------------------ //

	error DailyLimitExceeded(string operation, uint256 attempted, uint256 remaining);
	error InvalidSymbolsList();
	error DuplicateSymbol(string name);
	error InvalidArrayLengths();
	error InvalidForceCloseGapRatio(uint256 value, uint256 min, uint256 max);
	error InvalidForceCloseGapRatioBounds(uint256 min, uint256 max);

	// ------------------------------------------------------------------------------------------ //
	//                                            Events                                          //
	// ------------------------------------------------------------------------------------------ //

	event DailyLimitsUpdated(Operations limits);
	event SymbolsAdded(uint256 count);
	event SymbolHashesCleared(address account);
	event SymmioSymbolsLoaded(uint256 start, uint256 size);
	event BatchOperationExecuted(string operationType, uint256[] symbolIds);
	event DailyOperationsReset();
	event ForceCloseGapRatioBoundsUpdated(uint256 min, uint256 max);

	// ------------------------------------------------------------------------------------------ //
	//                                        Constructor                                         //
	// ------------------------------------------------------------------------------------------ //

	/// @notice Initializes the contract with initial roles and limits
	/// @param _symmioAddress Address of the main Symmio contract
	/// @param admin Address to be granted admin role
	constructor(address _symmioAddress, address admin) {
		symmioAddress = _symmioAddress;
		lastResetTimestamp = block.timestamp;
		dailyLimits = Operations(25, 25, 25, 25, 25, 25, 25);

		_grantRole(DEFAULT_ADMIN_ROLE, admin);

		dailyOperations = Operations(0, 0, 0, 0, 0, 0, 0);

		minForceCloseGapRatio = 50000000000000;
		maxForceCloseGapRatio = 20000000000000000;

		emit ForceCloseGapRatioBoundsUpdated(minForceCloseGapRatio, maxForceCloseGapRatio);
		emit DailyLimitsUpdated(dailyLimits);
	}

	// ------------------------------------------------------------------------------------------ //
	//                                       Internal Logic                                       //
	// ------------------------------------------------------------------------------------------ //

	/// @notice Checks and updates daily operation limits
	/// @dev Resets counters if 24 hours have passed since last reset
	/// @param operation Name of the operation being performed
	/// @param count Number of operations being attempted
	/// @param limit Maximum allowed operations per day
	/// @param current Current count of operations today
	/// @return Updated operation count
	function checkAndUpdateDailyLimit(string memory operation, uint256 count, uint256 limit, uint256 current) internal returns (uint256) {
		if (block.timestamp >= lastResetTimestamp + 1 days) {
			dailyOperations = Operations(0, 0, 0, 0, 0, 0, 0);
			lastResetTimestamp = block.timestamp;
			emit DailyOperationsReset();
			current = 0;
		}

		if (current + count > limit) {
			revert DailyLimitExceeded(operation, count, limit - current);
		}

		return current + count;
	}

	// ------------------------------------------------------------------------------------------ //
	//                                    Pausing Functionality                                   //
	// ------------------------------------------------------------------------------------------ //

	/// @notice Pauses all contract operations
	/// @dev Can only be called by accounts with PAUSER_ROLE
	function pause() external whenNotPaused onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/// @notice Unpauses contract operations
	/// @dev Can only be called by accounts with UNPAUSER_ROLE
	function unpause() external whenPaused onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	// ------------------------------------------------------------------------------------------ //
	//                                  Symbol Management (Add/Mod)                               //
	// ------------------------------------------------------------------------------------------ //

	/// @notice Adds new trading symbols to the system
	/// @dev Checks for duplicates using symbol hashes
	/// @param symbols Array of Symbol structs to be added
	function addSymbols(ISymmio.Symbol[] memory symbols) external whenNotPaused onlyRole(SYMBOL_ADDER_ROLE) {
		uint256 symbolsLength = symbols.length;
		if (symbolsLength == 0) revert InvalidSymbolsList();

		dailyOperations.symbolAddition = checkAndUpdateDailyLimit(
			"symbolAddition",
			symbolsLength,
			dailyLimits.symbolAddition,
			dailyOperations.symbolAddition
		);

		for (uint256 i = 0; i < symbolsLength;) {
			ISymmio.Symbol memory symbol = symbols[i];
			bytes32 symbolHash = computeSymbolHash(symbol);
			if (addedSymbolHashes[symbolHash]) revert DuplicateSymbol(symbol.name);

			addedSymbolHashes[symbolHash] = true;
			symbolHashes.push(symbolHash);

			unchecked {
				++i;
			}
		}

		ISymmio(symmioAddress).addSymbols(symbols);
		emit SymbolsAdded(symbolsLength);
	}

	/// @notice Adds new trading symbols with their market category types to the system
	/// @dev Checks for duplicates using symbol hashes
	/// @param symbolsWithType Array of SymbolWithType structs to be added
	function addSymbolsWithType(ISymmio.SymbolWithType[] memory symbolsWithType) external whenNotPaused onlyRole(SYMBOL_ADDER_ROLE) {
		uint256 symbolsLength = symbolsWithType.length;
		if (symbolsLength == 0) revert InvalidSymbolsList();

		dailyOperations.symbolAddition = checkAndUpdateDailyLimit(
			"symbolAddition",
			symbolsLength,
			dailyLimits.symbolAddition,
			dailyOperations.symbolAddition
		);

		for (uint256 i = 0; i < symbolsLength;) {
			ISymmio.SymbolWithType memory symbol = symbolsWithType[i];
			bytes32 symbolHash = computeSymbolWithTypeHash(symbol);
			if (addedSymbolHashes[symbolHash]) revert DuplicateSymbol(symbol.name);

			addedSymbolHashes[symbolHash] = true;
			symbolHashes.push(symbolHash);

			unchecked {
				++i;
			}
		}

		ISymmio(symmioAddress).addSymbolsWithType(symbolsWithType);
		emit SymbolsAdded(symbolsLength);
	}

	/// @notice Updates trading fees for multiple symbols
	/// @param symbolIds Array of symbol IDs to update
	/// @param tradingFees Array of new trading fee values
	function setSymbolTradingFeeBatch(
		uint256[] memory symbolIds,
		uint256[] memory tradingFees
	) external whenNotPaused onlyRole(SYMBOL_TRADING_FEE_MANAGER_ROLE) {
		if (symbolIds.length != tradingFees.length) revert InvalidArrayLengths();

		dailyOperations.tradingFee = checkAndUpdateDailyLimit("tradingFee", symbolIds.length, dailyLimits.tradingFee, dailyOperations.tradingFee);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).setSymbolTradingFee(symbolIds[i], tradingFees[i]);
		}

		emit BatchOperationExecuted("tradingFee", symbolIds);
	}

	/// @notice Updates validation states for multiple symbols to true
	/// @param symbolIds Array of symbol IDs to update
	function activateSymbols(uint256[] memory symbolIds) external whenNotPaused onlyRole(SYMBOL_ADDER_ROLE) {
		dailyOperations.validationState = checkAndUpdateDailyLimit(
			"activateSymbols",
			symbolIds.length,
			dailyLimits.validationState,
			dailyOperations.validationState
		);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).setSymbolValidationState(symbolIds[i], true);
		}

		emit BatchOperationExecuted("activateSymbols", symbolIds);
	}

	/// @notice Updates validation states for multiple symbols to false
	/// @param symbolIds Array of symbol IDs to update
	function deactivateSymbols(uint256[] memory symbolIds) external whenNotPaused onlyRole(SYMBOL_REMOVER_ROLE) {
		dailyOperations.validationState = checkAndUpdateDailyLimit(
			"deactivateSymbols",
			symbolIds.length,
			dailyLimits.validationState,
			dailyOperations.validationState
		);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).setSymbolValidationState(symbolIds[i], false);
		}

		emit BatchOperationExecuted("deactivateSymbols", symbolIds);
	}

	/// @notice Updates maximum leverage values for multiple symbols
	/// @param symbolIds Array of symbol IDs to update
	/// @param maxLeverages Array of new maximum leverage values
	function setSymbolMaxLeverageBatch(
		uint256[] memory symbolIds,
		uint256[] memory maxLeverages
	) external whenNotPaused onlyRole(SYMBOL_MAX_LEVERAGE_MANAGER_ROLE) {
		if (symbolIds.length != maxLeverages.length) revert InvalidArrayLengths();

		dailyOperations.maxLeverage = checkAndUpdateDailyLimit("maxLeverage", symbolIds.length, dailyLimits.maxLeverage, dailyOperations.maxLeverage);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).setSymbolMaxLeverage(symbolIds[i], maxLeverages[i]);
		}

		emit BatchOperationExecuted("maxLeverage", symbolIds);
	}

	/// @notice Updates acceptable values for multiple symbols
	/// @param symbolIds Array of symbol IDs to update
	/// @param minAcceptableQuoteValues Array of new minimum acceptable quote values
	/// @param minAcceptablePortionLFs Array of new minimum acceptable portion LFs
	function setSymbolAcceptableValuesBatch(
		uint256[] memory symbolIds,
		uint256[] memory minAcceptableQuoteValues,
		uint256[] memory minAcceptablePortionLFs
	) external whenNotPaused onlyRole(SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE) {
		if (symbolIds.length != minAcceptableQuoteValues.length || symbolIds.length != minAcceptablePortionLFs.length) {
			revert InvalidArrayLengths();
		}

		dailyOperations.acceptableValues = checkAndUpdateDailyLimit(
			"acceptableValues",
			symbolIds.length,
			dailyLimits.acceptableValues,
			dailyOperations.acceptableValues
		);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).setSymbolAcceptableValues(symbolIds[i], minAcceptableQuoteValues[i], minAcceptablePortionLFs[i]);
		}

		emit BatchOperationExecuted("acceptableValues", symbolIds);
	}

	/// @notice Sets default or symbol-specific minimum LF rates against notional.
	/// @dev Uses the existing minimum-acceptable-values role and daily limit. Symbol 0 updates the live default;
	///      nonzero symbols create explicit overrides.
	function setSymbolMinAcceptableNotionalLFRatesBatch(
		uint256[] memory symbolIds,
		uint256[] memory minAcceptableNotionalLFRates
	) external whenNotPaused onlyRole(SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE) {
		if (symbolIds.length != minAcceptableNotionalLFRates.length) revert InvalidArrayLengths();

		dailyOperations.acceptableValues = checkAndUpdateDailyLimit(
			"acceptableValues",
			symbolIds.length,
			dailyLimits.acceptableValues,
			dailyOperations.acceptableValues
		);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).setSymbolMinAcceptableNotionalLFRate(symbolIds[i], minAcceptableNotionalLFRates[i]);
		}

		emit BatchOperationExecuted("notionalLFRates", symbolIds);
	}

	/// @notice Clears symbol-specific notional LF rates so the symbols inherit the symbol-0 default.
	function clearSymbolMinAcceptableNotionalLFRateOverrides(
		uint256[] memory symbolIds
	) external whenNotPaused onlyRole(SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE) {
		dailyOperations.acceptableValues = checkAndUpdateDailyLimit(
			"acceptableValues",
			symbolIds.length,
			dailyLimits.acceptableValues,
			dailyOperations.acceptableValues
		);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).clearSymbolMinAcceptableNotionalLFRateOverride(symbolIds[i]);
		}

		emit BatchOperationExecuted("clearNotionalLFRateOverrides", symbolIds);
	}

	/// @notice Updates funding states for multiple symbols
	/// @param symbolIds Array of symbol IDs to update
	/// @param fundingRateEpochDurations Array of new funding rate epoch durations
	/// @param fundingRateWindowTimes Array of new funding rate window times
	function setSymbolFundingStateBatch(
		uint256[] memory symbolIds,
		uint256[] memory fundingRateEpochDurations,
		uint256[] memory fundingRateWindowTimes
	) external whenNotPaused onlyRole(SYMBOL_FUNDING_STATE_MANAGER_ROLE) {
		if (symbolIds.length != fundingRateEpochDurations.length || symbolIds.length != fundingRateWindowTimes.length) {
			revert InvalidArrayLengths();
		}

		dailyOperations.fundingState = checkAndUpdateDailyLimit(
			"fundingState",
			symbolIds.length,
			dailyLimits.fundingState,
			dailyOperations.fundingState
		);

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).setSymbolFundingState(symbolIds[i], fundingRateEpochDurations[i], fundingRateWindowTimes[i]);
		}

		emit BatchOperationExecuted("fundingState", symbolIds);
	}

	/// @notice Updates force close gap ratios for multiple symbols
	/// @param symbolIds Array of symbol IDs to update
	/// @param forceCloseGapRatios Array of new force close gap ratios
	function setForceCloseGapRatioBatch(
		uint256[] memory symbolIds,
		uint256[] memory forceCloseGapRatios
	) external whenNotPaused onlyRole(SYMBOL_FORCE_CLOSE_GAP_RATIO_MANAGER_ROLE) {
		if (symbolIds.length != forceCloseGapRatios.length) revert InvalidArrayLengths();

		uint256 validOperations = 0;
		for (uint256 i = 0; i < symbolIds.length; i++) {
			if (forceCloseGapRatios[i] < minForceCloseGapRatio || forceCloseGapRatios[i] > maxForceCloseGapRatio) {
				revert InvalidForceCloseGapRatio(forceCloseGapRatios[i], minForceCloseGapRatio, maxForceCloseGapRatio);
			}

			// Only count non-zero to non-zero changes against daily limit
			uint256 currentRatio = ISymmio(symmioAddress).forceCloseGapRatio(symbolIds[i]);
			if (currentRatio != 0) {
				validOperations++;
			}
		}

		// Only check daily limit for non-zero to non-zero changes
		if (validOperations > 0) {
			dailyOperations.forceCloseGapRatio = checkAndUpdateDailyLimit(
				"forceCloseGapRatio",
				validOperations,
				dailyLimits.forceCloseGapRatio,
				dailyOperations.forceCloseGapRatio
			);
		}

		for (uint256 i = 0; i < symbolIds.length; i++) {
			ISymmio(symmioAddress).setForceCloseGapRatio(symbolIds[i], forceCloseGapRatios[i]);
		}

		emit BatchOperationExecuted("forceCloseGapRatio", symbolIds);
	}

	// ------------------------------------------------------------------------------------------ //
	//                                Force Close Gap Ratio Setters                               //
	// ------------------------------------------------------------------------------------------ //

	/// @notice Updates the allowed bounds for force close gap ratios
	/// @param _minForceCloseGapRatio New minimum ratio
	/// @param _maxForceCloseGapRatio New maximum ratio
	function setForceCloseGapRatioBounds(uint256 _minForceCloseGapRatio, uint256 _maxForceCloseGapRatio) external onlyRole(SETTER_ROLE) {
		if (_minForceCloseGapRatio >= _maxForceCloseGapRatio) {
			revert InvalidForceCloseGapRatioBounds(_minForceCloseGapRatio, _maxForceCloseGapRatio);
		}
		minForceCloseGapRatio = _minForceCloseGapRatio;
		maxForceCloseGapRatio = _maxForceCloseGapRatio;

		emit ForceCloseGapRatioBoundsUpdated(_minForceCloseGapRatio, _maxForceCloseGapRatio);
	}

	// ------------------------------------------------------------------------------------------ //
	//                                      Other Functions                                       //
	// ------------------------------------------------------------------------------------------ //

	/// @notice Computes a unique hash for a symbol based on its properties
	/// @param symbol Symbol struct containing all symbol properties
	/// @return bytes32 Hash of the symbol's properties
	function computeSymbolHash(ISymmio.Symbol memory symbol) internal pure returns (bytes32) {
		return
			keccak256(
				abi.encodePacked(
					symbol.symbolId,
					symbol.name,
					symbol.minAcceptableQuoteValue,
					symbol.minAcceptablePortionLF,
					symbol.tradingFee,
					symbol.maxLeverage,
					symbol.fundingRateEpochDuration,
					symbol.fundingRateWindowTime
				)
			);
	}

	/// @notice Computes a unique hash for a symbol with type based on its properties
	/// @param symbol SymbolWithType struct containing all symbol properties including type
	/// @return bytes32 Hash of the symbol's properties
	function computeSymbolWithTypeHash(ISymmio.SymbolWithType memory symbol) internal pure returns (bytes32) {
		return
			keccak256(
				abi.encodePacked(
					symbol.symbolId,
					symbol.name,
					symbol.minAcceptableQuoteValue,
					symbol.minAcceptablePortionLF,
					symbol.tradingFee,
					symbol.maxLeverage,
					symbol.fundingRateEpochDuration,
					symbol.fundingRateWindowTime,
					symbol.symbolType
				)
			);
	}

	/// @notice Clears all stored symbol hashes
	/// @dev Can only be called by accounts with SETTER_ROLE
	function clearSymbolHashes() external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < symbolHashes.length; i++) {
			delete addedSymbolHashes[symbolHashes[i]];
		}
		delete symbolHashes;

		emit SymbolHashesCleared(msg.sender);
	}

	/// @notice Loads symbols from the Symmio contract into local storage
	/// @param start Starting index for loading symbols
	/// @param size Number of symbols to load
	function loadSymmioSymbols(uint256 start, uint256 size) external onlyRole(SETTER_ROLE) {
		ISymmio.Symbol[] memory symbols = ISymmio(symmioAddress).getSymbols(start, size);
		for (uint256 i = 0; i < symbols.length; i++) {
			bytes32 symbolHash = computeSymbolHash(symbols[i]);
			if (!addedSymbolHashes[symbolHash]) {
				addedSymbolHashes[symbolHash] = true;
				symbolHashes.push(symbolHash);
			}
		}

		emit SymmioSymbolsLoaded(start, size);
	}

	// ------------------------------------------------------------------------------------------ //
	//                                   Daily Limit Management                                   //
	// ------------------------------------------------------------------------------------------ //

	/// @notice Updates the daily operation limits for all operations
	/// @dev Only callable by accounts with SETTER_ROLE
	/// @param _limits New daily limits for all operations
	function setDailyLimits(Operations memory _limits) external onlyRole(SETTER_ROLE) {
		dailyLimits = _limits;
		emit DailyLimitsUpdated(_limits);
	}

	/// @notice Retrieves the current daily operation limits
	/// @return DailyLimits struct containing the maximum values for all operations
	function getDailyLimits() external view returns (Operations memory) {
		return dailyLimits;
	}

	/// @notice Retrieves the current count of operations performed today
	/// @return DailyOperations struct containing the number of operations performed in the current day
	function getDailyOperations() external view returns (Operations memory) {
		return dailyOperations;
	}
}
