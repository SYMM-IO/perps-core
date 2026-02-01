// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Status of a cross-diamond external transfer
/// @dev Tracks the lifecycle of external transfers between Symmio diamonds.
///      PENDING = initiated but not yet completed/canceled by provider
///      COMPLETED = provider accepted and deposited on target
///      CANCELED = user canceled
enum VirtualExternalTransferStatus {
	PENDING,
	COMPLETED,
	CANCELED
}

/// @notice Transfer request moving funds between Symmio deployments or to other trusted protocols
/// @dev Enables fund movement between different diamonds (e.g., perps and options).
///      Uses virtual providers as intermediaries who deposit on the target diamond.
///      The provider must accept the transfer, or user can cancel after timeout.
struct VirtualExternalTransferRequest {
	uint256 id;
	address sender; // user1 in source contract
	address receiver; // user2 in target contract
	address source;
	address target;
	uint256 amount;
	uint256 timestamp;
	address provider; // virtual provider who handles the transfer
	VirtualExternalTransferStatus status;
}

/// @title ExternalTransferStorage
/// @notice Cross-diamond fund transfers
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library ExternalTransferStorage {
	bytes32 internal constant EXTERNAL_TRANSFER_STORAGE_SLOT = keccak256("diamond.standard.storage.externaltransfer");

	struct Layout {
		/// @notice Counter for external transfer IDs
		/// @dev Auto-incremented when creating external transfers. Used as unique identifier
		///      for each external transfer request.
		uint256 lastExternalTransferId;
		/// @notice Stops cross protocol balance transfers when true
		/// @dev External transfers move funds between different protocols via
		///      relayer contracts. Pause this if the relayers are compromised.
		bool externalTransferPaused;
		/// @notice Relayer contracts authorized for external transfers to specific targets
		/// @dev Maps target address => authorized relayer. The relayer receives
		///      funds and deposits them on the target for the user.
		mapping(address => address) externalTransferTargetsRelayers;
		/// @notice External transfer request data by ID
		/// @dev Stores the full transfer request: sender, receiver, source/target contracts,
		///      amount, provider, and status. Provider must accept or user can cancel.
		mapping(uint256 => VirtualExternalTransferRequest) externalTransfers;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = EXTERNAL_TRANSFER_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
