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

library WithdrawStorage {
	bytes32 internal constant WITHDRAW_STORAGE_SLOT = keccak256("diamond.standard.storage.withdraw");

	struct Layout {
		uint256 maxWithdrawParts;
		uint256 withdrawCooldownPeriod;
		uint256 minWithdrawCooldown;
		uint256 withdrawLockedBalance;
		mapping(address => uint256) lastWithdrawRequestId;
		mapping(address => mapping(uint256 => WithdrawRequest)) withdrawRequests;
		mapping(address => bool) speedUpWhitelist;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = WITHDRAW_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
