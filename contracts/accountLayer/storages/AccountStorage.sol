// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @notice Isolation type for virtual accounts determining how positions are grouped
enum VirtualAccountIsolationType {
	POSITION,
	MARKET,
	MARKET_LONG,
	MARKET_SHORT
}

/// @notice Isolation type for sub-accounts determining the VA creation strategy
enum SubAccountIsolationType {
	POSITION,
	MARKET,
	MARKET_DIRECTION,
	CUSTOM
}

/// @notice Persistent configuration data for a sub-account
struct SubAccountData {
	string name;
	address owner;
	bool isExists;
	bool singleVAMode;
	bytes metadata;
	address affiliate;
	address symmioCore;
	SubAccountIsolationType isolationType;
}

/// @notice Persistent configuration data for a virtual account
struct VirtualAccountData {
	bool isExists;
	bytes metadata;
	address parentAccount;
	uint256 symbolId;
	VirtualAccountIsolationType isolationType;
	EnumerableSet.UintSet quoteIds;
}

/// @notice Input parameters for creating a new sub-account
struct SubAccountCreationData {
	string name;
	bytes metadata;
	address symmioCore;
	SubAccountIsolationType isolationType;
	bool singleVAMode;
}

/// @notice View-layer representation of a sub-account with its address included
struct SubAccountDetail {
	address accountAddress;
	address owner;
	string name;
	bool isExists;
	bool singleVAMode;
	address affiliate;
	address symmioCore;
	bytes metadata;
	SubAccountIsolationType isolationType;
}

/// @notice View-layer representation of a virtual account with its address included
struct VirtualAccountDetail {
	address accountAddress;
	address parentAccount;
	uint256 symbolId;
	bool isExists;
	bytes metadata;
	VirtualAccountIsolationType isolationType;
}

/// @notice Information about a legacy MultiAccount-based account
struct LegacyAccountInfo {
	address accountAddress;
	string name;
	address legacyContract;
	bool alreadyImported;
}

/// @notice Input parameters for importing a legacy account into the new system
struct LegacyAccountImportData {
	address account;
	string name;
	uint256 coreIndex;
}

/// @title AccountStorage
/// @notice Unified account management with SubAccounts and Virtual Accounts (VAs)
/// @dev Replaces per-affiliate MultiAccount deployments with a single hub. Creates a
///      three-tier hierarchy: User → SubAccounts → Virtual Accounts. SubAccounts define
///      isolation strategy, VAs are the actual trading addresses interacting with Symmio.
library AccountStorage {
	bytes32 internal constant ACCOUNT_STORAGE_SLOT = keccak256("diamond.standard.storage.accountlayer.account");

	struct Layout {
		/// @notice SubAccount configuration by address
		/// @dev SubAccount addresses are deterministic via CREATE2. Contains owner,
		///      affiliate, symmioCore, and isolation type (POSITION/MARKET/MARKET_DIRECTION/CUSTOM).
		mapping(address => SubAccountData) subAccounts;
		/// @notice SubAccounts owned by each user
		/// @dev Maps user => set of their SubAccount addresses. A user can have multiple
		///      SubAccounts for different affiliates, cores, or isolation strategies.
		mapping(address => EnumerableSet.AddressSet) userToSubAccounts;
		/// @notice Virtual Account configuration by address
		/// @dev VA addresses are deterministic. Contains parent SubAccount, symbolId,
		///      isolation type, and tracked quoteIds for lifecycle management.
		mapping(address => VirtualAccountData) virtualAccounts;
		/// @notice Virtual Accounts under each SubAccount
		/// @dev Maps SubAccount => set of its VA addresses. Used for iteration and cleanup.
		mapping(address => EnumerableSet.AddressSet) subAccountToVirtualAccounts;
		/// @notice Pool of inactive VAs available for reuse
		/// @dev When VAs are deactivated (all positions closed), they're pooled here
		///      instead of discarded. Maps parent => isolationType => symbolId => addresses.
		///      Reusing addresses avoids unbounded address growth over time.
		mapping(address => mapping(VirtualAccountIsolationType => mapping(uint256 => address[]))) deletedVirtualAccountsPool;
		/// @notice Currently active VA per isolation key (used in singleVAMode)
		/// @dev Maps subAccount => isolationType => symbolId => active VA. In singleVAMode,
		///      only one VA can be active per key, simplifying frontend address management.
		mapping(address => mapping(VirtualAccountIsolationType => mapping(uint256 => address))) activeVAByKey;
		/// @notice Global counter for SubAccount address generation
		/// @dev Part of CREATE2 salt. Incremented on each SubAccount creation.
		uint256 globalNonce;
		/// @notice Per-SubAccount counter for VA address generation
		/// @dev Maps SubAccount => nonce. Next VA address = _generateVirtualAccountAddress(parent, nonce).
		mapping(address => uint256) subAccountVirtualNonces;
		/// @notice Authorized signer for protocol-level operations
		/// @dev Persistent signer used by existing AccountManager integrations. InstantLayer
		///      execution uses LibAccountLayerSigner's transient override.
		address globalSigner;
		/// @notice Bytecode for AccountManager deployment
		/// @dev AccountManagers are full contracts deployed per affiliate via CREATE2.
		bytes accountManagerImplementation;
		/// @notice Expected code hash after AccountManager initialization
		/// @dev Used to verify AccountManagers deployed correctly.
		bytes32 initAccountManagerCodeHash;
		/// @notice PartyBs that closed positions with a VA while in cross liquidation.
		/// @dev Maps VA address => set of partyBs with pending cross liq distributions.
		/// Used to defer VA deletion until distributeForClearingHouse has credited the VA's share,
		/// even when the final hook fires with a different partyB.
		mapping(address => EnumerableSet.AddressSet) vaPendingCrossLiqPartyBs;
		/// @notice Account family the current signer session is confined to, or zero when unconfined.
		/// @dev Set alongside globalSigner by callers that act on behalf of a delegate rather than the
		///      owner. globalSigner answers "who is acting"; this answers "on which account they may act".
		///      Without it, onlyAccountOwner passes for every account the owner holds, so a delegation
		///      granted over one sub-account would reach its siblings. Holds the canonical sub-account:
		///      virtual accounts resolve to their parent, so a scope covers a sub-account and its VAs --
		///      exactly the family a delegation grant covers. Always cleared with the signer.
		address scopedAccount;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = ACCOUNT_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
