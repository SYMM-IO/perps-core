// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Mirrors perps-core `SubAccountIsolationType`
///         (contracts/accountLayer/storages/AccountStorage.sol).
enum SubAccountIsolationType {
	POSITION,
	MARKET,
	MARKET_DIRECTION,
	CUSTOM
}

/// @notice Mirrors perps-core `VirtualAccountIsolationType`
///         (contracts/accountLayer/storages/AccountStorage.sol).
enum VirtualAccountIsolationType {
	POSITION,
	MARKET,
	MARKET_LONG,
	MARKET_SHORT
}

/// @notice Mirrors perps-core `SubAccountCreationData`.
struct SubAccountCreationData {
	string name;
	bytes metadata;
	address symmioCore;
	SubAccountIsolationType isolationType;
	bool singleVAMode;
}

/// @notice Mirrors perps-core `VirtualAccountDetail`.
struct VirtualAccountDetail {
	address accountAddress;
	address parentAccount;
	uint256 symbolId;
	bool isExists;
	bytes metadata;
	VirtualAccountIsolationType isolationType;
}

/// @title ISymmioAccountLayer
/// @notice Account-layer methods the gateway depends on.
interface ISymmioAccountLayer {
	/// @notice Create one or more sub-accounts OWNED BY `owner` (not `msg.sender`) under `affiliate`.
	/// @dev Matches perps-core 0.8.6 `CoreFacet.createSubAccountsFor`, which is gated by
	///      `ACCOUNT_CREATOR_ROLE` — the gateway must be granted that role on the account layer.
	/// @return subAccounts The addresses of the newly created sub-accounts, in order.
	function createSubAccountsFor(
		address owner,
		address affiliate,
		SubAccountCreationData[] calldata accountsData
	) external returns (address[] memory subAccounts);

	/// @notice Owner of a sub-account (account-layer ViewFacet.ownerOf).
	function ownerOf(address account) external view returns (address);

	/// @notice View-layer metadata for a virtual account. Non-VAs return a zero struct.
	function getVirtualAccount(address account) external view returns (VirtualAccountDetail memory);
}
