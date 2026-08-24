// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.34;

import { AccountStorage } from "../storages/AccountStorage.sol";

/// @title LibAccountLayerSigner
/// @notice Resolves persistent and transient signer contexts for the AccountLayer diamond.
/// @dev A transient signer is the effective account owner whose authorization has already
///      been verified by the routing layer. It is not a signature cache. The separate
///      active marker lets an external-call boundary clear the signer value temporarily
///      while still remembering that the outer scope must be restored from EIP-1153 state.
///
///      PRE-CANCUN PORT
///      This is the AccountLayer half of the transient implementation; core's half is
///      LibExecutionContext, whose header carries the full porting checklist. Between
///      them they are the only production files emitting tload/tstore.
///      For a pre-Cancun build, reimplement _transientLoad/_transientStore at the bottom of
///      this file against a persistent slot-keyed mapping; configuredSigner() and every
///      boundary check above them then work unchanged, so no call site changes.
library LibAccountLayerSigner {
	bytes32 private constant TRANSIENT_SIGNER_SLOT = keccak256("symmio.account-layer.transient.signer");
	bytes32 private constant TRANSIENT_SIGNER_ACTIVE_SLOT = keccak256("symmio.account-layer.transient.signer.active");
	bytes32 private constant TRANSIENT_SIGNER_SCOPE_SLOT = keccak256("symmio.account-layer.transient.signer.scope");
	bytes32 private constant TRANSIENT_EXPECTED_CALLBACK_CORE_SLOT = keccak256("symmio.account-layer.transient.expected-callback-core");
	bytes32 private constant TRANSIENT_CALLBACK_ACTIVE_SLOT = keccak256("symmio.account-layer.transient.callback-active");
	uint256 private constant TRANSIENT_SIGNER_INACTIVE = 0;
	uint256 private constant TRANSIENT_SIGNER_ACTIVE = 1;

	/// @dev The external call left a signer installed in either storage mechanism. Restoring on
	///      top of it would hand the hook's signer authority to the rest of the transaction, so
	///      the boundary fails closed instead.
	error ExternalCallSignerWasModified();

	/// @notice Whether a transient signer scope is currently open.
	/// @dev Also decides which mechanism the AccountLayer uses when it opens a matching signer
	///      scope on core, so the two layers never disagree about signer lifetime.
	function isTransientSignerActive() internal view returns (bool) {
		return _transientLoad(TRANSIENT_SIGNER_ACTIVE_SLOT) != TRANSIENT_SIGNER_INACTIVE;
	}

	/// @notice Returns the raw configured signer, without falling back to msg.sender.
	/// @dev Access-control checks use this rather than signer() precisely because they need to
	///      distinguish "no signer installed" from "the caller is acting for themselves".
	function configuredSigner() internal view returns (address) {
		if (isTransientSignerActive()) return transientSigner();
		return AccountStorage.layout().globalSigner;
	}

	/// @notice Returns the effective signer, falling back to msg.sender when none is installed.
	function signer() internal view returns (address) {
		address configured = configuredSigner();
		return configured == address(0) ? msg.sender : configured;
	}

	/// @notice Installs or clears the effective signer for the current transaction.
	/// @dev Passing zero ends the transient signer scope. The role-gated external command
	///      prevents this scope from starting over a persistent signer. Always opens an
	///      unconfined session, mirroring setSigner on the persistent side, so this path
	///      can never leave a stale account scope behind for the next caller.
	function setTransientSigner(address signerOrZero) internal {
		setTransientSignerScoped(signerOrZero, address(0));
	}

	/// @notice Installs the effective signer for the current transaction, confined to one account family.
	/// @dev Transient counterpart of the persistent scoped-signer session: a router executing on
	///      behalf of a delegate supplies the account family the delegation was granted over, and
	///      requireAccountInScope rejects anything outside it. A zero scope is unconfined, and
	///      clearing the signer always clears the scope with it.
	function setTransientSignerScoped(address signerOrZero, address scope) internal {
		_setTransientSignerValue(signerOrZero);
		_transientStore(TRANSIENT_SIGNER_ACTIVE_SLOT, signerOrZero == address(0) ? TRANSIENT_SIGNER_INACTIVE : TRANSIENT_SIGNER_ACTIVE);
		_transientStore(TRANSIENT_SIGNER_SCOPE_SLOT, signerOrZero == address(0) ? 0 : uint256(uint160(scope)));
	}

	/// @notice Returns the transient account scope confining the current signer session.
	function transientScope() internal view returns (address) {
		return address(uint160(_transientLoad(TRANSIENT_SIGNER_SCOPE_SLOT)));
	}

	/// @notice Returns the account scope confining the active signer session, if any.
	/// @dev Mirrors configuredSigner(): the mechanism that owns the signer also owns its scope,
	///      so the delegation confinement applies identically on both storage paths.
	function effectiveScope() internal view returns (address) {
		if (isTransientSignerActive()) return transientScope();
		return AccountStorage.layout().scopedAccount;
	}

	/// @notice Temporarily removes delegated signer authority before untrusted code runs.
	/// @return previousSigner Exact raw signer value to restore after the call.
	/// @return wasTransientScoped Whether EIP-1153 transient storage owned the suspended value.
	function clearSignerForExternalCall() internal returns (address previousSigner, bool wasTransientScoped) {
		wasTransientScoped = isTransientSignerActive();
		if (wasTransientScoped) {
			previousSigner = transientSigner();
			_setTransientSignerValue(address(0));
		} else {
			AccountStorage.Layout storage accountLayout = AccountStorage.layout();
			previousSigner = accountLayout.globalSigner;
			accountLayout.globalSigner = address(0);
		}
	}

	/// @notice Restores a signer suspended by clearSignerForExternalCall.
	/// @dev Fails closed if the external call leaves either signer source populated.
	///      This prevents a hook from installing authority that outlives its call frame.
	function restoreSignerAfterExternalCall(address previousSigner, bool wasTransientScoped) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (wasTransientScoped) {
			// A nested scope may clear the active marker, but it must not leave either
			// signer source populated when control returns to the boundary.
			if (accountLayout.globalSigner != address(0) || transientSigner() != address(0)) revert ExternalCallSignerWasModified();
			_restoreTransientSigner(previousSigner);
		} else {
			if (accountLayout.globalSigner != address(0) || isTransientSignerActive() || transientSigner() != address(0)) {
				revert ExternalCallSignerWasModified();
			}
			accountLayout.globalSigner = previousSigner;
		}
	}

	/// @notice Returns the raw transient-storage signer value, ignoring the active marker.
	/// @dev Used by boundary checks that must assert the value slot is genuinely empty. For the
	///      effective signer use signer() or configuredSigner().
	function transientSigner() internal view returns (address) {
		return address(uint160(_transientLoad(TRANSIENT_SIGNER_SLOT)));
	}

	/// @notice Marks the core currently allowed to synchronously callback into guarded AccountLayer hooks.
	/// @dev The previous value is returned so nested core calls made during callback cleanup can restore
	///      the outer boundary exactly.
	function pushExpectedCallbackCore(address core) internal returns (address previousCore) {
		previousCore = expectedCallbackCore();
		_transientStore(TRANSIENT_EXPECTED_CALLBACK_CORE_SLOT, uint256(uint160(core)));
	}

	/// @notice Restores the callback core that was active before pushExpectedCallbackCore.
	function restoreExpectedCallbackCore(address previousCore) internal {
		_transientStore(TRANSIENT_EXPECTED_CALLBACK_CORE_SLOT, uint256(uint160(previousCore)));
	}

	/// @notice Returns the only core allowed to enter a callback while the ordinary guard is active.
	function expectedCallbackCore() internal view returns (address) {
		return address(uint160(_transientLoad(TRANSIENT_EXPECTED_CALLBACK_CORE_SLOT)));
	}

	/// @notice Whether a guarded system callback is already executing in this transaction.
	function isCallbackActive() internal view returns (bool) {
		return _transientLoad(TRANSIENT_CALLBACK_ACTIVE_SLOT) != 0;
	}

	/// @notice Opens or closes the single permitted callback frame.
	function setCallbackActive(bool active) internal {
		_transientStore(TRANSIENT_CALLBACK_ACTIVE_SLOT, active ? 1 : 0);
	}

	/// @dev Writes the signer value while leaving the active marker untouched, which is how a
	///      suspended scope stays identifiable as transient with no signer installed.
	function _setTransientSignerValue(address signerOrZero) private {
		_transientStore(TRANSIENT_SIGNER_SLOT, uint256(uint160(signerOrZero)));
	}

	/// @dev Restore the value and active marker because a nested trusted scope may have
	///      cleared both while the outer signer was suspended.
	function _restoreTransientSigner(address signer_) private {
		_setTransientSignerValue(signer_);
		_transientStore(TRANSIENT_SIGNER_ACTIVE_SLOT, TRANSIENT_SIGNER_ACTIVE);
	}

	// ── The only EIP-1153 primitives in the AccountLayer diamond ──────────────
	// Mirror of the pair at the bottom of LibExecutionContext. Every transient read
	// and write above funnels through these two, which is what keeps the PRE-CANCUN
	// PORT a two-function change here as well. New transient state should add a slot
	// constant and a typed accessor calling these, not another assembly block.

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
}
