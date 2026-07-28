// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.34;

import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";

/// @title LibExecutionContext
/// @notice Transient execution context for the core diamond.
/// @dev "Execution context" means the temporary authority carried by an InstantLayer
///      transaction: (1) the call is routed by InstantLayer, (2) it may use atomic-open
///      rules, and (3) it may act for a delegated signer. It is not a caller address and
///      it does not replace signature verification. Transient state is shared by every
///      facet reached through Diamond delegatecall and cleared at transaction end.
///      Persistent fields remain the compatibility fallback for existing integrations.
///
///      THREE PIECES OF STATE
///      1. The InstantLayer context word (one transient slot). Packs "a scope is live",
///         "routed by InstantLayer" and "atomic-open allowed" into three bits.
///      2. The signer, held as TWO transient slots: a value slot and an active marker.
///         The marker records that transient storage -- not the persistent `signer`
///         field -- currently owns the signer. They are separate so an external-call
///         boundary can blank the value while still remembering which mechanism to
///         restore. Value cleared + marker set is the "suspended signer" state.
///      3. Per-caller snapshots (one transient slot per address), used when a trusted
///         router suspends the context across its own untrusted call.
///
///      READ FALLBACK
///      Every public reader prefers the live transient scope and otherwise returns the
///      persistent field. With no scope open the library is behaviourally invisible,
///      which is what lets unmigrated callers keep working unchanged.
library LibExecutionContext {
	bytes32 private constant EXECUTION_CONTEXT_CONFIG_SLOT = keccak256("symmio.core.execution-context.config");
	bytes32 private constant TRANSIENT_SIGNER_SLOT = keccak256("symmio.core.transient.signer");
	bytes32 private constant TRANSIENT_SIGNER_ACTIVE_SLOT = keccak256("symmio.core.transient.signer.active");
	bytes32 private constant TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT = keccak256("symmio.core.transient.instant-layer.context");
	bytes32 private constant EXTERNAL_CALL_CONTEXT_NAMESPACE = keccak256("symmio.core.external-call.execution-context");

	// ── Live InstantLayer context word ────────────────────────────────────────
	// Held in TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT.
	//   bit 0  a scope is currently open. Zero means "no scope", which is what
	//          makes every reader fall back to the persistent field.
	//   bit 1  this call is routed by InstantLayer.
	//   bit 2  atomic-open accounting shortcuts are permitted.
	// Bit 0 is what distinguishes "open scope that happens to grant nothing" from
	// "no scope at all", so it is set for every live scope even though begin()
	// always sets bit 1 alongside it.
	uint256 private constant INSTANT_CONTEXT_ACTIVE = 1 << 0;
	uint256 private constant CALL_FROM_INSTANT_LAYER = 1 << 1;
	uint256 private constant INSTANT_OPEN_MODE = 1 << 2;
	uint256 private constant INSTANT_CONTEXT_FLAGS = INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER | INSTANT_OPEN_MODE;

	// ── External-call snapshot word ───────────────────────────────────────────
	// A snapshot is a *different* value from the live word above: it is returned to
	// the caller, or parked in that caller's own slot, never written back into the
	// live context slot while the suspension lasts.
	//   bit 255  this is a real snapshot. Set unconditionally so a populated
	//            snapshot can never be confused with the 0 sentinel meaning
	//            "there was nothing to suspend".
	//   bit 254  the suspended authority came from transient storage. This is the
	//            only discriminator restore() uses to pick which source to write
	//            back, so it must be set for the transient case and clear otherwise.
	//   bits 1-2 the suspended routing / atomic-open flags. They carry the SAME
	//            meaning as in the live word above, which is why the transient
	//            branch can recover the original context with one mask
	//            (`snapshot & INSTANT_CONTEXT_FLAGS`) instead of rebuilding it.
	// The two encodings therefore overlap on purpose in bits 1-2 and differ only in
	// bit 0: a transient snapshot inherits it from the live word, a persistent one
	// never sets it. Nothing reads bit 0 out of a snapshot, so that difference is
	// inert -- bit 254 alone decides how the value is interpreted.
	uint256 private constant EXTERNAL_CONTEXT_SNAPSHOT_ACTIVE = 1 << 255;
	uint256 private constant EXTERNAL_CONTEXT_SNAPSHOT_TRANSIENT = 1 << 254;
	uint256 private constant EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_CALL = 1 << 1;
	uint256 private constant EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_OPEN = 1 << 2;

	// ── Signer active marker ──────────────────────────────────────────────────
	// Held in TRANSIENT_SIGNER_ACTIVE_SLOT, deliberately separate from the signer
	// value so a boundary can clear the value without losing the mechanism.
	uint256 private constant TRANSIENT_SIGNER_INACTIVE = 0;
	uint256 private constant TRANSIENT_SIGNER_ACTIVE = 1;

	/// @dev Ending or mutating a scope that was never opened.
	error TransientContextNotActive();
	/// @dev Opening a second scope inside a live one. Nested batches must not share authority.
	error TransientContextAlreadyActive();
	/// @dev Ending the scope while a signer override is still installed, which would leave a
	///      signer alive with no owning scope for the rest of the transaction.
	error TransientSignerNotCleared();
	/// @dev One caller tried to suspend twice without restoring in between. Snapshots are keyed
	///      by caller, so the second suspend would overwrite the first.
	error ExternalCallContextAlreadySuspended();
	/// @dev Restoring with nothing suspended for this caller.
	error ExternalCallContextNotSuspended();
	/// @dev An execution context was installed while the original was suspended. Fails closed
	///      rather than restoring on top of privilege the untrusted call left behind.
	error ExternalCallContextWasModified();
	/// @dev A signer was left installed by the external call. Same fail-closed reasoning.
	error ExternalCallSignerWasModified();

	struct ConfigLayout {
		/// @notice Existing InstantLayer deployments whose legacy true/false setter
		///         sequence should be backed by EIP-1153 state.
		mapping(address => bool) legacyExecutionContextAdapters;
	}

	/// @notice Starts a transient InstantLayer execution context.
	/// @dev `callFromInstantLayer` is always true for this context. InstantLayer must end
	///      the scope before returning so later calls in an outer multicast cannot inherit
	///      its privileges. EIP-1153 still guarantees cleanup if the transaction reverts.
	function beginInstantLayerExecution(bool instantOpenMode) internal {
		if (_instantLayerContext() & INSTANT_CONTEXT_ACTIVE != 0) revert TransientContextAlreadyActive();
		uint256 context = INSTANT_CONTEXT_ACTIVE | CALL_FROM_INSTANT_LAYER;
		if (instantOpenMode) context |= INSTANT_OPEN_MODE;
		bytes32 slot = TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT;
		assembly ("memory-safe") {
			tstore(slot, context)
		}
	}

	/// @notice Ends the current transient InstantLayer execution context.
	/// @dev The signer check is not tidiness. "Transient" bounds the signer to the transaction,
	///      not to this call -- nothing clears it when the scope closes. Ending the owning scope
	///      while one is installed would therefore leave an identity that every later call in the
	///      transaction still reads, with no scope left to attribute it to. Refusing here forces
	///      the caller to unwind in order.
	function endInstantLayerExecution() internal {
		if (_instantLayerContext() & INSTANT_CONTEXT_ACTIVE == 0) revert TransientContextNotActive();
		if (isTransientSignerActive()) revert TransientSignerNotCleared();
		bytes32 slot = TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT;
		assembly ("memory-safe") {
			tstore(slot, 0)
		}
	}

	/// @notice Updates instant-open mode inside an active transient execution context.
	/// @dev Used by existing InstantLayer bytecode, which calls setCallFromInstantLayer(true)
	///      and setInstantOpenMode(true) as separate operations.
	function setInstantOpenMode(bool enabled) internal {
		uint256 context = _instantLayerContext();
		if (context & INSTANT_CONTEXT_ACTIVE == 0) revert TransientContextNotActive();
		if (enabled) {
			context |= INSTANT_OPEN_MODE;
		} else {
			context &= ~INSTANT_OPEN_MODE;
		}
		bytes32 slot = TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT;
		assembly ("memory-safe") {
			tstore(slot, context)
		}
	}

	/// @notice Configures whether one InstantLayer's legacy setters write transient storage.
	/// @dev Pure configuration: it neither authorizes the caller nor opens a scope.
	function setLegacyExecutionContextAdapter(address legacyInstantLayer, bool enabled) internal {
		_configLayout().legacyExecutionContextAdapters[legacyInstantLayer] = enabled;
	}

	/// @notice Returns the configured storage mechanism for one InstantLayer's legacy setters.
	function legacyExecutionContextAdapterEnabled(address legacyInstantLayer) internal view returns (bool) {
		return _configLayout().legacyExecutionContextAdapters[legacyInstantLayer];
	}

	/// @notice Returns whether the effective context is an InstantLayer call.
	function isCallFromInstantLayer() internal view returns (bool) {
		uint256 context = _instantLayerContext();
		if (context & INSTANT_CONTEXT_ACTIVE != 0) return context & CALL_FROM_INSTANT_LAYER != 0;
		return GlobalAppStorage.layout().callFromInstantLayer;
	}

	/// @notice Returns whether the EIP-1153 InstantLayer context is currently active.
	/// @dev Deliberately does NOT fall back. isCallFromInstantLayer answers "does the caller
	///      have routing authority", which a persistent flag can also grant; this answers
	///      "is a transient scope open", which only bit 0 can. Callers choosing a storage
	///      mechanism (ControlFacet.setSigner) must use this one, or a persistent flag would
	///      steer them into writing transient state that nothing is going to clean up.
	function isTransientContextActive() internal view returns (bool) {
		return _instantLayerContext() & INSTANT_CONTEXT_ACTIVE != 0;
	}

	/// @notice Returns whether the effective context is the optimized atomic-open mode.
	function isInstantOpenMode() internal view returns (bool) {
		uint256 context = _instantLayerContext();
		if (context & INSTANT_CONTEXT_ACTIVE != 0) return context & INSTANT_OPEN_MODE != 0;
		return GlobalAppStorage.layout().instantOpenMode;
	}

	/// @notice Returns true when a transient signer override is installed.
	/// @dev The active marker is separate from the signer value because hook boundaries
	///      temporarily clear the value while retaining which storage mechanism to restore.
	function isTransientSignerActive() internal view returns (bool active) {
		bytes32 slot = TRANSIENT_SIGNER_ACTIVE_SLOT;
		assembly ("memory-safe") {
			active := tload(slot)
		}
	}

	/// @notice Returns the raw configured signer without falling back to msg.sender.
	/// @dev Access control must use this rather than signer(). signer() answers "who is acting"
	///      and can never be zero, so a proxy guard written against it would see msg.sender and
	///      conclude no signer was installed. This returns address(0) when none is, which is the
	///      distinction Accessibility's proxy guards depend on.
	function configuredSigner() internal view returns (address) {
		if (isTransientSignerActive()) return transientSigner();
		return GlobalAppStorage.layout().signer;
	}

	/// @notice Returns the effective signer, falling back to msg.sender when unset.
	function signer() internal view returns (address) {
		address configured = configuredSigner();
		return configured == address(0) ? msg.sender : configured;
	}

	/// @notice Installs or clears a transient signer override.
	/// @dev Passing zero ends the override rather than masking a persistent signer. Callers
	///      are required to start transient signer scopes only while the persistent signer is
	///      clear, so the two mechanisms cannot be ambiguously mixed.
	function setTransientSigner(address signerOrZero) internal {
		bytes32 signerSlot = TRANSIENT_SIGNER_SLOT;
		bytes32 activeSlot = TRANSIENT_SIGNER_ACTIVE_SLOT;
		uint256 active = signerOrZero == address(0) ? TRANSIENT_SIGNER_INACTIVE : TRANSIENT_SIGNER_ACTIVE;
		assembly ("memory-safe") {
			tstore(signerSlot, signerOrZero)
			tstore(activeSlot, active)
		}
	}

	/// @notice Temporarily clears the effective signer across an untrusted external call.
	/// @return previousSigner Raw signer to restore.
	/// @return wasTransientScoped Whether EIP-1153 transient storage owned the signer.
	function clearSignerForExternalCall() internal returns (address previousSigner, bool wasTransientScoped) {
		wasTransientScoped = isTransientSignerActive();
		if (wasTransientScoped) {
			previousSigner = transientSigner();
			_setTransientSignerValue(address(0));
		} else {
			GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
			previousSigner = globalLayout.signer;
			globalLayout.signer = address(0);
		}
	}

	/// @notice Restores a signer cleared by clearSignerForExternalCall.
	/// @dev Fails closed rather than overwriting: if the untrusted call installed a signer of
	///      its own, restoring on top of it would bless that value for the rest of the
	///      transaction. Both branches therefore verify the signer layer is empty first.
	///
	///      The two branches check a deliberately different set of slots.
	///      - Suspended from transient storage: the marker is NOT checked, because it is
	///        legitimately either state on return. It reads 1 when nothing touched it (our own
	///        suspension left it set), and 0 when a nested trusted scope opened and correctly
	///        closed itself, since closing writes the shared marker to 0. Only the two value
	///        slots must be empty, and the restore re-asserts the marker unconditionally.
	///      - Suspended from persistent storage: no transient signer scope was open at the
	///        boundary, so the marker must still be 0 on return. A set marker means untrusted
	///        code opened a scope and left it open, which is exactly what we refuse.
	function restoreSignerAfterExternalCall(address previousSigner, bool wasTransientScoped) internal {
		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
		if (wasTransientScoped) {
			if (globalLayout.signer != address(0) || transientSigner() != address(0)) revert ExternalCallSignerWasModified();
			_restoreTransientSigner(previousSigner);
		} else {
			if (globalLayout.signer != address(0) || isTransientSignerActive() || transientSigner() != address(0)) {
				revert ExternalCallSignerWasModified();
			}
			globalLayout.signer = previousSigner;
		}
	}

	/// @notice Temporarily removes all InstantLayer privileges across an untrusted call.
	/// @dev Handles both sources so a hook cannot inherit privilege regardless of which
	///      mechanism granted it. Returns 0 when there was nothing to suspend, which the
	///      caller must treat as "do not restore" -- see restoreExecutionContextAfterExternalCall.
	///      Note the persistent branch returns a snapshot WITHOUT bit 0 set; that is fine
	///      because only bit 254 selects how the value is read back.
	function suspendExecutionContextForExternalCall() internal returns (uint256 snapshot) {
		uint256 transientContext = _instantLayerContext();
		if (transientContext & INSTANT_CONTEXT_ACTIVE != 0) {
			snapshot = EXTERNAL_CONTEXT_SNAPSHOT_ACTIVE | EXTERNAL_CONTEXT_SNAPSHOT_TRANSIENT | transientContext;
			_setInstantLayerContext(0);
			return snapshot;
		}

		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
		if (!globalLayout.callFromInstantLayer && !globalLayout.instantOpenMode) return 0;

		snapshot = EXTERNAL_CONTEXT_SNAPSHOT_ACTIVE;
		if (globalLayout.callFromInstantLayer) snapshot |= EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_CALL;
		if (globalLayout.instantOpenMode) snapshot |= EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_OPEN;
		globalLayout.callFromInstantLayer = false;
		globalLayout.instantOpenMode = false;
	}

	/// @notice Restores a context returned by suspendExecutionContextForExternalCall.
	/// @dev Three distinct cases, in order: a 0 snapshot means nothing was suspended and this
	///      is a no-op; a non-zero snapshot without the marker bit was never produced by
	///      suspend() and is rejected as a caller error; anything else is a real snapshot.
	///      Before writing it back, BOTH sources must be empty -- the suspension emptied them,
	///      so anything present now was installed by the untrusted call, and restoring over it
	///      would let a hook smuggle privilege past the boundary.
	function restoreExecutionContextAfterExternalCall(uint256 snapshot) internal {
		if (snapshot == 0) return;
		if (snapshot & EXTERNAL_CONTEXT_SNAPSHOT_ACTIVE == 0) revert ExternalCallContextNotSuspended();

		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
		if (_instantLayerContext() != 0 || globalLayout.callFromInstantLayer || globalLayout.instantOpenMode) {
			revert ExternalCallContextWasModified();
		}

		if (snapshot & EXTERNAL_CONTEXT_SNAPSHOT_TRANSIENT != 0) {
			_setInstantLayerContext(snapshot & INSTANT_CONTEXT_FLAGS);
		} else {
			globalLayout.callFromInstantLayer = snapshot & EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_CALL != 0;
			globalLayout.instantOpenMode = snapshot & EXTERNAL_CONTEXT_SNAPSHOT_PERSISTENT_OPEN != 0;
		}
	}

	/// @notice Suspends the current execution context and binds its exact snapshot to msg.sender.
	/// @dev The cross-contract variant. An external router cannot hold the snapshot in memory
	///      across its own call, so core parks it — keyed by caller, so the router can neither
	///      choose what it restores nor reach another router's snapshot.
	///      The occupancy check rejects a second suspend by the same caller: without it the
	///      second call would overwrite the first snapshot and the outer restore would
	///      silently reinstate the wrong authority.
	function suspendExecutionContextForExternalCaller() internal returns (bool suspended) {
		bytes32 callerSlot = _externalCallContextSlot(msg.sender);
		if (_transientLoad(callerSlot) != 0) revert ExternalCallContextAlreadySuspended();

		uint256 snapshot = suspendExecutionContextForExternalCall();
		if (snapshot == 0) return false;
		_transientStore(callerSlot, snapshot);
		return true;
	}

	/// @notice Restores the exact execution context previously suspended by msg.sender.
	/// @dev Clears the caller's slot before applying the snapshot, so the same suspension can
	///      never be replayed twice within one transaction.
	function restoreExecutionContextForExternalCaller() internal {
		bytes32 callerSlot = _externalCallContextSlot(msg.sender);
		uint256 snapshot = _transientLoad(callerSlot);
		if (snapshot == 0) revert ExternalCallContextNotSuspended();
		_transientStore(callerSlot, 0);
		restoreExecutionContextAfterExternalCall(snapshot);
	}

	/// @notice Returns the raw transient-storage signer value, ignoring the active marker.
	/// @dev Callers wanting the effective signer should use signer() or configuredSigner().
	///      This exists so boundary checks can assert the value slot is genuinely empty.
	function transientSigner() internal view returns (address value) {
		bytes32 slot = TRANSIENT_SIGNER_SLOT;
		assembly ("memory-safe") {
			value := tload(slot)
		}
	}

	/// @dev Writes the signer value while leaving the active marker untouched, which is how a
	///      suspended scope stays identifiable as transient with no signer installed.
	function _setTransientSignerValue(address signerOrZero) private {
		bytes32 slot = TRANSIENT_SIGNER_SLOT;
		assembly ("memory-safe") {
			tstore(slot, signerOrZero)
		}
	}

	/// @dev Restores both pieces of a suspended signer scope. A trusted nested call may
	///      legitimately end its own signer scope, clearing the shared active bit before
	///      control returns to the outer boundary.
	function _restoreTransientSigner(address signer_) private {
		bytes32 signerSlot = TRANSIENT_SIGNER_SLOT;
		bytes32 activeSlot = TRANSIENT_SIGNER_ACTIVE_SLOT;
		assembly ("memory-safe") {
			tstore(signerSlot, signer_)
			tstore(activeSlot, TRANSIENT_SIGNER_ACTIVE)
		}
	}

	function _setInstantLayerContext(uint256 context) private {
		bytes32 slot = TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT;
		assembly ("memory-safe") {
			tstore(slot, context)
		}
	}

	function _instantLayerContext() private view returns (uint256 context) {
		bytes32 slot = TRANSIENT_INSTANT_LAYER_CONTEXT_SLOT;
		assembly ("memory-safe") {
			context := tload(slot)
		}
	}

	/// @dev Snapshots are namespaced per caller so two trusted routers can hold suspended
	///      contexts at the same time, and so no router can restore another router's snapshot.
	function _externalCallContextSlot(address caller) private pure returns (bytes32) {
		return keccak256(abi.encode(EXTERNAL_CALL_CONTEXT_NAMESPACE, caller));
	}

	function _transientLoad(bytes32 slot) private view returns (uint256 value) {
		assembly ("memory-safe") {
			value := tload(slot)
		}
	}

	function _transientStore(bytes32 slot, uint256 value) private {
		assembly ("memory-safe") {
			tstore(slot, value)
		}
	}

	function _configLayout() private pure returns (ConfigLayout storage layout_) {
		bytes32 slot = EXECUTION_CONTEXT_CONFIG_SLOT;
		assembly ("memory-safe") {
			layout_.slot := slot
		}
	}
}
