// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.34;

import { LibExecutionContext } from "../libraries/LibExecutionContext.sol";
import { LibHook } from "../libraries/LibHook.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";
import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";

/// @notice Test-only harness exercising the exact LibHook boundary used by core facets.
contract HookExecutionContextHarness {
	bool public contextRestoredAfterHook;
	bool public signerActiveAfterNestedHook;
	address public signerRestoredAfterNestedHook;
	uint256 public malformedLegacyWrites;

	function runProtectedHook(address hook) external {
		LibExecutionContext.beginInstantLayerExecution(true);
		LibHook.safeCall(hook, abi.encodeCall(ISymmioHook.onOpenPosition, (1, 1, 1, address(this), address(this))), 1);
		contextRestoredAfterHook = LibExecutionContext.isCallFromInstantLayer() && LibExecutionContext.isInstantOpenMode();
		LibExecutionContext.endInstantLayerExecution();
	}

	function runProtectedPersistentHook(address hook) external {
		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
		globalLayout.callFromInstantLayer = true;
		globalLayout.instantOpenMode = true;
		LibHook.safeCall(hook, abi.encodeCall(ISymmioHook.onOpenPosition, (1, 1, 1, address(this), address(this))), 1);
		contextRestoredAfterHook = LibExecutionContext.isCallFromInstantLayer() && LibExecutionContext.isInstantOpenMode();
		globalLayout.instantOpenMode = false;
		globalLayout.callFromInstantLayer = false;
	}

	function runRevertingHook(address hook) external {
		LibExecutionContext.beginInstantLayerExecution(true);
		LibHook.safeCall(hook, abi.encodeCall(ISymmioHook.onOpenPosition, (1, 1, 1, address(this), address(this))), 1);
		LibExecutionContext.endInstantLayerExecution();
	}

	/// @notice Models the AccountLayer system hook opening and closing its own core signer
	///         scope while an outer transient signer is suspended by LibHook.
	function runProtectedNestedSignerHook(address hook, address signer) external {
		LibExecutionContext.beginInstantLayerExecution(true);
		LibExecutionContext.setTransientSigner(signer);
		LibHook.safeCall(hook, abi.encodeCall(ISymmioHook.onOpenPosition, (1, 1, 1, address(this), address(this))), 1);
		signerActiveAfterNestedHook = LibExecutionContext.isTransientSignerActive();
		signerRestoredAfterNestedHook = LibExecutionContext.configuredSigner();
		LibExecutionContext.setTransientSigner(address(0));
		LibExecutionContext.endInstantLayerExecution();
	}

	function cycleNestedTransientSigner(address signer) external {
		LibExecutionContext.setTransientSigner(signer);
		LibExecutionContext.setTransientSigner(address(0));
	}

	/// @notice Models a nested trusted path leaving transient authority behind while
	///         a persistent signer is suspended at an external-call boundary.
	function rejectTransientSignerInjectedIntoPersistentBoundary(address persistentSigner, address injectedSigner) external {
		GlobalAppStorage.layout().signer = persistentSigner;
		(address previousSigner, bool wasTransient) = LibExecutionContext.clearSignerForExternalCall();
		LibExecutionContext.setTransientSigner(injectedSigner);
		LibExecutionContext.restoreSignerAfterExternalCall(previousSigner, wasTransient);
	}

	function rejectPersistentSignerLeftInPersistentBoundary(address persistentSigner, address injectedSigner) external {
		GlobalAppStorage.layout().signer = persistentSigner;
		(address previousSigner, bool wasTransient) = LibExecutionContext.clearSignerForExternalCall();
		GlobalAppStorage.layout().signer = injectedSigner;
		LibExecutionContext.restoreSignerAfterExternalCall(previousSigner, wasTransient);
	}

	/// @notice Models a nested trusted path leaving persistent authority behind while
	///         a transient signer is suspended at an external-call boundary.
	function rejectPersistentSignerInjectedIntoTransientBoundary(address transientSigner, address injectedSigner) external {
		LibExecutionContext.setTransientSigner(transientSigner);
		(address previousSigner, bool wasTransient) = LibExecutionContext.clearSignerForExternalCall();
		GlobalAppStorage.layout().signer = injectedSigner;
		LibExecutionContext.restoreSignerAfterExternalCall(previousSigner, wasTransient);
	}

	function rejectTransientSignerLeftInTransientBoundary(address transientSigner, address injectedSigner) external {
		LibExecutionContext.setTransientSigner(transientSigner);
		(address previousSigner, bool wasTransient) = LibExecutionContext.clearSignerForExternalCall();
		LibExecutionContext.setTransientSigner(injectedSigner);
		LibExecutionContext.restoreSignerAfterExternalCall(previousSigner, wasTransient);
	}

	function restoreTransientSignerAfterClearedPersistentScope(address transientSigner, address nestedSigner) external {
		LibExecutionContext.setTransientSigner(transientSigner);
		(address previousSigner, bool wasTransient) = LibExecutionContext.clearSignerForExternalCall();
		GlobalAppStorage.layout().signer = nestedSigner;
		GlobalAppStorage.layout().signer = address(0);
		LibExecutionContext.restoreSignerAfterExternalCall(previousSigner, wasTransient);
		signerActiveAfterNestedHook = LibExecutionContext.isTransientSignerActive();
		signerRestoredAfterNestedHook = LibExecutionContext.configuredSigner();
		LibExecutionContext.setTransientSigner(address(0));
	}

	/// @notice Reaches the active-but-zero signer state used only while an external call is in progress.
	function endWithSuspendedTransientSigner() external {
		LibExecutionContext.beginInstantLayerExecution(true);
		LibExecutionContext.setTransientSigner(address(this));
		LibExecutionContext.clearSignerForExternalCall();
		LibExecutionContext.endInstantLayerExecution();
	}

	function isCallFromInstantLayer() external view returns (bool) {
		return LibExecutionContext.isCallFromInstantLayer();
	}

	function isInstantOpenMode() external view returns (bool) {
		return LibExecutionContext.isInstantOpenMode();
	}

	/// @notice Models the noneligible legacy-quote branch that becomes malformed if a
	///         reentrant hook inherits instant-open bookkeeping skips.
	function writeMalformedLegacyRecord() external {
		require(LibExecutionContext.isInstantOpenMode(), "HookHarness: no instant-open privilege");
		malformedLegacyWrites++;
	}
}

