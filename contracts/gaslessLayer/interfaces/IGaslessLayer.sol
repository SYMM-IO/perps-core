// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

interface IGaslessLayer {
	// ─────────────────────────── Types ────────────────────────────

	/// @notice User-signed native gas top-up intent.
	struct NativeGasTopUpRequest {
		address payerAccount;
		address recipientWallet;
		uint256 collateralAmount;
		uint256 minNativeAmountOut;
		uint256 nonce;
		uint256 deadline;
	}

	/// @notice Per-payer sponsored native amount within a UTC day (packed into one slot).
	struct DailyNativeSponsorUsage {
		uint64 day; // day index = block.timestamp / 1 days
		uint192 amount; // native amount sponsored on that day
	}

	// ────────────────────────── Events ────────────────────────────

	// Payers are read from the per-op OperationalFeeRouted events in the same receipt.
	event InstantBatchRelayed(address indexed relayer, uint256 operationCount, uint256 totalFee);
	event InstantTemplateRelayed(address indexed relayer, uint256 indexed templateId, uint256 operationCount, uint256 totalFee);
	event DelegationBySigRelayed(
		address indexed relayer,
		address indexed delegatorAccount,
		address indexed payer,
		address delegate,
		uint256 selectorCount,
		uint256 fee
	);
	event OperationalFeeRouted(address indexed signerAccount, address indexed payer, uint256 amount);
	event DepositFeeCollected(address indexed wallet, address indexed treasury, uint256 amount);
	event DepositSettledToNewAccount(address indexed wallet, address indexed subAccount, uint256 netDeposit, uint256 depositFee);
	event DepositSettledToExistingAccount(address indexed wallet, address indexed subAccount, uint256 netDeposit, uint256 depositFee);
	event GaslessWalletDeployed(address indexed ownerWallet, address wallet);
	event WalletOperationRelayed(address indexed relayer, address indexed ownerWallet, address indexed wallet, uint256 callCount);
	event NonCollateralTokenRecovered(address indexed wallet, address indexed token, address indexed recipient, uint256 amount);
	event DepositFeeConfigUpdated(uint256 depositFee, uint256 minimumDeposit);
	event DefaultSelectorFeeUpdated(uint256 amount);
	event SelectorFeeConfigUpdated(bytes4 indexed selector, bool configured, uint256 amount);
	event DailyFreeOpsUsed(address indexed account, uint256 opsCount, uint256 usedToday, uint256 limit);
	event DailyFreeOpsLimitUpdated(uint256 limit);
	event FreeQuotaExhaustionPolicyUpdated(bool revertWhenFreeQuotaExhausted);
	event MaxNativeGasTopUpAmountUpdated(uint256 maxNativeAmount);
	event NativeGasTopUpRelayed(
		address indexed relayer,
		address indexed payerAccount,
		address indexed payer,
		address recipientWallet,
		uint256 nativeAmount,
		uint256 collateralAmount,
		uint256 totalCollateralCharge
	);
	event DailyNativeGasSponsored(address indexed payer, uint256 nativeAmount, uint256 usedToday, uint256 limit);
	event NativeGasTopUpConfigUpdated(uint256 dailySponsoredNativeLimit, bool revertWhenNativeSponsorLimitExhausted);
	event NativeGasTopUpFeeBpsUpdated(uint256 feeBps);
	event TreasuryUpdated(address treasury);

	// ────────────────────────── Errors ────────────────────────────

	error ZeroAddress();
	error EmptyOperationBatch();
	error ArrayLengthMismatch();
	error DepositAmountBelowMinimum(uint256 amount, uint256 minimum);
	error MinimumDepositNotAboveFee(uint256 minimumDeposit, uint256 depositFee);
	error AccountOwnerMismatch(address account, address expectedOwner, address actualOwner);
	error CollateralRecoveryDisabled();
	error GaslessWalletAddressMismatch();
	error WalletCallDataTooShort();
	error DailyFreeOpsLimitExceeded(address account, uint256 limit);
	error InvalidNativeGasTopUpSignature();
	error NativeGasTopUpExpired(uint256 deadline);
	error NativeGasTopUpNonceMismatch(address payerAccount, uint256 expected, uint256 actual);
	error NativeGasTopUpAmountBelowMin(uint256 actual, uint256 minAmountOut);
	error NativeGasTopUpCollateralAmountZero();
	error NativeGasTopUpAmountZero();
	error NativeGasTopUpAmountExceedsMax(uint256 amount, uint256 maxAmount);
	error NativeGasTopUpFeeBpsTooHigh(uint256 feeBps);
	error DailySponsoredNativeLimitExceeded(address payer, uint256 limit);
	error NativeGasTransferFailed(address recipient, uint256 amount);
	error WalletOperationExpired(uint256 deadline);
	error InvalidWalletOperationSignature();
	error WalletOperationInvalidNonce(address account, uint256 expected, uint256 actual);
	error InvalidWalletOperationTarget(address expected, address actual);
	error WalletOperationForPartyBUnsupported();
	error InvalidWalletOperationSigner(address expectedOwner, address actualSigner);
	error WalletDelegationMissing(address delegator, address delegate, bytes4 selector);
	error InvalidWalletExecuteSelector(bytes4 selector);
}
