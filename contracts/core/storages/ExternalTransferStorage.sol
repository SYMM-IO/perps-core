// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Status of an external transfer
/// @dev Tracks the lifecycle of external transfers to trusted targets (other Symmio diamonds or external contracts).
///      PENDING = initiated but not yet completed/canceled by provider
///      COMPLETED = provider accepted and deposited on target
///      CANCELED = user canceled
enum VirtualExternalTransferStatus {
	PENDING,
	COMPLETED,
	CANCELED
}

/// @notice Transfer request moving funds to a trusted target via a virtual provider
/// @dev Enables fund movement to any whitelisted target -- another Symmio diamond (e.g., perps and options)
///      or any trusted external contract. Uses virtual providers as intermediaries who credit the receiver
///      on the target. The provider must accept the transfer, or user can cancel.
struct VirtualExternalTransferRequest {
	uint256 id;
	address sender; // user in source contract
	address receiver; // recipient in target contract
	address source;
	address target;
	uint256 amount;
	uint256 timestamp;
	address provider; // virtual provider who handles the transfer
	VirtualExternalTransferStatus status;
}

/// @title ExternalTransferStorage
/// @notice Fund transfers to trusted external targets
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
