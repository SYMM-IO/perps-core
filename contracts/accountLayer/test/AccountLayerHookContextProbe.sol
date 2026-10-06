// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.34;

import { IAccountLayerHook } from "../interfaces/IAccountLayerHook.sol";
import { LibAccountLayerSigner } from "../libraries/LibAccountLayerSigner.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";

interface IAccountLayerHookContextCore {
	function beginInstantLayerExecution(bool instantOpenMode) external;

	function endInstantLayerExecution() external;

	function isCallFromInstantLayer() external view returns (bool);
}

interface IAccountLayerHookContextDiamond {
	function setTransientSigner(address signer) external;

	function getSigner() external view returns (address);

	function _call(address account, bytes[] calldata callDatas) external returns (bytes[] memory);
}

/// @notice Test-only trusted router that models an InstantLayer AccountLayer operation.
contract AccountLayerHookContextProbe {
	error ContextMismatch();
	error SignerMismatch();

	bool public contextRestoredAfterHook;
	address public signerRestoredAfterHook;

	function run(address coreAddress, address accountLayerAddress, address owner, address account, bytes calldata callData) external {
		IAccountLayerHookContextCore core = IAccountLayerHookContextCore(coreAddress);
		IAccountLayerHookContextDiamond accountLayer = IAccountLayerHookContextDiamond(accountLayerAddress);
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = callData;

		core.beginInstantLayerExecution(true);
		accountLayer.setTransientSigner(owner);
		accountLayer._call(account, callDatas);
		signerRestoredAfterHook = accountLayer.getSigner();
		if (signerRestoredAfterHook != owner) revert SignerMismatch();
		accountLayer.setTransientSigner(address(0));

		contextRestoredAfterHook = core.isCallFromInstantLayer();
		if (!contextRestoredAfterHook) revert ContextMismatch();
		core.endInstantLayerExecution();
	}
}

/// @notice Test-only probe for exact signer restoration across a nested trusted scope.
contract AccountLayerSignerRestoreProbe {
	bool public signerActiveAfterNestedCall;
	address public signerRestoredAfterNestedCall;

	function run(address outerSigner, address nestedSigner) external {
		LibAccountLayerSigner.setTransientSigner(outerSigner);
		(address previousSigner, bool wasTransient) = LibAccountLayerSigner.clearSignerForExternalCall();
		LibAccountLayerSigner.setTransientSigner(nestedSigner);
		LibAccountLayerSigner.setTransientSigner(address(0));
		LibAccountLayerSigner.restoreSignerAfterExternalCall(previousSigner, wasTransient);
		signerActiveAfterNestedCall = LibAccountLayerSigner.isTransientSignerActive();
		signerRestoredAfterNestedCall = LibAccountLayerSigner.configuredSigner();
		LibAccountLayerSigner.setTransientSigner(address(0));
	}

	function rejectTransientSignerInjectedIntoPersistentBoundary(address persistentSigner, address injectedSigner) external {
		AccountStorage.layout().globalSigner = persistentSigner;
		(address previousSigner, bool wasTransient) = LibAccountLayerSigner.clearSignerForExternalCall();
		LibAccountLayerSigner.setTransientSigner(injectedSigner);
		LibAccountLayerSigner.restoreSignerAfterExternalCall(previousSigner, wasTransient);
	}

	function rejectPersistentSignerLeftInPersistentBoundary(address persistentSigner, address injectedSigner) external {
		AccountStorage.layout().globalSigner = persistentSigner;
		(address previousSigner, bool wasTransient) = LibAccountLayerSigner.clearSignerForExternalCall();
		AccountStorage.layout().globalSigner = injectedSigner;
		LibAccountLayerSigner.restoreSignerAfterExternalCall(previousSigner, wasTransient);
	}

	function rejectPersistentSignerInjectedIntoTransientBoundary(address transientSigner, address injectedSigner) external {
		LibAccountLayerSigner.setTransientSigner(transientSigner);
		(address previousSigner, bool wasTransient) = LibAccountLayerSigner.clearSignerForExternalCall();
		AccountStorage.layout().globalSigner = injectedSigner;
		LibAccountLayerSigner.restoreSignerAfterExternalCall(previousSigner, wasTransient);
	}

	function rejectTransientSignerLeftInTransientBoundary(address transientSigner, address injectedSigner) external {
		LibAccountLayerSigner.setTransientSigner(transientSigner);
		(address previousSigner, bool wasTransient) = LibAccountLayerSigner.clearSignerForExternalCall();
		LibAccountLayerSigner.setTransientSigner(injectedSigner);
		LibAccountLayerSigner.restoreSignerAfterExternalCall(previousSigner, wasTransient);
	}

	function restoreTransientSignerAfterClearedPersistentScope(address transientSigner, address nestedSigner) external {
		LibAccountLayerSigner.setTransientSigner(transientSigner);
		(address previousSigner, bool wasTransient) = LibAccountLayerSigner.clearSignerForExternalCall();
		AccountStorage.layout().globalSigner = nestedSigner;
		AccountStorage.layout().globalSigner = address(0);
		LibAccountLayerSigner.restoreSignerAfterExternalCall(previousSigner, wasTransient);
		signerActiveAfterNestedCall = LibAccountLayerSigner.isTransientSignerActive();
		signerRestoredAfterNestedCall = LibAccountLayerSigner.configuredSigner();
		LibAccountLayerSigner.setTransientSigner(address(0));
	}
}

/// @notice Affiliate hook proving AccountLayer does not leak the core context while the
///         surrounding trusted AccountLayer operation remains inside that context.
contract MaliciousAccountLayerContextHook is IAccountLayerHook {
	address public immutable core;
	bool public observedCallFromInstantLayer;
	uint256 public calls;
	bool public shouldRevert;

	constructor(address core_) {
		core = core_;
	}

	function setShouldRevert(bool value) external {
		shouldRevert = value;
	}

	function onAccountCreation(address, address, bytes memory) external pure returns (bool) {
		return true;
	}

	function onVirtualAccountCreation(address, address, bytes memory) external pure returns (bool) {
		return true;
	}

	function onVirtualAccountDeletion(address) external {}

	function onSubAccountDeletion(address, address) external {}

	function onSubAccountOwnershipTransfer(address, address, address) external {}

	function onCall(address, bytes[] memory) external {
		if (shouldRevert) revert("MaliciousAccountLayerContextHook");
		observedCallFromInstantLayer = IAccountLayerHookContextCore(core).isCallFromInstantLayer();
		calls++;
	}
}
