// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IAssuranceEvents {
	event AssuranceCollateralDeposited(address indexed user, address indexed token, uint256 amount);
	event AssuranceWithdrawRequested(address indexed user, address indexed token, uint256 amount, address recipient);
	event AssuranceWithdrawApproved(address indexed user, address indexed token, uint256 amount);
	event AssuranceWithdrawCancelled(address indexed user, address indexed token, uint256 amount);
	event UserSlashed(address indexed user, address indexed token, uint256 amount, address recipient);
}
