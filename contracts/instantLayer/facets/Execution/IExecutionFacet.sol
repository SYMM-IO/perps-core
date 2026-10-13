// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SignedOperation } from "../../InstantLayerTypes.sol";
import { IInstantLayerErrors } from "../../interfaces/IInstantLayerErrors.sol";
import { IInstantLayerEvents } from "../../interfaces/IInstantLayerEvents.sol";

/// @notice Operator-gated batch and template execution entry points for the InstantLayer diamond
interface IExecutionFacet is IInstantLayerEvents, IInstantLayerErrors {
	/// @notice Execute a batch of independent operations.
	/// @dev Operations are executed sequentially without result chaining. All operations must
	///      succeed for the transaction to complete.
	/// @param signedOps  Array of signed operations to execute
	/// @param signatures Array of signatures for the operations
	/// @param fills      Per-operation flex field fill values (empty inner arrays where unused)
	/// @param flexFillerSignatures Per-operation flex filler signatures (empty inner arrays where unused)
	/// @return results Return data from each executed operation
	function executeBatch(
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external returns (bytes[] memory results);

	/// @notice Execute a sequence of operations using a predefined template.
	/// @dev Operations are executed in order with automatic result injection between them. All
	///      operations must succeed for the transaction to complete.
	/// @param templateId ID of the template defining the operation sequence
	/// @param signedOps  Array of signed operations matching template requirements
	/// @param signatures Array of signatures corresponding to each operation
	/// @param fills      Per-operation flex field fill values (empty inner arrays where unused)
	/// @param flexFillerSignatures Per-operation flex filler signatures (empty inner arrays where unused)
	/// @return results Return data from each executed operation
	function executeTemplate(
		uint256 templateId,
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external returns (bytes[] memory results);
}
