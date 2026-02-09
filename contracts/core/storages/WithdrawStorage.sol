// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

struct WithdrawReceiverPart {
	uint256 id;
	uint256 amount;
	int256 chainId;
	bytes receiver;
	address virtualProvider;
	address expressProvider;
}

struct WithdrawRequest {
	uint256 id;
	address user;
	WithdrawReceiverPart[] parts;
	uint256 timestamp;
	uint256 cooldownEndTime;
	WithdrawStatus status;
	bool speedUp;
	bool isCooldownModified;
	address provider;
	bool isPureVirtual;
	bytes providerData;
	uint256 totalAmount;
	uint256 totalVirtualAmount;
}

enum WithdrawStatus {
	PENDING,
	PROVIDER_ACCEPTED,
	PROVIDER_REJECTED,
	COMPLETED,
	CANCEL_REQUESTED,
	CANCELLED,
	SUSPENDED
}

/// @title WithdrawStorage
/// @notice Configuration and state for the new multi-part withdrawal system
/// @dev Supports complex withdrawals across chains with express and virtual providers.
library WithdrawStorage {
	bytes32 internal constant WITHDRAW_STORAGE_SLOT = keccak256("diamond.standard.storage.withdraw");

	struct Layout {
		/// @notice Maximum receiver parts allowed in a single withdrawal request
		/// @dev Limits complexity and gas costs. Users needing more destinations
		///      must submit multiple requests.
		uint256 maxWithdrawParts;
		/// @notice Minimum cooldown even with speed-up approval (seconds)
		/// @dev Even privileged users (solvers) can't reduce cooldown below this.
		///      Ensures some minimum time for monitoring.
		uint256 minWithdrawCooldown;
		/// @notice Blackout period before cooldown expiry during which pure virtual withdrawals cannot be cancelled (seconds)
		uint256 pureVirtualCancelBlackout;
		/// @notice Total balance locked across pending withdrawals and bridge transactions
		/// @dev Subtracted from contract balance to determine available funds. Ensures
		///      new withdrawals/bridges/transfers don't use funds already committed.
		uint256 withdrawLockedBalance;
		/// @notice Auto-incrementing request ID counter per user
		/// @dev Each user's requests are numbered sequentially starting from 1.
		///      Maps user => their next request ID.
		mapping(address => uint256) lastWithdrawRequestId;
		/// @notice All withdrawal requests indexed by user and request ID
		/// @dev Maps user => requestId => WithdrawRequest. The full request data
		///      including all parts and current status.
		mapping(address => mapping(uint256 => WithdrawRequest)) withdrawRequests;
		/// @notice Users allowed to request reduced cooldown periods
		/// @dev Only whitelisted addresses can set speedUp=true when requesting withdrawal.
		///      Typically solvers and other trusted automated systems.
		mapping(address => bool) speedUpWhitelist;
		/// @notice Whitelist of addresses that can act as virtual deposit/withdrawal providers
		/// @dev Virtual providers handle cross-chain deposits and withdrawals. They're trusted
		///      to credit user balances when funds are received on other chains.
		mapping(address => bool) virtualProviders;
		/// @notice Whitelist of addresses that can act as express withdrawal providers
		/// @dev Express providers front withdrawal funds to users immediately, then reclaim
		///      from Symmio after cooldown. They charge fees for this service. Must be
		///      registered here before they can accept withdrawal requests.
		mapping(address => bool) expressProviders;
		/// @notice Disables the legacy withdrawal path when true
		/// @dev The old withdrawal system is being phased out in favor of the new multi-part
		///      withdrawal system. Set this true once all users have migrated.
		bool legacyWithdrawalDeprecated;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = WITHDRAW_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
