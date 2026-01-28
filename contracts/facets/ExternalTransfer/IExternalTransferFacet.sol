// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IExternalTransferEvents } from "./IExternalTransferEvents.sol";

interface IExternalTransferFacet is IExternalTransferEvents {
	function externalTransfer(address receiver, uint256 amount, address target) external;

	function virtualExternalTransfer(address receiver, uint256 amount, address target, address virtualProvider) external;

	function acceptVirtualExternalTransfer(uint256 id) external;

	function cancelVirtualExternalTransfer(uint256 id) external;
}
