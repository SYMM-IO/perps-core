// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.22;

import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { ERC1967Utils } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/// @notice Temporary implementation for an approved, complete raw-storage migration.
/// @dev Use only behind a fresh proxy after release-specific storage validation. The
///      commitment authenticates the approved inventory, not the source chain header.
contract StorageMigration {
	address public immutable migrationAuthority;
	bytes32 public immutable snapshotCommitment;
	bytes32 public immutable importRoot;
	uint256 public immutable entryCount;
	address private immutable implementationSelf;

	/// @custom:storage-location erc7201:symmio.storage.MigrationProgress
	struct Progress {
		uint256 nextIndex;
		bytes32 lastSlot;
		bool isSealed;
		bool initialized;
	}

	// ERC-7201: keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~bytes32(uint256(0xff)).
	bytes32 public constant PROGRESS_SLOT =
		keccak256(abi.encode(uint256(keccak256("symmio.storage.MigrationProgress")) - 1)) & ~bytes32(uint256(0xff));

	struct Entry {
		bytes32 slot;
		bytes32 value;
		bytes32[] proof;
	}

	error InvalidMigration();
	error UnauthorizedMigration();
	error InvalidEntry(uint256 index);
	error ReservedSlot(bytes32 slot);
	error IncompleteMigration();
	event StorageImported(uint256 startIndex, uint256 endIndex);
	event MigrationSealed(bytes32 indexed commitment);

	constructor(address authority, bytes32 commitment, bytes32 root, uint256 count) {
		if (authority == address(0) || commitment == bytes32(0) || root == bytes32(0) || count == 0) revert InvalidMigration();
		migrationAuthority = authority;
		snapshotCommitment = commitment;
		importRoot = root;
		entryCount = count;
		implementationSelf = address(this);
	}

	modifier onlyMigrationAuthority() {
		if (address(this) == implementationSelf || msg.sender != migrationAuthority) revert UnauthorizedMigration();
		_;
	}

	function _progress() private pure returns (Progress storage progress) {
		bytes32 slot = PROGRESS_SLOT;
		assembly {
			progress.slot := slot
		}
	}

	function migrationProgress() external view returns (uint256 nextIndex, bool isSealed) {
		Progress storage progress = _progress();
		return (progress.nextIndex, progress.isSealed);
	}

	/// @dev Called atomically by the proxy constructor. No operational source state is initialized here.
	function initializeMigration() external {
		Progress storage progress = _progress();
		if (address(this) == implementationSelf || progress.initialized) revert InvalidMigration();
		progress.initialized = true;
	}

	/// @notice Import the next sorted chunk. Atomic failure and sequential indices make retries unambiguous.
	function importStorage(uint256 startIndex, Entry[] calldata entries) external onlyMigrationAuthority {
		Progress storage progress = _progress();
		if (
			!progress.initialized ||
			progress.isSealed ||
			startIndex != progress.nextIndex ||
			entries.length == 0 ||
			entries.length > entryCount - startIndex
		) revert InvalidMigration();
		for (uint256 i = 0; i < entries.length; i++) {
			uint256 index = startIndex + i;
			Entry calldata entry = entries[i];
			if (entry.value == bytes32(0) || (index != 0 && entry.slot <= progress.lastSlot)) revert InvalidEntry(index);
			if (
				entry.slot == ERC1967Utils.IMPLEMENTATION_SLOT ||
				entry.slot == ERC1967Utils.ADMIN_SLOT ||
				entry.slot == ERC1967Utils.BEACON_SLOT ||
				(bytes32(uint256(entry.slot) & ~uint256(0xff)) == PROGRESS_SLOT)
			) revert ReservedSlot(entry.slot);
			bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, entry.slot, entry.value))));
			if (!MerkleProof.verifyCalldata(entry.proof, importRoot, leaf)) revert InvalidEntry(index);
			bytes32 slot = entry.slot;
			bytes32 value = entry.value;
			assembly {
				sstore(slot, value)
			}
			progress.lastSlot = slot;
		}
		progress.nextIndex = startIndex + entries.length;
		emit StorageImported(startIndex, progress.nextIndex);
	}

	function sealMigration() external onlyMigrationAuthority {
		Progress storage progress = _progress();
		if (progress.isSealed || progress.nextIndex != entryCount) revert IncompleteMigration();
		progress.isSealed = true;
		emit MigrationSealed(snapshotCommitment);
	}
}
