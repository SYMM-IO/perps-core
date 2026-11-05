// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Interface for the core Symmio contract.
/// @dev Used to toggle InstantLayer routing in core. Shared by every InstantLayer facet that
///      opens or closes the core authority scope, so Phase 2's signed-batch entrypoint reuses
///      this declaration instead of carrying its own copy.
interface ISymmio {
	/// @notice Enable or disable instant layer mode
	/// @param _callFromInstantLayer True to enable instant layer mode
	function setCallFromInstantLayer(bool _callFromInstantLayer) external;

	/// @notice Enable or disable instant open mode (skips pending balance tracking)
	/// @param _instantOpenMode True to skip pending balances in send+lock+open flows
	function setInstantOpenMode(bool _instantOpenMode) external;

	/// @notice Begin transient InstantLayer execution.
	function beginInstantLayerExecution(bool _instantOpenMode) external;

	/// @notice End transient InstantLayer execution before returning.
	function endInstantLayerExecution() external;
}
