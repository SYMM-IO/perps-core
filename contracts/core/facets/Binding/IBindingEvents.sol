// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IBindingEvents {
	event BindToPartyB(address partyA, address partyB);
	event RequestToUnbindFromPartyB(address partyA);
	event CancelUnbindRequest(address partyA);
	event CompleteUnbindRequest(address partyA, address partyB);
	// Instant Actions Events
	event ActivateInstantActionMode(address partyA, uint256 time);
	event ProposeToDeactivateInstantActionMode(address partyA, uint256 time);
	event DeactivateInstantActionMode(address partyA, uint256 time);
}
