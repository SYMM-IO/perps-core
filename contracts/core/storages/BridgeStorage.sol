// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Record of a user's fast withdrawal via a trusted bridge
/// @dev Bridges allow users to bypass the deallocate cooldown. Flow:
///      1. User calls transferToBridge(amount, bridge) to request fast withdrawal
///      2. Bridge immediately sends funds to user's wallet outside SYMMIO
///      3. After cooldown passes, bridge calls withdrawReceivedBridgeValue() to claim funds
///      4. If user misconduct detected, transaction can be suspended/restored with reduced amount
struct BridgeTransaction {
	/// @notice Unique transaction identifier
	uint256 id;
	/// @notice Amount user transferred to the bridge
	uint256 amount;
	/// @notice User who requested the fast withdrawal
	address user;
	/// @notice Bridge contract that will receive the funds after cooldown
	address bridge;
	/// @notice When the transfer was initiated
	uint256 timestamp;
	/// @notice Current state of this withdrawal request
	BridgeTransactionStatus status;
}

/// @notice Lifecycle state of a bridge withdrawal request
/// @dev RECEIVED = User transferred funds, waiting for bridge to withdraw after cooldown
///      SUSPENDED = Frozen due to suspected user misconduct, bridge cannot withdraw
///      WITHDRAWN = Bridge has successfully withdrawn the funds from SYMMIO
enum BridgeTransactionStatus {
	RECEIVED,
	SUSPENDED,
	WITHDRAWN
}

/// @title BridgeStorage
/// @notice Fast withdrawal system allowing users to bypass deallocate cooldown
/// @dev Trusted bridges advance funds to users immediately, then claim from SYMMIO after
///      cooldown. The bridge bears the risk - if user misconduct is detected, the transaction
///      is suspended and the bridge may only recover a reduced amount after restoration.
library BridgeStorage {
	bytes32 internal constant BRIDGE_STORAGE_SLOT = keccak256("diamond.standard.storage.bridge");

	struct Layout {
		/// @notice Addresses authorized to operate as bridges
		/// @dev Only registered bridges can receive transfers via transferToBridge().
		///      Bridges must be highly trusted - they advance real funds to users.
		mapping(address => bool) bridges;
		/// @notice All bridge transactions by ID
		/// @dev Complete record of every fast withdrawal request including current status.
		mapping(uint256 => BridgeTransaction) bridgeTransactions;
		/// @notice Transaction IDs grouped by bridge
		/// @dev Maps bridge address => transaction IDs[]. Allows bridges to query
		///      all their pending withdrawals.
		mapping(address => uint256[]) bridgeTransactionIds;
		/// @notice Counter for generating transaction IDs
		/// @dev Incremented for each new transferToBridge() call.
		uint256 lastId;
		/// @notice Destination for funds from invalid/suspended transactions
		/// @dev When restoreBridgeTransaction() is called with validAmount < original amount,
		///      the difference (invalid portion) is sent here instead of back to the bridge.
		address invalidBridgedAmountsPool;
		/// @notice Additional metadata per transaction
		/// @dev Maps transactionId => arbitrary data. Reserved for future use.
		mapping(uint256 => bytes) bridgesData;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = BRIDGE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
