// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IMuonSignatureVerifier, MuonFunction } from "../interfaces/IMuonSignatureVerifier.sol";

/// @notice Muon signature attesting to a single party's unrealized PnL
struct SingleUpnlSig {
	bytes reqId;
	uint256 timestamp;
	int256 upnl;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Muon signature attesting to a party's UPNL plus their pending withdrawal balance
struct SingleUpnlWithPendingBalanceSig {
	bytes reqId;
	uint256 timestamp;
	int256 upnl;
	uint256 pendingBalance;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Muon signature attesting to a party's UPNL and a symbol's current price
struct SingleUpnlAndPriceSig {
	bytes reqId;
	uint256 timestamp;
	int256 upnl;
	uint256 price;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Muon signature attesting to both PartyA's and PartyB's UPNL
struct PairUpnlSig {
	bytes reqId;
	uint256 timestamp;
	int256 upnlPartyA;
	int256 upnlPartyB;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Muon signature attesting to both parties' UPNL and a single symbol price
struct PairUpnlAndPriceSig {
	bytes reqId;
	uint256 timestamp;
	int256 upnlPartyA;
	int256 upnlPartyB;
	uint256 price;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Muon signature attesting to both parties' UPNL and multiple symbol prices
struct PairUpnlAndPricesSig {
	bytes reqId;
	uint256 timestamp;
	int256 upnlPartyA;
	int256 upnlPartyB;
	uint256[] symbolIds;
	uint256[] prices;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Muon signature for deferred liquidation with historical insolvency data
struct DeferredLiquidationSig {
	bytes reqId; // Unique identifier for the liquidation request
	uint256 timestamp; // Timestamp when the liquidation signature was created
	uint256 liquidationBlockNumber; // Block number at which the user became insolvent
	uint256 liquidationTimestamp; // Timestamp when the user became insolvent
	uint256 liquidationAllocatedBalance; // User's allocated balance at the time of insolvency
	bytes liquidationId; // Unique identifier for the liquidation event
	int256 upnl; // User's unrealized profit and loss at the time of insolvency
	int256 totalUnrealizedLoss; // Total unrealized loss of the user at the time of insolvency
	uint256[] symbolIds; // List of symbol IDs involved in the liquidation
	uint256[] prices; // Corresponding prices of the symbols involved in the liquidation
	bytes gatewaySignature; // Signature from the gateway for verification
	IMuonSignatureVerifier.SchnorrSign sigs; // Schnorr signature for additional verification
}

/// @notice Muon signature for immediate liquidation with current insolvency data
struct LiquidationSig {
	bytes reqId; // Unique identifier for the liquidation request
	uint256 timestamp; // Timestamp when the liquidation signature was created
	bytes liquidationId; // Unique identifier for the liquidation event
	int256 upnl; // User's unrealized profit and loss at the time of insolvency
	int256 totalUnrealizedLoss; // Total unrealized loss of the user at the time of insolvency
	uint256[] symbolIds; // List of symbol IDs involved in the liquidation
	uint256[] prices; // Corresponding prices of the symbols involved in the liquidation
	bytes gatewaySignature; // Signature from the gateway for verification
	IMuonSignatureVerifier.SchnorrSign sigs; // Schnorr signature for additional verification
}

/// @notice Muon-signed price and cumulative funding state for one PartyB-symbol pair in liquidation settlement.
struct LiquidationPartyBSymbolState {
	address partyB;
	uint256 symbolId;
	uint256 price;
	int256 cumulativeLongFee;
	int256 cumulativeShortFee;
}

/// @notice Liquidation signature that freezes historical insolvency data and per-PartyB symbol price/funding state.
struct LiquidationSnapshotSig {
	bytes reqId;
	uint256 timestamp;
	bytes liquidationId;
	int256 upnl;
	int256 totalUnrealizedLoss;
	LiquidationPartyBSymbolState[] states;
	uint256 liquidationBlockNumber;
	uint256 liquidationTimestamp;
	uint256 liquidationAllocatedBalance;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Muon signature attesting to current prices for a set of quotes
struct QuotePriceSig {
	bytes reqId;
	uint256 timestamp;
	uint256[] quoteIds;
	uint256[] prices;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Muon signature with highest/lowest prices over a time window and both parties' UPNL
struct HighLowPriceSig {
	bytes reqId;
	uint256 timestamp;
	uint256 symbolId;
	uint256 highest;
	uint256 lowest;
	uint256 averagePrice;
	uint256 startTime;
	uint256 endTime;
	int256 upnlPartyB;
	int256 upnlPartyA;
	uint256 currentPrice;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Per-quote data within a settlement signature
struct QuoteSettlementData {
	uint256 quoteId;
	uint256 currentPrice;
	uint8 partyBUpnlIndex;
}

/// @notice Muon signature for settling multiple quotes across multiple PartyBs
struct SettlementSig {
	bytes reqId;
	uint256 timestamp;
	QuoteSettlementData[] quotesSettlementsData;
	int256[] upnlPartyBs;
	int256 upnlPartyA;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @notice Per-quote data within a unified settlement, mapping to a PartyA by index
struct UnifiedQuoteSettlementData {
	uint256 quoteId;
	uint256 currentPrice;
	uint8 partyAIndex; // Maps quote to partyAs array index
}

/// @notice Muon signature for unified settlement supporting both normal and cross-PartyB modes
struct UnifiedSettlementSig {
	bytes reqId;
	uint256 timestamp;
	UnifiedQuoteSettlementData[] quotesSettlementsData;
	// PartyB being settled (single - all quotes belong to this partyB)
	address partyB;
	// PartyB UPNL - structure depends on mode
	// For crossPartyB: use upnlPartyB (aggregated)
	// For normal: use upnlPartyBPerPartyA[partyAIndex]
	int256 upnlPartyB; // Aggregated UPNL (crossPartyB mode)
	int256[] upnlPartyBPerPartyA; // Per-partyA UPNLs (normal mode)
	// PartyA data (supports multiple)
	address[] partyAs;
	int256[] upnlPartyAs;
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}

/// @title MuonStorage
/// @notice Configuration for Muon oracle signature verification
/// @dev Muon is the oracle network that provides UPNL, price, and liquidation signatures.
///      These parameters control signature freshness and verification keys.
library MuonStorage {
	bytes32 internal constant MUON_STORAGE_SLOT = keccak256("diamond.standard.storage.muon");

	struct Layout {
		/// @notice How long UPNL signatures remain valid (seconds)
		/// @dev Signatures older than this are rejected. Balance between security
		///      (fresher data) and usability (more time to submit tx).
		uint256 upnlValidTime;
		/// @notice Configured validity period for price signatures (seconds)
		/// @dev Currently stored but NOT actively used in on-chain validation logic.
		///      Price signature validation uses upnlValidTime instead. This field is
		///      configurable via setMuonConfig() for potential future use or off-chain
		///      reference.
		uint256 priceValidTime;
		/// @notice UNUSED - Legacy field kept for storage compatibility
		/// @dev Was for price+quantity validation time. No longer used but cannot be
		///      removed without storage migration.
		uint256 priceQuantityValidTime;
		/// @notice Muon application identifier
		/// @dev Identifies which Muon app generated the signatures. Must match
		///      the deployed Muon app configuration.
		uint256 muonAppId;
		/// @notice DEPRECATED - Public key now managed by external signatureVerifier
		/// @dev Kept for storage layout compatibility. Signature verification is now
		///      delegated to GlobalAppStorage.signatureVerifier contract which manages
		///      its own public key configuration.
		IMuonSignatureVerifier.PublicKey muonPublicKey;
		/// @notice DEPRECATED - Gateway validation now handled by external signatureVerifier
		/// @dev Kept for storage layout compatibility. Gateway signature checks are now
		///      delegated to GlobalAppStorage.signatureVerifier contract.
		address validGateway;
		/// @notice Optional per-Muon-function UPNL signature validity period.
		/// @dev Zero is the unset value. Unset functions use the global upnlValidTime configured by setMuonConfig.
		mapping(MuonFunction => uint256) upnlValidTimeByFunction;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = MUON_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
