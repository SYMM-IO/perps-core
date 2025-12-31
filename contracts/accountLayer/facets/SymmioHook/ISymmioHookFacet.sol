// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

interface ISymmioHookFacetEvents {
	event VirtualAccountDeleted(address indexed account, address indexed parent);
}

interface ISymmioHookFacet is ISymmioHookFacetEvents, IAccountLayerErrors {
	function onClosePosition(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, address partyA, address partyB) external;

	function onCancelQuote(uint256 quoteId, address partyA, address partyB) external;

}
