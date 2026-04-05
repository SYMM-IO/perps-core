// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title LibErrors
/// @notice Shared custom errors used across ExpressProvider facets.
library LibErrors {
	error OnlySymmio();
	error FeeRateExceeds100Percent();
	error NoFeesToClaim();
	error NoOperatorFeesToClaim();
	error InsufficientSponsorBalance();
	error InsufficientUnlockedGeneralBalance();
	error InsufficientUnlockedAffiliateBalance();
	error FeesExceedExpressAmount();
	error UserFeeExceedsMaximum();
	error OfferExpired();
	error InvalidNonce();
	error InvalidSigner();
	error InsufficientGeneralBalance();
	error InsufficientAffiliateBalance();
	error InvalidStatusForStandard();
	error NotProcessed();
	error NotAccepted();
	error NotFinalized();
	error PartsMismatch();
	error TooEarly();
	error NotLocked();
	error ValidatorApprovalExpired();
	error InsufficientValidatorSignatures();
	error InvalidValidator();
	error DuplicateValidator();
	error InvalidStatusForSuspend();
	error ArrayLengthMismatch();
	error InvalidOptionType();
	error ValidatorsRequiredForImmediate();
	error FeeMismatch();
	error OperatorFeeMismatch();
	error FundingSplitExceedsExpress();
	error AlreadyInitialized();
	error SecurityWindowTooLow();
	error TolerancePeriodTooLow();
	error CreditNotSupportedForStandard();
	error InvalidPostPayoutRollback();
	error VirtualProviderMustBeZero();
	error Reentrancy();
}