interface IHookExecutionContextHarness {
	function isCallFromInstantLayer() external view returns (bool);

	function isInstantOpenMode() external view returns (bool);

	function writeMalformedLegacyRecord() external;

	function cycleNestedTransientSigner(address signer) external;
}

/// @notice Malicious hook that probes and attempts to consume the caller's privileges.
contract MaliciousExecutionContextHook is ISymmioHook {
	bool public observedCallFromInstantLayer;
	bool public observedInstantOpenMode;
	bool public malformedWriteSucceeded;

	function onOpenPosition(uint256, uint256, uint256, address, address) external override {
		IHookExecutionContextHarness harness = IHookExecutionContextHarness(msg.sender);
		observedCallFromInstantLayer = harness.isCallFromInstantLayer();
		observedInstantOpenMode = harness.isInstantOpenMode();
		(bool success, ) = msg.sender.call(abi.encodeCall(IHookExecutionContextHarness.writeMalformedLegacyRecord, ()));
		malformedWriteSucceeded = success;
	}

	function onClosePosition(uint256, uint256, uint256, address, address) external override {}

	function onCancelQuote(uint256, address, address) external override {}

	function onCloseExpired(uint256, address, address) external override {}

	function onFeeCharged(uint256, uint256, address, address, uint256, address, TradingFeeType) external override {}

	function onLiquidationSettled(address) external override {}
}

contract RevertingExecutionContextHook is ISymmioHook {
	function onOpenPosition(uint256, uint256, uint256, address, address) external pure override {
		revert("RevertingExecutionContextHook");
	}

	function onClosePosition(uint256, uint256, uint256, address, address) external override {}

	function onCancelQuote(uint256, address, address) external override {}

	function onCloseExpired(uint256, address, address) external override {}

	function onFeeCharged(uint256, uint256, address, address, uint256, address, TradingFeeType) external override {}

	function onLiquidationSettled(address) external override {}
}

/// @notice Models the trusted AccountLayer system hook's nested core signer scope.
contract NestedSignerExecutionContextHook is ISymmioHook {
	function onOpenPosition(uint256, uint256, uint256, address, address) external override {
		IHookExecutionContextHarness(msg.sender).cycleNestedTransientSigner(address(this));
	}

	function onClosePosition(uint256, uint256, uint256, address, address) external override {}

	function onCancelQuote(uint256, address, address) external override {}

	function onCloseExpired(uint256, address, address) external override {}

	function onFeeCharged(uint256, uint256, address, address, uint256, address, TradingFeeType) external override {}

	function onLiquidationSettled(address) external override {}
}
