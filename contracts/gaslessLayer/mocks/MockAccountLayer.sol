// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import {
	ISymmioAccountLayer,
	SubAccountCreationData,
	SubAccountIsolationType,
	VirtualAccountDetail,
	VirtualAccountIsolationType
} from "../interfaces/ISymmioAccountLayer.sol";

/// @notice Stand-in for the account layer. `createSubAccountsFor` mints deterministic-ish sub-account
///         addresses OWNED BY `owner` (the behaviour of perps-core 0.8.6 `createSubAccountsFor`).
contract MockAccountLayer is ISymmioAccountLayer {
	uint256 public nextSubAccountNonce;
	mapping(address => address) public accountOwners;
	mapping(address => string) public accountNames;
	mapping(address => VirtualAccountDetail) public virtualAccounts;

	/// @dev Test-only: records fields from the most recent createSubAccountsFor call, so tests can
	///      assert the gateway passed the full creation data through (and overrode symmioCore).
	address public lastSubAccountSymmioCore;
	SubAccountIsolationType public lastSubAccountIsolationType;
	address public lastSubAccountAffiliate;

	/// @dev Test-only: when set, newly created accounts are registered to this owner instead of the
	///      requested `owner`, to exercise the gateway's post-creation ownership check.
	address public forcedCreatedAccountOwner;

	event SubAccountCreatedFor(address indexed owner, address indexed subAccount, address affiliate, string name);
	event VirtualAccountConfigured(address indexed virtualAccount, address indexed parentAccount, bool isExists);

	function createSubAccountsFor(
		address owner,
		address affiliate,
		SubAccountCreationData[] calldata accountsData
	) external returns (address[] memory subAccounts) {
		subAccounts = new address[](accountsData.length);
		address recordedOwner = forcedCreatedAccountOwner == address(0) ? owner : forcedCreatedAccountOwner;
		for (uint256 i = 0; i < accountsData.length; i++) {
			nextSubAccountNonce++;
			address subAccount = address(uint160(uint256(keccak256(abi.encode(owner, affiliate, nextSubAccountNonce)))));
			accountOwners[subAccount] = recordedOwner;
			accountNames[subAccount] = accountsData[i].name;
			lastSubAccountSymmioCore = accountsData[i].symmioCore;
			lastSubAccountIsolationType = accountsData[i].isolationType;
			lastSubAccountAffiliate = affiliate;
			subAccounts[i] = subAccount;
			emit SubAccountCreatedFor(recordedOwner, subAccount, affiliate, accountsData[i].name);
		}
	}

	/// @notice Test helper to register a pre-existing account.
	function setAccountOwner(address subAccount, address owner) external {
		accountOwners[subAccount] = owner;
	}

	/// @notice Test helper to mark an address as a virtual account of `parentAccount`.
	function setVirtualAccount(address virtualAccount, address parentAccount) external {
		virtualAccounts[virtualAccount] = VirtualAccountDetail({
			accountAddress: virtualAccount,
			parentAccount: parentAccount,
			symbolId: 0,
			isExists: true,
			metadata: "",
			isolationType: VirtualAccountIsolationType.POSITION
		});
		emit VirtualAccountConfigured(virtualAccount, parentAccount, true);
	}

	/// @notice Test helper mirroring real VA deletion: isExists flips off, parentAccount survives on the
	///         record (the account layer pools deleted VAs per parent for reuse).
	function clearVirtualAccount(address virtualAccount) external {
		virtualAccounts[virtualAccount].isExists = false;
		emit VirtualAccountConfigured(virtualAccount, virtualAccounts[virtualAccount].parentAccount, false);
	}

	/// @notice Test helper to force created accounts to a different owner.
	function setForcedCreatedAccountOwner(address owner) external {
		forcedCreatedAccountOwner = owner;
	}

	function ownerOf(address account) external view returns (address) {
		return accountOwners[account];
	}

	function getVirtualAccount(address account) external view returns (VirtualAccountDetail memory) {
		return virtualAccounts[account];
	}
}
