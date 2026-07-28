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
library LibAccountLayerSigner {
	bytes32 private constant SIGNER_CONFIG_SLOT = keccak256("symmio.account-layer.signer.config");
	bytes32 private constant TRANSIENT_SIGNER_SLOT = keccak256("symmio.account-layer.transient.signer");
	bytes32 private constant TRANSIENT_SIGNER_ACTIVE_SLOT = keccak256("symmio.account-layer.transient.signer.active");
	bytes32 private constant TRANSIENT_SIGNER_SCOPE_SLOT = keccak256("symmio.account-layer.transient.signer.scope");
	uint256 private constant TRANSIENT_SIGNER_INACTIVE = 0;
	uint256 private constant TRANSIENT_SIGNER_ACTIVE = 1;

	/// @dev The external call left a signer installed in either storage mechanism. Restoring on
	///      top of it would hand the hook's signer authority to the rest of the transaction, so
	///      the boundary fails closed instead.
	error ExternalCallSignerWasModified();

	struct ConfigLayout {
		/// @notice Legacy routers whose unchanged setSigner(address) sequence should be
		///         adapted to transient EIP-1153 state.
		mapping(address => bool) legacySetSignerUsesTransientScope;
	}

	/// @notice Configures the compatibility adapter for one legacy setSigner caller.
	/// @dev This does not authorize the caller and does not install a signer.
	function configureLegacySetSignerAdapter(address legacyRouter, bool enabled) internal {
		_configLayout().legacySetSignerUsesTransientScope[legacyRouter] = enabled;
	}

	/// @notice Returns whether a caller's legacy setSigner calls use transient storage.
	function legacySetSignerUsesTransientScope(address legacyRouter) internal view returns (bool) {
		return _configLayout().legacySetSignerUsesTransientScope[legacyRouter];
	}

	/// @notice Whether a transient signer scope is currently open.
	/// @dev Also decides which mechanism the AccountLayer uses when it opens a matching signer
	///      scope on core, so the two layers never disagree about signer lifetime.
	function isTransientSignerActive() internal view returns (bool active) {
		bytes32 slot = TRANSIENT_SIGNER_ACTIVE_SLOT;
		assembly ("memory-safe") {
			active := tload(slot)
		}
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
	///      unconfined session — mirroring setSigner on the persistent side — so this path
	///      can never leave a stale account scope behind for the next caller.
	function setTransientSigner(address signerOrZero) internal {
		setTransientSignerScoped(signerOrZero, address(0));
	}

	/// @notice Installs the effective signer for the current transaction, confined to one account family.
	/// @dev Transient counterpart of the persistent scoped-signer session: a router executing on
	///      behalf of a delegate supplies the account family the delegation was granted over, and
	///      requireAccountInScope rejects anything outside it. A zero scope is unconfined.
	function setTransientSignerScoped(address signerOrZero, address scope) internal {
		bytes32 signerSlot = TRANSIENT_SIGNER_SLOT;
		bytes32 activeSlot = TRANSIENT_SIGNER_ACTIVE_SLOT;
		bytes32 scopeSlot = TRANSIENT_SIGNER_SCOPE_SLOT;
		uint256 active = signerOrZero == address(0) ? TRANSIENT_SIGNER_INACTIVE : TRANSIENT_SIGNER_ACTIVE;
		if (signerOrZero == address(0)) scope = address(0);
		assembly ("memory-safe") {
			tstore(signerSlot, signerOrZero)
			tstore(activeSlot, active)
			tstore(scopeSlot, scope)
		}
	}

	/// @notice Returns the transient account scope confining the current signer session.
	function transientScope() internal view returns (address value) {
		bytes32 slot = TRANSIENT_SIGNER_SCOPE_SLOT;
		assembly ("memory-safe") {
			value := tload(slot)
		}
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

	/// @dev Restore the value and active marker because a nested trusted scope may have
	///      cleared both while the outer signer was suspended.
	function _restoreTransientSigner(address signer_) private {
		bytes32 signerSlot = TRANSIENT_SIGNER_SLOT;
		bytes32 activeSlot = TRANSIENT_SIGNER_ACTIVE_SLOT;
		assembly ("memory-safe") {
			tstore(signerSlot, signer_)
			tstore(activeSlot, TRANSIENT_SIGNER_ACTIVE)
		}
	}

	function _configLayout() private pure returns (ConfigLayout storage layout_) {
		bytes32 slot = SIGNER_CONFIG_SLOT;
		assembly ("memory-safe") {
			layout_.slot := slot
		}
	}
}
