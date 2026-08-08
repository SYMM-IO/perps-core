// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

library SharedEvents {
	enum BalanceChangeType {
		ALLOCATE,
		DEALLOCATE,
		PLATFORM_FEE_IN,
		PLATFORM_FEE_OUT,
		REALIZED_PNL_IN,
		REALIZED_PNL_OUT,
		CVA_IN,
		CVA_OUT,
		LF_IN,
		LF_OUT,
		FUNDING_FEE_IN,
		FUNDING_FEE_OUT,
		DEFERRED_BALANCE_IN,
		DEFERRED_BALANCE_OUT,
		REIMBURSEMENT_IN,
		OPERATIONAL_FEE_OUT,
		OPEN_SOLVER_FEE_OUT,
		CLOSE_SOLVER_FEE_OUT,
		SETTLEMENT_PNL_IN,
		SETTLEMENT_PNL_OUT
	}

	enum TradeVolumeType {
		OPEN,
		CLOSE,
		LIQUIDATE
	}

	enum TradingFeeType {
		OPEN,
		CLOSE
	}

	/// @notice Reasons for exact changes to `AccountStorage.partyAReimbursement`.
	enum ReimbursementChangeType {
		CLEARING_HOUSE_IN,
		PLATFORM_FEE_IN,
		CLEARING_HOUSE_OUT,
		RELEASE_TO_ALLOCATED,
		MOVE_TO_LIQUIDATION_ESCROW
	}

	/// @notice Emitted only when `AccountStorage.allocatedBalances[partyA]` changes.
	/// @dev `amount` is the absolute allocated-balance delta represented by `_type`.
	event BalanceChangePartyA(address indexed partyA, uint256 amount, BalanceChangeType _type);

	/// @notice Emitted only when a PartyB allocated-balance bucket changes.
	/// @dev `amount` is the absolute bucket delta. The indexed `partyA` value is the exact storage key:
	///      the PartyA address for isolated allocations or address(0) for the shared cross-mode bucket.
	event BalanceChangePartyB(address indexed partyB, address indexed partyA, uint256 amount, BalanceChangeType _type);

	/// @notice Emitted only when `AccountStorage.partyAReimbursement[partyA]` changes.
	/// @dev `amount` is the absolute bucket delta and `newBalance` is the post-change bucket balance.
	event PartyAReimbursementChange(address indexed partyA, uint256 amount, uint256 newBalance, ReimbursementChangeType _type);

	/// @notice Emitted whenever a registered charger draws a standing operational fee from a payer.
	/// @dev `receiver` is intentionally not indexed: off-chain accounting keys on `charger` (the canonical
	///      query key, e.g. a solver or relayer) and `payer`; the receiver is the charger's
	///      configured payout address and is derivable from `charger`.
	event OperationalFeeCharged(address indexed payer, address indexed charger, address receiver, uint256 amount);

	event TradeVolumeRecorded(
		uint256 quoteId,
		uint256 amount,
		address partyA,
		address partyB,
		uint256 symbolId,
		address affiliate,
		TradeVolumeType _type
	);

	event TradingFeeCharged(
		uint256 quoteId,
		uint256 amount,
		address partyA,
		address partyB,
		uint256 symbolId,
		address affiliate,
		TradingFeeType _type
	);
}
