// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IControlEvents {
	event GeneralDeposit(uint256 amount);
	event GeneralWithdraw(uint256 amount);
	event AffiliateDeposit(address indexed affiliate, uint256 amount);
	event AffiliateWithdraw(address indexed affiliate, uint256 amount);
	event AffiliateConfigUpdated(address indexed affiliate, uint256 feeRate, uint256 operatorFee);
	event FeesClaimed(address indexed affiliate, uint256 amount);
	event SponsorDeposit(address indexed affiliate, uint256 amount);
	event SponsorWithdraw(address indexed affiliate, uint256 amount);
	event SponsorConfigUpdated(address indexed affiliate, uint256 maxFeePerWithdraw, uint256 maxWithdrawAmount);
	event OperatorFeesClaimed(address indexed affiliate, uint256 amount);
	event MinValidatorSignaturesUpdated(address indexed affiliate, uint256 minValidatorSignatures);
	event ValidatorApprovalTimeoutUpdated(address indexed affiliate, uint256 timeout);
	event ValidatorUpdated(address indexed affiliate, address indexed validator, bool enabled);
}
