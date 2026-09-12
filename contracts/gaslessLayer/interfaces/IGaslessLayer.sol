// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title IGaslessLayer
/// @notice Shared request types, events, and errors for GaslessLayer.
interface IGaslessLayer {
	// ─────────────────────────── Types ────────────────────────────

	enum FeeSource {
		SYMMIO_ACCOUNT,
		WALLET_COLLATERAL
	}

	/// @notice One operation's charge. All amounts use 18 decimals, including wallet collateral fees.
	struct FeePayment {
		address account;
		address payer;
		uint8 source; // FeeSource, encoded as uint8 for standard library ABI tooling.
		uint256 operationalFee;
		uint256 depositFee;
		uint256 walletCreationFee;
		uint256 nativeTopUpFee;
		uint256 nativeGasCollateral;
	}

	/// @notice GaslessLayer charges only. Core operation fees, bridge fees, and transaction gas are excluded.
	/// @dev totalDebit is totalFee plus collateral exchanged for native gas. It excludes the net deposit itself.
	struct FeeQuote {
		address collateralToken;
		uint8 collateralDecimals;
		uint256 blockNumber;
		uint256 timestamp;
		bool exact;
		FeePayment[] payments;
		uint256 totalFee;
		uint256 totalDebit;
		uint256 freeOpsApplied;
		bool nativeSponsored;
	}

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
	/// @notice Creation fee in collateral token decimals, paid from the wallet or charged to a SYMMIO billing account.
	event WalletCreationFeeCollected(address indexed wallet, address indexed payer, uint256 amount);
	event WalletCreationFeeUpdated(uint256 amount);
	/// @notice Emitted when a GaslessWallet is deployed, including at index zero.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @param wallet Deployed GaslessWallet address.
	event GaslessWalletDeployed(address indexed owner, uint256 indexed walletId, address wallet);
	/// @notice Emitted when a wallet deposit settles into a new or existing sub-account, including at index zero.
	/// @param owner Owner of the source wallet and destination sub-account.
	/// @param walletId Index of the source GaslessWallet.
	/// @param subAccount Sub-account credited with the net deposit.
	/// @param netDeposit Collateral credited after deposit and any wallet creation fees.
	/// @param depositFee Collateral paid to the treasury as the flat deposit fee.
	event WalletDepositSettled(address indexed owner, uint256 indexed walletId, address indexed subAccount, uint256 netDeposit, uint256 depositFee);
	event WalletOperationRelayed(address indexed relayer, address indexed owner, address indexed wallet, uint256 callCount);
	/// @notice Emitted when non-collateral tokens are recovered from a GaslessWallet, including at index zero.
	/// @param wallet Source GaslessWallet contract address.
	/// @param token Token recovered.
	/// @param recipient Address receiving the recovered tokens.
	/// @param amount Token amount recovered.
	event WalletNonCollateralTokenRecovered(address indexed wallet, address indexed token, address indexed recipient, uint256 amount);
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
	event InstantLayerUpdated(address instantLayer);

	// ────────────────────────── Errors ────────────────────────────

	error ZeroAddress();
	error EmptyOperationBatch();
	error ArrayLengthMismatch();
	error DepositAmountBelowMinimum(uint256 amount, uint256 minimum);
	error MinimumDepositNotAboveFee(uint256 minimumDeposit, uint256 depositFee);
	error DepositAmountNotAboveFees(uint256 amount, uint256 totalFees);
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
	error UnsupportedFeeQuoteCall(bytes4 selector);
	error UnexpectedNativeValue(uint256 value);
	error FeeQuoteContextActive();
	/// @notice Successful simulation, returned by reverting so no state changes can persist.
	error FeeQuoteResult(FeeQuote quote);
	/// @notice The complete request failed. reason is the original revert data.
	error FeeQuoteExecutionFailed(bytes reason);
	error FeeLimitExceeded(uint256 actual, uint256 maximum);
}
