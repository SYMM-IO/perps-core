// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.22;

import { TransparentUpgradeableProxy, ITransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ProxyAdmin } from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import { StorageMigration } from "./StorageMigration.sol";

/// @notice Holds a new proxy's upgrade authority until the approved import is sealed.
/// @dev Activation upgrades once and hands the standard ProxyAdmin to the configured
///      upgrade authority. Import and operational roles never confer upgrade ownership.
contract StorageMigrationCoordinator {
	address public immutable upgradeAuthority;
	address public immutable implementation;
	bytes32 public immutable implementationCodeHash;
	bytes32 public immutable snapshotCommitment;
	TransparentUpgradeableProxy public immutable proxy;
	bool public activated;

	error InvalidMigration();
	error UnauthorizedUpgrade();
	error MigrationNotSealed();
	event MigrationActivated(address indexed proxy, address indexed implementation, address indexed proxyAdmin);

	constructor(address authority, StorageMigration migrator, address targetImplementation) {
		if (authority == address(0) || address(migrator).code.length == 0 || targetImplementation.code.length == 0) revert InvalidMigration();
		upgradeAuthority = authority;
		implementation = targetImplementation;
		implementationCodeHash = targetImplementation.codehash;
		snapshotCommitment = migrator.snapshotCommitment();
		proxy = new TransparentUpgradeableProxy(address(migrator), address(this), abi.encodeCall(migrator.initializeMigration, ()));
	}

	/// @param admin The ProxyAdmin emitted by the proxy's constructor; validated by ownership and upgrade dispatch.
	/// @param data Release-specific initializer calldata, validated and simulated by the adapter.
	function activate(ProxyAdmin admin, bytes calldata data) external {
		if (msg.sender != upgradeAuthority) revert UnauthorizedUpgrade();
		if (activated || implementation.codehash != implementationCodeHash || admin.owner() != address(this)) revert InvalidMigration();
		StorageMigration migration = StorageMigration(address(proxy));
		(, bool isSealed) = migration.migrationProgress();
		if (!isSealed || migration.snapshotCommitment() != snapshotCommitment) revert MigrationNotSealed();
		activated = true;
		admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), implementation, data);
		admin.transferOwnership(upgradeAuthority);
		emit MigrationActivated(address(proxy), implementation, address(admin));
	}
}
