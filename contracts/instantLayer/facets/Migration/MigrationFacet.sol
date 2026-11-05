// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IInstantLayerMigrationFacet } from "./IMigrationFacet.sol";
import { IInstantLayerDelegationSource } from "../../interfaces/IInstantLayerDelegationSource.sol";
import { InstantLayerAccessibility } from "../../utils/InstantLayerAccessibility.sol";
import { LibInstantLayerAccessibility } from "../../libraries/LibInstantLayerAccessibility.sol";
import { LibInstantLayerAccount } from "../../libraries/LibInstantLayerAccount.sol";
import { InstantLayerStorage } from "../../storages/InstantLayerStorage.sol";
import { DelegationStorage } from "../../storages/DelegationStorage.sol";

/// @notice Role-gated delegation imports from a trusted older InstantLayer instance.
contract MigrationFacet is IInstantLayerMigrationFacet, InstantLayerAccessibility {
	/// @inheritdoc IInstantLayerMigrationFacet
	// solhint-disable-next-line func-name-mixedcase
	function MIGRATOR_ROLE() external pure returns (bytes32) {
		return LibInstantLayerAccessibility.MIGRATOR_ROLE;
	}

	/// @inheritdoc IInstantLayerMigrationFacet
	function migrateDelegations(
		address oldInstantLayer,
		DelegationMigration[] calldata migrations
	) external onlyRole(LibInstantLayerAccessibility.MIGRATOR_ROLE) returns (uint256 migratedCount) {
		if (oldInstantLayer == address(this) || oldInstantLayer.code.length == 0) revert InvalidMigrationSource(oldInstantLayer);
		if (migrations.length == 0) revert EmptyArray();
		InstantLayerStorage.Layout storage config = InstantLayerStorage.layout();
		if (config.accountLayer == address(0)) revert AccountLayerNotSet();
		IInstantLayerDelegationSource source = IInstantLayerDelegationSource(oldInstantLayer);
		if (source.symmio() != config.symmio || source.accountLayer() != config.accountLayer) revert InvalidMigrationSource(oldInstantLayer);

		DelegationStorage.Layout storage delegations = DelegationStorage.layout();
		for (uint256 i = 0; i < migrations.length; ++i) {
			DelegationMigration calldata entry = migrations[i];
			if (entry.selectors.length == 0) revert InvalidDelegation();
			address delegator = LibInstantLayerAccount.canonicalDelegator(entry.account);
			for (uint256 j = 0; j < entry.selectors.length; ++j) {
				bytes4 selector = entry.selectors[j];
				uint256 expiry = source.delegations(delegator, entry.delegate, selector);
				uint256 eta = source.pendingRevocationEta(delegator, entry.delegate, selector);
				if (expiry <= block.timestamp || (eta != 0 && eta <= block.timestamp)) continue;

				delegations.delegations[delegator][entry.delegate][selector] = expiry;
				delegations.pendingRevocationEta[delegator][entry.delegate][selector] = eta;
				emit DelegationGranted(delegator, entry.delegate, selector, expiry);
				if (eta != 0) emit RevocationScheduled(delegator, entry.delegate, selector, eta);
				emit DelegationMigrated(oldInstantLayer, delegator, entry.delegate, selector, expiry, eta);
				++migratedCount;
			}
		}
	}
}
