// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../libraries/LibLockedValues.sol";
import "./QuoteStorage.sol";

library GlobalAppStorage {
	bytes32 internal constant GLOBAL_APP_STORAGE_SLOT = keccak256("diamond.standard.storage.global");

	struct Layout {
		address collateral;
		address defaultFeeCollector;
		bool globalPaused;
		bool liquidationPaused;
		bool accountingPaused;
		bool partyBActionsPaused;
		bool partyAActionsPaused;
		bool emergencyMode;
		uint256 balanceLimitPerUser;
		mapping(address => bool) partyBEmergencyStatus;
		mapping(address => mapping(bytes32 => bool)) hasRole;
		bool internalTransferPaused;
		mapping(address => address) affiliateFeeCollector;
		address signatureVerifier;
		bool externalTransferPaused;
		mapping(address => mapping(uint256 => Fee)) affiliateFee; // affiliate => symbolId => fee
		bool instantLayerPaused;
		bool masterAccountEnabled;
		mapping(address => bool) virtualProviders;
		mapping(address => bool) expressProviders;
		bool deprecateOldWithdrawalPaused;
		uint256 minAffiliateFee;
		mapping(address => mapping(address => mapping(uint256 => Fee))) customAffiliateFee; // affiliate => user => symbolId => fee
		mapping(bytes32 => mapping(address => bool)) roleAdmins; // role => user => admin or not bool
		bool iterativeFundingDeprecationFlag;
		bool accumulativeFundingRateActivationFlag;
		bool partyBOpenPositionsPaused;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = GLOBAL_APP_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
