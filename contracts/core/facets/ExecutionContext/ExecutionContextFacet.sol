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
/// @dev Hosts the legacy setCallFromInstantLayer/setInstantOpenMode selectors too — they adapt
///      into the same LibExecutionContext state, and living here keeps ControlFacet inside the
///      release size budget. The legacy setSigner selector remains in ControlFacet and adapts
///      into the same state.
contract ExecutionContextFacet is Accessibility, IExecutionContextFacet {
	/// @notice Sets the flag indicating if the current operation is being executed via the instant layer.
	/// @dev Instant layer sets this flag to true before execution and MUST reset it back to false after its operation.
	///      Deployed callers keep this selector and its exact calldata, but internally it opens and closes the
	///      same EIP-1153 scope that beginInstantLayerExecution/endInstantLayerExecution use. The legacy
	///      two-call sequence and the explicit single call are therefore behaviourally identical, which is what
	///      lets un-redeployed InstantLayers share one mechanism with new ones instead of diverging.
	/// @param callFromInstantLayer True when entering instant layer execution, false when exiting.
	function setCallFromInstantLayer(bool callFromInstantLayer) external onlyRole(LibAccessibility.INSTANT_LAYER_ROLE) {
		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
		require(!(callFromInstantLayer && globalLayout.instantLayerPaused), "ControlFacet: Instant Layer Paused");

		if (callFromInstantLayer) {
			require(!globalLayout.callFromInstantLayer && !globalLayout.instantOpenMode, "ControlFacet: Persistent instant context is set");
			LibExecutionContext.beginInstantLayerExecution(false);
		} else {
			LibExecutionContext.endInstantLayerExecution();
		}
	}

	/// @notice Sets the flag to skip pending balance tracking in atomic open flows.
	/// @dev Inside an active transient scope — the deployed InstantLayer sequence, which always calls
	///      setCallFromInstantLayer(true) first in the same transaction — this updates the scope.
	///      Outside one it keeps the v0.8.6 persistent behavior, so a solver driving core directly
	///      can still hold instant-open mode across transactions. Mirrors setSigner's
	///      context-dependent routing.
	/// @param instantOpenMode True when entering instant open execution, false when exiting.
	function setInstantOpenMode(bool instantOpenMode) external onlyRole(LibAccessibility.INSTANT_LAYER_ROLE) {
		if (LibExecutionContext.isTransientContextActive()) {
			LibExecutionContext.setInstantOpenMode(instantOpenMode);
		} else {
			GlobalAppStorage.layout().instantOpenMode = instantOpenMode;
		}
	}

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
