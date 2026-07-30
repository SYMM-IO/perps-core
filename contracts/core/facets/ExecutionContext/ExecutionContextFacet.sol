// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { IExecutionContextFacet } from "./IExecutionContextFacet.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { LibExecutionContext } from "../../libraries/LibExecutionContext.sol";

/// @notice Owns the core Diamond's transient InstantLayer and signer authority.
/// @dev Legacy setCallFromInstantLayer, setInstantOpenMode, and setSigner selectors remain
///      in ControlFacet and adapt into the same LibExecutionContext state.
contract ExecutionContextFacet is Accessibility, IExecutionContextFacet {
	/// @notice Opens one explicit InstantLayer authority scope for the current transaction.
	function beginInstantLayerExecution(bool instantOpenMode) external onlyRole(LibAccessibility.INSTANT_LAYER_ROLE) {
		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
		require(!globalLayout.instantLayerPaused, "ControlFacet: Instant Layer Paused");
		require(!globalLayout.callFromInstantLayer && !globalLayout.instantOpenMode, "ControlFacet: Persistent instant context is set");
		LibExecutionContext.beginInstantLayerExecution(instantOpenMode);
	}

	/// @notice Closes the authority scope opened by beginInstantLayerExecution.
	function endInstantLayerExecution() external onlyRole(LibAccessibility.INSTANT_LAYER_ROLE) {
		LibExecutionContext.endInstantLayerExecution();
	}

	/// @notice Temporarily removes InstantLayer privileges while a trusted router invokes
	///         untrusted external code, binding the saved context to that router.
	function suspendExecutionContextForExternalCall() external onlyRole(LibAccessibility.SIGNER_ADMIN_ROLE) returns (bool suspended) {
		return LibExecutionContext.suspendExecutionContextForExternalCaller();
	}

	/// @notice Restores the exact context this same router suspended.
	/// @dev The snapshot is keyed by msg.sender, so a router can only ever restore its own
	///      context, and only if the untrusted call left no execution context behind.
	function restoreExecutionContextAfterExternalCall() external onlyRole(LibAccessibility.SIGNER_ADMIN_ROLE) {
		LibExecutionContext.restoreExecutionContextForExternalCaller();
	}

	/// @notice Installs the effective signer for this transaction, or clears it with zero.
	/// @dev Uses onlyRoleAllowProxy because routers legitimately call this while a signer scope
	///      is open. The persistent-signer check keeps the two mechanisms from overlapping: a
	///      transient signer may never be layered on top of a persistent one.
	function setTransientSigner(address signer) external onlyRoleAllowProxy(LibAccessibility.SIGNER_ADMIN_ROLE) {
		require(GlobalAppStorage.layout().signer == address(0), "ControlFacet: Persistent signer is set");
		LibExecutionContext.setTransientSigner(signer);
		emit SignerSet(signer);
	}
}
