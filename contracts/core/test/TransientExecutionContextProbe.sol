// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.34;

interface ITransientContextCore {
	function setCallFromInstantLayer(bool enabled) external;

	function setInstantOpenMode(bool enabled) external;

	function beginInstantLayerExecution(bool instantOpenMode) external;

	function endInstantLayerExecution() external;

	function setSigner(address signer) external;

	function setTransientSigner(address signer) external;

	function isCallFromInstantLayer() external view returns (bool);

	function getSigner() external view returns (address);
}

interface ITransientContextAccountLayer {
	function setSigner(address signer) external;

	function setTransientSigner(address signer) external;

	function getSigner() external view returns (address);
}

/// @notice Test-only probe that exercises the real role-gated diamond context setters.
contract TransientExecutionContextProbe {
	error ContextMismatch();

	function beginTwice(address coreAddress) external {
		ITransientContextCore core = ITransientContextCore(coreAddress);
		core.beginInstantLayerExecution(true);
		core.beginInstantLayerExecution(true);
	}

	function endWithoutBegin(address coreAddress) external {
		ITransientContextCore(coreAddress).endInstantLayerExecution();
	}

	function beginSetSignerThenEnd(address coreAddress, address signer) external {
		ITransientContextCore core = ITransientContextCore(coreAddress);
		core.beginInstantLayerExecution(true);
		core.setTransientSigner(signer);
		core.endInstantLayerExecution();
	}

	function setCoreTransientThenPersistent(address coreAddress, address transientSigner, address persistentSigner) external {
		ITransientContextCore core = ITransientContextCore(coreAddress);
		core.setTransientSigner(transientSigner);
		core.setSigner(persistentSigner);
	}

	function setAccountLayerTransientThenPersistent(address accountLayerAddress, address transientSigner, address persistentSigner) external {
		ITransientContextAccountLayer accountLayer = ITransientContextAccountLayer(accountLayerAddress);
		accountLayer.setTransientSigner(transientSigner);
		accountLayer.setSigner(persistentSigner);
	}

	function legacyBeginTwice(address coreAddress) external {
		ITransientContextCore core = ITransientContextCore(coreAddress);
		core.setCallFromInstantLayer(true);
		core.setCallFromInstantLayer(true);
	}

	function legacyEndWithoutBegin(address coreAddress) external {
		ITransientContextCore(coreAddress).setCallFromInstantLayer(false);
	}

	/// @notice Leaves the transient mode set to prove the EIP-1153 transaction boundary
	///         is a final cleanup backstop. Production InstantLayer always ends explicitly.
	function beginWithoutExplicitEnd(address coreAddress) external {
		ITransientContextCore core = ITransientContextCore(coreAddress);
		core.beginInstantLayerExecution(true);
		if (!core.isCallFromInstantLayer()) revert ContextMismatch();
	}

	/// @notice Models the context writes performed by two PartyA operations in InstantOpen.
	function runPersistentContext(address coreAddress, address accountLayerAddress, address owner, address account, uint256 iterations) external {
		ITransientContextCore core = ITransientContextCore(coreAddress);
		ITransientContextAccountLayer accountLayer = ITransientContextAccountLayer(accountLayerAddress);

		core.setCallFromInstantLayer(true);
		core.setInstantOpenMode(true);
		if (!core.isCallFromInstantLayer()) revert ContextMismatch();

		for (uint256 i; i < iterations; i++) {
			accountLayer.setSigner(owner);
			if (accountLayer.getSigner() != owner) revert ContextMismatch();
			core.setSigner(account);
			if (core.getSigner() != account) revert ContextMismatch();
			core.setSigner(address(0));
			accountLayer.setSigner(address(0));
		}

		core.setInstantOpenMode(false);
		core.setCallFromInstantLayer(false);
	}

	/// @notice Executes the equivalent context lifecycle using EIP-1153 state.
	function runTransientContext(address coreAddress, address accountLayerAddress, address owner, address account, uint256 iterations) external {
		ITransientContextCore core = ITransientContextCore(coreAddress);
		ITransientContextAccountLayer accountLayer = ITransientContextAccountLayer(accountLayerAddress);

		core.beginInstantLayerExecution(true);
		if (!core.isCallFromInstantLayer()) revert ContextMismatch();

		for (uint256 i; i < iterations; i++) {
			accountLayer.setTransientSigner(owner);
			if (accountLayer.getSigner() != owner) revert ContextMismatch();
			core.setTransientSigner(account);
			if (core.getSigner() != account) revert ContextMismatch();
			core.setTransientSigner(address(0));
			accountLayer.setTransientSigner(address(0));
		}

		core.endInstantLayerExecution();
		if (core.isCallFromInstantLayer()) revert ContextMismatch();
	}
}
