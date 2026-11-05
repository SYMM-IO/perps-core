// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IInstantLayerErrors } from "../../interfaces/IInstantLayerErrors.sol";
import { IInstantLayerEvents } from "../../interfaces/IInstantLayerEvents.sol";

interface IInstantLayerMigrationFacet is IInstantLayerEvents, IInstantLayerErrors {
	struct DelegationMigration {
		address account;
		address delegate;
		bytes4[] selectors;
	}

	/// @notice Role required to import delegations from a trusted older InstantLayer.
	function MIGRATOR_ROLE() external view returns (bytes32);

	/// @notice Copy selected active delegations from a trusted source with matching core and AccountLayer.
	/// @dev MIGRATOR_ROLE must be granted explicitly. The caller selects a trusted source; matching
	///      configuration alone does not prove its authenticity. Virtual accounts resolve to their parent.
	///      Copies each active selector's expiry and revocation ETA, overwriting destination entries.
	///      The trusted migrator may repeat imports or select different sources for the same key;
	///      the last active entry wins, including over local grants or revocations. Inactive source
	///      entries are skipped. Does not copy nonces or signed hashes or track migration history.
	/// @param oldInstantLayer Source monolith or diamond exposing delegation and configuration getters.
	/// @param migrations Account/delegate pairs with the selectors to copy (delegations are not target-specific).
	/// @return migratedCount Number of active selector entries copied, including repeats and duplicates.
	function migrateDelegations(address oldInstantLayer, DelegationMigration[] calldata migrations) external returns (uint256 migratedCount);
}
