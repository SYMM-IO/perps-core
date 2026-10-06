// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPledgeEvents } from "./IPledgeEvents.sol";

interface IPledgeFacet is IPledgeEvents {
	function depositPledge(address token, uint256 amount) external;

	function requestPledgeWithdraw(address token, uint256 amount, address recipient) external;

	function cancelPledgeWithdraw() external;

	function acceptPledgeWithdraw(address user, uint256 amount, address token) external;

	function slashPledge(address user, address token, uint256 amount, address recipient) external;
}
