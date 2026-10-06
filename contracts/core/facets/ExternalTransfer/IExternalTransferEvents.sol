// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IExternalTransferEvents {
	event ExternalTransfer(address indexed sender, address indexed receiver, uint256 amount, address target);
	event InitiateVirtualExternalTransfer(uint256 id, address sender, address receiver, uint256 amount, address target, address provider);
	event AcceptVirtualExternalTransfer(uint256 id);
	event CancelVirtualExternalTransfer(uint256 id);
}
