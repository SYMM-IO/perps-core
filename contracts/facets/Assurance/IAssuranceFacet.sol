// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAssuranceEvents } from "./IAssuranceEvents.sol";

interface IAssuranceFacet is IAssuranceEvents {
	function depositAssuranceCollateral(address token, uint256 amount) external;

	function requestAssuranceWithdraw(address token, uint256 amount, address recipient) external;

	function cancelAssuranceWithdraw() external;

	function acceptAssuranceWithdraw(address user, uint256 amount, address token) external;

	function slashUser(address user, address token, uint256 amount, address recipient) external;
}
