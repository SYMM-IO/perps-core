// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IExecutionContextEvents } from "./IExecutionContextEvents.sol";

/// @notice Transient execution authority exposed by the core Diamond.
/// @dev Every selector in this interface is implemented by ExecutionContextFacet.
interface IExecutionContextFacet is IExecutionContextEvents {
	/// @notice Routes an older InstantLayer's existing setter sequence through transient storage.
	function setLegacyExecutionContextAdapter(address legacyInstantLayer, bool enabled) external;

	/// @notice Returns whether the compatibility adapter is enabled for an older InstantLayer.
	/// @param legacyInstantLayer The InstantLayer address to query.
	/// @return Whether that caller's legacy setter sequence is backed by transient storage.
	function legacyExecutionContextAdapterEnabled(address legacyInstantLayer) external view returns (bool);

	/// @notice Opens the transient InstantLayer authority scope for the whole batch.
	/// @dev Callable only by the InstantLayer role, and only while no persistent instant flag is
	///      set. Reverts if a scope is already open, so two nested batches cannot share authority.
	///      The caller must always pair this with endInstantLayerExecution before returning.
	/// @param instantOpenMode True to also enable the atomic-open accounting shortcuts.
	function beginInstantLayerExecution(bool instantOpenMode) external;

	/// @notice Closes the transient InstantLayer authority scope.
	/// @dev Must be called by the same InstantLayer before it returns, so later calls in an
	///      outer multicast cannot inherit its privileges. Reverts if no scope is open or a
	///      transient signer is still installed.
	function endInstantLayerExecution() external;

	/// @notice Temporarily strips InstantLayer authority before the caller invokes untrusted code.
	/// @dev For trusted routers (such as AccountLayer) that call out to third-party hooks of their
	///      own. The saved context is bound to msg.sender, so the caller can neither choose nor
	///      alter what it later restores. Reverts if that caller already has a suspended context.
	/// @return suspended True if a context existed and was suspended; false if there was nothing
	///         to suspend, in which case the caller must not call the restore function.
	function suspendExecutionContextForExternalCall() external returns (bool suspended);

	/// @notice Restores the execution context this same caller previously suspended.
	/// @dev Reverts if the caller has nothing suspended, or if the untrusted call installed a new
	///      execution context in the meantime -- a hook must not smuggle privilege past the boundary.
	function restoreExecutionContextAfterExternalCall() external;

	/// @notice Installs the effective signer for the current transaction, or clears it with zero.
	/// @dev Transient counterpart of setSigner. It cannot be opened over a persistent
	///      signer, so the two mechanisms can never be mixed within one transaction.
	/// @param signer Signer to install, or address(0) to end the signer scope.
	function setTransientSigner(address signer) external;
}
