// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { GaslessWallet } from "./GaslessWallet.sol";
import { IGaslessLayer } from "./interfaces/IGaslessLayer.sol";
import { IGaslessLayerActions } from "./interfaces/IGaslessLayerActions.sol";
import { IInstantLayer } from "./interfaces/IInstantLayer.sol";
import { ISymmioCore } from "./interfaces/ISymmioCore.sol";
import { ISymmioAccountLayer, SubAccountCreationData } from "./interfaces/ISymmioAccountLayer.sol";
import { GaslessBillingIdentity } from "./libraries/GaslessBillingIdentity.sol";
import { GaslessNativeGasTopUpLib } from "./libraries/GaslessNativeGasTopUpLib.sol";
import { GaslessOperationalFeeLib } from "./libraries/GaslessOperationalFeeLib.sol";
import { GaslessWalletDeployerLib } from "./libraries/GaslessWalletDeployerLib.sol";
import { GaslessWalletExecutionLib } from "./libraries/GaslessWalletExecutionLib.sol";
import { GaslessFeeQuoteLib } from "./libraries/GaslessFeeQuoteLib.sol";
import { GaslessFeeAccounting } from "./libraries/GaslessFeeAccounting.sol";
import { GaslessFeeLimits } from "./libraries/GaslessFeeLimits.sol";

/// @title GaslessLayer
/// @notice Relay signed operations, settle bridged deposits, and fund native gas top-ups.
/// @dev The UUPS proxy is the CREATE2 deployer of every GaslessWallet. Index zero preserves the
///      original wallet address and nonce storage; positive indices identify additional wallets.
///      Wallet operations execute through the gateway, while ordinary operations use InstantLayer.
///      Operational fees are charged to SYMMIO billing accounts after batch execution. Deposits
///      sweep the selected wallet's full collateral balance and deduct the configured flat fee.
///      Linked libraries execute in proxy context and keep implementation size within EIP-170.
contract GaslessLayer is IGaslessLayer, IGaslessLayerActions, Initializable, AccessControlUpgradeable, ReentrancyGuard, UUPSUpgradeable {
	using SafeERC20 for IERC20;

	// ───────────────────────── Constants ──────────────────────────

	bytes32 public constant CONFIG_ADMIN_ROLE = keccak256("CONFIG_ADMIN_ROLE");
	bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
	uint256 internal constant FEE_MULTIPLIER_BASE = 10000;
	// Integrators read these signing constants from the proxy to build wallet typed data and delegation grants.
	// The execution library validates the resulting operations.
	bytes32 public constant WALLET_ACCOUNT_TYPEHASH = keccak256("Account(address addr,bool isPartyB)");
	bytes32 public constant WALLET_REPLAY_HEADER_TYPEHASH = keccak256("ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)");
	bytes4 public constant WALLET_EXECUTION_SENTINEL_SELECTOR = bytes4(keccak256("GASLESSQ_WALLET_EXECUTION"));

	// ─────────────────────────── Types ────────────────────────────

	/// @param configured When true, `amount` is used as-is (even 0); when false, the default applies.
	struct SelectorFeeConfig {
		bool configured;
		uint256 amount;
	}

	/// @notice Per-account free-operation usage within a UTC day (packed into one slot).
	struct DailyFreeOpsUsage {
		uint64 day; // day index = block.timestamp / 1 days
		uint192 count; // free operations used on that day
	}

	// ───────────────────────── References ─────────────────────────

	ISymmioCore public core;
	ISymmioAccountLayer public accountLayer;
	IInstantLayer public instantLayer;
	address public collateralToken;
	address public treasury;

	// ─────────────────────────── Fees ─────────────────────────────

	uint256 public depositFee;
	uint256 public minimumDeposit;
	uint256 public defaultSelectorFee;
	mapping(bytes4 => SelectorFeeConfig) public selectorFeeConfigs;

	// Per-account daily free quota. Each op is priced at its selector fee; the first
	// `dailyFreeOpsLimit` ops per account per UTC day waive that fee. See relayInstantBatch.
	uint256 public dailyFreeOpsLimit; // 0 = no free quota
	bool public revertWhenFreeQuotaExhausted; // true = revert past the quota instead of charging the base fee
	mapping(address => DailyFreeOpsUsage) public dailyFreeOpsUsage;

	// Relayer-funded native gas top-ups. Each payer gets a daily sponsored native allowance; once
	// exhausted, policy either reverts or charges the signed collateral amount plus the configured
	// on-chain top-up fee through core.
	mapping(address => uint256) public topUpNonces;
	mapping(address => IGaslessLayer.DailyNativeSponsorUsage) public dailyNativeSponsorUsage;
	uint256 public dailySponsoredNativeLimit;
	bool public revertWhenNativeSponsorLimitExhausted;
	uint256 public maxNativeGasTopUpAmount;
	uint256 public nativeGasTopUpFeeBps;
	// Retain slot 18 and its values for index-zero wallets on existing proxies.
	mapping(address => uint256) private _legacyWalletOperationNonces;

	/// @notice Last consumed nonce by GaslessWallet address and signer account for positive wallet indices.
	/// @dev Index zero uses _legacyWalletOperationNonces to preserve its existing nonce stream.
	mapping(address => mapping(address => uint256)) public walletNonces;

	/// @notice Flat collateral fee charged once per wallet deployment. Zero disables collection.
	/// @dev Uses the first reserved slot so existing proxy storage and wallet addresses remain unchanged.
	uint256 public walletCreationFee;

	uint256[31] private __gap;

	// ─────────────────────── Initialization ───────────────────────

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	function initialize(
		address admin,
		address core_,
		address accountLayer_,
		address instantLayer_,
		address treasury_,
		uint256 depositFee_,
		uint256 minimumDeposit_
	) external initializer {
		if (admin == address(0) || core_ == address(0) || accountLayer_ == address(0) || instantLayer_ == address(0) || treasury_ == address(0))
			revert ZeroAddress();
		if (minimumDeposit_ <= depositFee_) revert MinimumDepositNotAboveFee(minimumDeposit_, depositFee_);

		__AccessControl_init();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(CONFIG_ADMIN_ROLE, admin);
		_grantRole(RELAYER_ROLE, admin);

		core = ISymmioCore(core_);
		accountLayer = ISymmioAccountLayer(accountLayer_);
		instantLayer = IInstantLayer(instantLayer_);
		treasury = treasury_;
		depositFee = depositFee_;
		minimumDeposit = minimumDeposit_;
		collateralToken = ISymmioCore(core_).getCollateral();
	}

	// ═════════════════ Instant-Layer Relays ═════════════════

	/// @notice Relay InstantLayer and indexed GaslessWallet operations and collect their fees.
	/// @dev Relayer-only. Positive indices require an owner-derived wallet target; zero retains target-based dispatch.
	///      Executes all operations before collecting fees, allowing approvals in the same batch. Index zero keeps its existing nonce stream.
	/// @param signedOps Signed operations in execution order.
	/// @param signatures Signature for each operation, in the same order.
	/// @param fills InstantLayer flexible-field values by operation; wallet operations ignore their entries.
	/// @param flexFillerSignatures InstantLayer flexible-field signatures by operation; wallet operations ignore their entries.
	/// @param walletIds Wallet index per operation; use zero for InstantLayer operations or the original wallet.
	/// @return results Encoded result of each operation, in execution order.
	function relayInstantBatch(
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures,
		uint256[] memory walletIds
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (bytes[] memory results) {
		if (walletIds.length != signedOps.length) revert ArrayLengthMismatch();
		if (signedOps.length == 0) revert EmptyOperationBatch();
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();

		// InstantLayer validates fill array lengths for batches without wallet operations.
		// Mixed batches execute one operation at a time. Wallet operations ignore fills;
		// InstantLayer operations read their entry through _opValuesOrEmpty, which returns empty for missing entries.

		bytes4[][] memory feeSelectors;
		uint256[] memory creationFees = new uint256[](signedOps.length);
		if (!_hasWalletOperation(signedOps, walletIds)) {
			results = instantLayer.executeBatch(signedOps, signatures, fills, flexFillerSignatures);
			feeSelectors = _instantBatchFeeSelectors(signedOps);
		} else {
			results = new bytes[](signedOps.length);
			feeSelectors = new bytes4[][](signedOps.length);
			for (uint256 i = 0; i < signedOps.length; i++) {
				uint256 walletId = walletIds[i];
				if (_isWalletOperation(signedOps[i], walletId)) {
					(results[i], feeSelectors[i], creationFees[i]) = _executeWalletOperation(signedOps[i], signatures[i], walletId);
				} else {
					results[i] = _executeSingleInstantOperation(
						signedOps[i],
						signatures[i],
						_opValuesOrEmpty(fills, i),
						_opValuesOrEmpty(flexFillerSignatures, i)
					);
					feeSelectors[i] = _instantOperationFeeSelectors(signedOps[i]);
				}
			}
		}

		uint256 totalFee = _collectOperationalFees(signedOps, feeSelectors, creationFees);

		emit InstantBatchRelayed(msg.sender, signedOps.length, totalFee);
	}

	/// @notice Relay an InstantLayer template and collect each account's operational fees.
	/// @dev Relayer-only. InstantLayer validates the template and chains operation results. All operations execute
	///      before fee collection; a fee failure reverts the complete template. Each operation uses its outer selector.
	/// @param templateId Registered InstantLayer template identifier.
	/// @param signedOps Signed operations in execution order.
	/// @param signatures Signature for each operation, in the same order.
	/// @param fills InstantLayer flexible-field values by operation.
	/// @param flexFillerSignatures InstantLayer flexible-field signatures by operation.
	/// @return results Encoded result of each operation, in execution order.
	function relayInstantTemplate(
		uint256 templateId,
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (bytes[] memory results) {
		if (signedOps.length == 0) revert EmptyOperationBatch();

		// Templates execute entirely through InstantLayer. instantLayer.executeTemplate checks the
		// signature/fill/flex array lengths and each operation against the registered template.
		results = instantLayer.executeTemplate(templateId, signedOps, signatures, fills, flexFillerSignatures);

		uint256 totalFee = _collectOperationalFees(signedOps, _instantBatchFeeSelectors(signedOps), new uint256[](signedOps.length));

		emit InstantTemplateRelayed(msg.sender, templateId, signedOps.length, totalFee);
	}

	/// @notice Relay a user-signed InstantLayer delegation and charge one fee or consume one free operation.
	/// @dev Calls InstantLayer's standalone grantBatchDelegationBySig. Owner-signed grants can also use relayInstantBatch.
	///      The delegation account pays, with virtual accounts billed through their parent as for other InstantLayer operations.
	///      Each relay uses one free operation when available, regardless of the number of selectors granted.
	function relayGrantBatchDelegationBySig(
		IInstantLayer.SignedDelegation calldata signedDelegation,
		bytes calldata signature
	) external onlyRole(RELAYER_ROLE) nonReentrant {
		IInstantLayer.DelegationInfo calldata info = signedDelegation.delegationInfo;
		address delegatorAccount = info.account.addr;
		(address payer, uint256 fee) = _collectOneOperationalFee(delegatorAccount, IInstantLayer.grantBatchDelegationBySig.selector);
		GaslessFeeLimits.check(signedDelegation.replayAttackHeader.salt, fee);

		instantLayer.grantBatchDelegationBySig(signedDelegation, signature);

		emit DelegationBySigRelayed(msg.sender, delegatorAccount, payer, info.delegatedSigner, info.selectors.length, fee);
	}

	/// @notice Relay a user-signed native gas top-up funded by the relayer's `msg.value`.
	/// @dev The payer is sponsored while its daily native allowance covers the request. Once exhausted,
	///      the configured policy either reverts or charges the signed collateral amount plus the top-up fee through core.
	///      GaslessNativeGasTopUpLib checks the signature, consumes the nonce, records sponsorship, and transfers native gas.
	///      The linked library keeps the implementation below EIP-170.
	function relayNativeGasTopUp(
		IGaslessLayer.NativeGasTopUpRequest calldata request,
		bytes calldata signature
	) external payable onlyRole(RELAYER_ROLE) nonReentrant {
		GaslessNativeGasTopUpLib.NativeGasTopUpResult memory topUp = GaslessNativeGasTopUpLib.relayNativeGasTopUp(
			topUpNonces,
			dailyNativeSponsorUsage,
			address(accountLayer),
			address(core),
			dailySponsoredNativeLimit,
			revertWhenNativeSponsorLimitExhausted,
			maxNativeGasTopUpAmount,
			nativeGasTopUpFeeBps,
			request,
			signature
		);
		if (topUp.sponsored) emit DailyNativeGasSponsored(topUp.payer, msg.value, topUp.sponsoredUsedToday, topUp.sponsoredLimit);
		emit NativeGasTopUpRelayed(
			msg.sender,
			request.payerAccount,
			topUp.payer,
			request.recipientWallet,
			msg.value,
			request.collateralAmount,
			topUp.totalCollateralCharge
		);
	}

	// ═══════════════ Cross-Chain Deposit Settlement ═══════════════

	/// @notice Settle collateral from the selected wallet into a new owner-held sub-account.
	/// @dev Relayer-only. Sweeps the full collateral balance and deducts the flat fee. The relayer supplies account settings without a user signature.
	///      Emits WalletDepositSettled for every index, including zero.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletIndex Wallet index; zero selects the original wallet.
	/// @param affiliate Affiliate selected by the relayer for the new account.
	/// @param accountData Account settings; symmioCore is replaced with the gateway's configured core.
	/// @return subAccount Address of the created and funded sub-account.
	function settleDepositToNewAccount(
		address owner,
		uint256 walletIndex,
		address affiliate,
		SubAccountCreationData calldata accountData
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (address subAccount) {
		if (owner == address(0)) revert ZeroAddress();

		(uint256 netDeposit, uint256 collectedDepositFee) = _sweepDepositAndCollectFee(owner, walletIndex);

		SubAccountCreationData[] memory accountsData = new SubAccountCreationData[](1);
		accountsData[0] = accountData;
		accountsData[0].symmioCore = address(core); // Create the account on the same core that receives the deposit.
		address[] memory created = accountLayer.createSubAccountsFor(owner, affiliate, accountsData);
		subAccount = created[0];

		// Check the returned account's owner before crediting it.
		address actualOwner = accountLayer.ownerOf(subAccount);
		if (actualOwner != owner) revert AccountOwnerMismatch(subAccount, owner, actualOwner);

		_depositCollateralToCore(subAccount, netDeposit);
		emit WalletDepositSettled(owner, walletIndex, subAccount, netDeposit, collectedDepositFee);
	}

	/// @notice Settle collateral from the selected wallet into an existing owner-held sub-account.
	/// @dev Relayer-only. The destination must belong to owner. Sweeps the full collateral balance and deducts the flat fee.
	///      Emits WalletDepositSettled for every index, including zero.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletIndex Wallet index; zero selects the original wallet.
	/// @param subAccount Existing sub-account that receives the net deposit.
	function settleDepositToExistingAccount(address owner, uint256 walletIndex, address subAccount) external onlyRole(RELAYER_ROLE) nonReentrant {
		if (owner == address(0) || subAccount == address(0)) revert ZeroAddress();

		address actualOwner = accountLayer.ownerOf(subAccount);
		if (actualOwner != owner) revert AccountOwnerMismatch(subAccount, owner, actualOwner);

		(uint256 netDeposit, uint256 collectedDepositFee) = _sweepDepositAndCollectFee(owner, walletIndex);
		_depositCollateralToCore(subAccount, netDeposit);
		emit WalletDepositSettled(owner, walletIndex, subAccount, netDeposit, collectedDepositFee);
	}

	/// @notice Withdraw funds from the caller's selected wallet without a relayer or SYMMIO account.
	/// @dev The owner pays transaction gas. First deployment charges walletCreationFee from wallet collateral;
	///      no deposit fee, operational fee or allowance applies. Use executeWithFeeLimit to cap the creation fee.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @param token ERC20 to withdraw, or address(0) for native funds.
	/// @param recipient Nonzero address chosen by the owner to receive the funds.
	/// @param amount Token base units or wei. type(uint256).max withdraws the full balance after any creation fee.
	/// @return withdrawnAmount Amount sent to recipient.
	function withdrawWalletFunds(
		uint256 walletId,
		address token,
		address recipient,
		uint256 amount
	) external nonReentrant returns (uint256 withdrawnAmount) {
		if (recipient == address(0)) revert ZeroAddress();
		if (amount == 0) revert WalletWithdrawalAmountZero();
		GaslessWallet wallet = _getWalletAndCollectCreationFee(msg.sender, walletId);
		withdrawnAmount = amount;
		if (amount == type(uint256).max) withdrawnAmount = token == address(0) ? address(wallet).balance : IERC20(token).balanceOf(address(wallet));
		if (withdrawnAmount == 0) revert WalletWithdrawalAmountZero();
		wallet.transfer(token, recipient, withdrawnAmount);
		emit WalletFundsWithdrawn(msg.sender, walletId, token, recipient, withdrawnAmount);
	}

	// ═══════════════════════ Wallet Views ════════════════════════

	/// @notice Preview GaslessLayer charges for encoded action calldata without signatures or state changes.
	/// @dev Uses current balances, allowances and configuration. Does not execute the action or validate its signatures.
	///      State changes inside a batch can change the fees and payer. Use simulateFeeQuote on the completed request.
	function previewFeeQuote(bytes calldata callData, uint256 nativeAmount) external view returns (FeeQuote memory) {
		return GaslessFeeQuoteLib.preview(callData, nativeAmount);
	}

	/// @notice Simulate the complete call, including signatures, roles and fee collection, through eth_call.
	/// @dev ALWAYS reverts: FeeQuoteResult contains the exact quote; FeeQuoteExecutionFailed contains the original failure.
	///      Use the submitting relayer/admin/owner as `from` and the intended native `value`. No changes can persist, even if sent as a transaction.
	function simulateFeeQuote(bytes calldata callData) external payable {
		if (_reentrancyGuardEntered()) revert FeeQuoteContextActive();
		GaslessFeeQuoteLib.execute(callData, true, 0);
	}

	/// @notice Execute an action with a caller-supplied cap on total GaslessLayer collateral debit, in 18 decimals.
	/// @dev Retains the underlying action's roles. This caller limit is useful for unsigned settlement/admin actions.
	///      User-signed operation limits are enforced separately, even when relayed directly.
	function executeWithFeeLimit(bytes calldata callData, uint256 maxTotalDebit) external payable returns (bytes memory) {
		if (_reentrancyGuardEntered()) revert FeeQuoteContextActive();
		return GaslessFeeQuoteLib.execute(callData, false, maxTotalDebit);
	}

	/// @notice Predict the owner's selected GaslessWallet address without deploying it.
	/// @dev Index zero preserves the original wallet address. Collateral can arrive before deployment.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @return Predicted GaslessWallet address.
	function getGaslessWalletAddress(address owner, uint256 walletId) external view returns (address) {
		return GaslessWalletDeployerLib.getGaslessWalletAddress(owner, walletId);
	}

	/// @notice Quote the flat collateral fee for deploying the selected wallet now.
	/// @dev Already deployed wallets return zero. This fee is separate from SYMMIO operational fees and their free quota.
	function getWalletCreationFee(address owner, uint256 walletId) external view returns (uint256) {
		address wallet = GaslessWalletDeployerLib.getGaslessWalletAddress(owner, walletId);
		return wallet.code.length == 0 ? walletCreationFee : 0;
	}

	/// @notice Read the last consumed wallet-operation nonce for the selected wallet and signer account.
	/// @dev Index zero reads the original signer-account nonce mapping; positive indices use wallet-specific mappings.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @param signerAccount Account specified in the signed operation.
	/// @return Last consumed nonce; the next operation must use this value plus one.
	function walletOperationNonces(address owner, uint256 walletId, address signerAccount) external view returns (uint256) {
		if (walletId == 0) return _legacyWalletOperationNonces[signerAccount];
		address wallet = GaslessWalletDeployerLib.getGaslessWalletAddress(owner, walletId);
		return walletNonces[wallet][signerAccount];
	}

	/// @notice Compute the EIP-712 digest of a GaslessWallet operation.
	/// @dev Uses the existing GaslessGateway domain and signed target; the wallet index is not a separate signed field.
	/// @param signedOp Wallet operation to hash.
	/// @return EIP-712 operation digest.
	function getWalletOperationHash(IInstantLayer.SignedOperation calldata signedOp) public view returns (bytes32) {
		return GaslessWalletExecutionLib.getWalletOperationHash(signedOp);
	}

	/// @notice Check whether a wallet-operation signature is valid for its declared signer.
	/// @dev Checks the EIP-712 signature only; does not validate the target, nonce, deadline, or signer authority.
	/// @param signedOp Wallet operation whose digest is checked.
	/// @param signature Signature to verify.
	/// @return Whether the signature is valid for signedOp.signer.
	function isValidWalletOperationSignature(IInstantLayer.SignedOperation calldata signedOp, bytes calldata signature) external view returns (bool) {
		return GaslessWalletExecutionLib.isValidWalletOperationSignature(signedOp, signature);
	}

	// ═══════════════════════ Fee/Admin Config ═══════════════════════

	/// @notice Set the fee charged once when a wallet is deployed. Amount uses collateral token decimals.
	/// @dev Deposits pay from incoming collateral; wallet execution pays through the SYMMIO billing account.
	function setWalletCreationFee(uint256 amount) external onlyRole(CONFIG_ADMIN_ROLE) {
		walletCreationFee = amount;
		emit WalletCreationFeeUpdated(amount);
	}

	function setDepositFeeConfig(uint256 depositFee_, uint256 minimumDeposit_) external onlyRole(CONFIG_ADMIN_ROLE) {
		if (minimumDeposit_ <= depositFee_) revert MinimumDepositNotAboveFee(minimumDeposit_, depositFee_);
		depositFee = depositFee_;
		minimumDeposit = minimumDeposit_;
		emit DepositFeeConfigUpdated(depositFee_, minimumDeposit_);
	}

	function setDefaultSelectorFee(uint256 amount) external onlyRole(CONFIG_ADMIN_ROLE) {
		defaultSelectorFee = amount;
		emit DefaultSelectorFeeUpdated(amount);
	}

	/// @notice Set the per-account daily quota. The first N operations per UTC day have no base fee.
	///         0 disables the free quota, so every operation pays its base fee.
	function setDailyFreeOpsLimit(uint256 limit) external onlyRole(CONFIG_ADMIN_ROLE) {
		dailyFreeOpsLimit = limit;
		emit DailyFreeOpsLimitUpdated(limit);
	}

	/// @notice Choose what happens once an account's free quota is exhausted.
	/// @dev true reverts with `DailyFreeOpsLimitExceeded`, preserving the pre-0.8.6 "free then
	///      block" mode. false charges the operation's base fee through core.chargeOperationalFee.
	function setRevertWhenFreeQuotaExhausted(bool value) external onlyRole(CONFIG_ADMIN_ROLE) {
		revertWhenFreeQuotaExhausted = value;
		emit FreeQuotaExhaustionPolicyUpdated(value);
	}

	/// @notice Configure native gas top-up sponsorship and exhaustion policy.
	/// @dev Once `dailySponsoredNativeLimit` is exhausted, true reverts and false charges a bounded
	///      collateral fee through core. A zero limit means every top-up is past the sponsored allowance.
	function setNativeGasTopUpConfig(
		uint256 dailySponsoredNativeLimit_,
		bool revertWhenNativeSponsorLimitExhausted_
	) external onlyRole(CONFIG_ADMIN_ROLE) {
		dailySponsoredNativeLimit = dailySponsoredNativeLimit_;
		revertWhenNativeSponsorLimitExhausted = revertWhenNativeSponsorLimitExhausted_;
		emit NativeGasTopUpConfigUpdated(dailySponsoredNativeLimit_, revertWhenNativeSponsorLimitExhausted_);
	}

	/// @notice Set the maximum native amount any single top-up request may forward.
	function setMaxNativeGasTopUpAmount(uint256 maxNativeAmount) external onlyRole(CONFIG_ADMIN_ROLE) {
		maxNativeGasTopUpAmount = maxNativeAmount;
		emit MaxNativeGasTopUpAmountUpdated(maxNativeAmount);
	}

	/// @notice Set the fee charged on top of the signed collateral amount for paid native gas top-ups.
	function setNativeGasTopUpFeeBps(uint256 feeBps) external onlyRole(CONFIG_ADMIN_ROLE) {
		if (feeBps > FEE_MULTIPLIER_BASE) revert NativeGasTopUpFeeBpsTooHigh(feeBps);
		nativeGasTopUpFeeBps = feeBps;
		emit NativeGasTopUpFeeBpsUpdated(feeBps);
	}

	/// @notice Total Symmio collateral charged for a paid top-up with `collateralAmount`.
	function getNativeGasTopUpCharge(uint256 collateralAmount) external view returns (uint256 feeAmount, uint256 totalCollateralCharge) {
		return GaslessNativeGasTopUpLib.getNativeGasTopUpCharge(collateralAmount, nativeGasTopUpFeeBps);
	}

	/// @notice Free instant-operations remaining for `account` today (max uint when the quota is disabled).
	function dailyFreeOpsRemaining(address account) external view returns (uint256) {
		uint256 limit = dailyFreeOpsLimit;
		if (limit == 0) return type(uint256).max;
		address billingAccount = _resolveBillingAccount(account);
		uint256 usedToday = _usedFreeOpsToday(dailyFreeOpsUsage[billingAccount], _todayIndex());
		return _remainingFreeOps(usedToday, limit);
	}

	/// @notice Set the operational fee for an operation `selector` (the function selector of the call
	///         submitted through the instant layer). With `configured:false` the default applies.
	function setSelectorFeeConfig(bytes4 selector, bool configured, uint256 amount) external onlyRole(CONFIG_ADMIN_ROLE) {
		selectorFeeConfigs[selector] = SelectorFeeConfig({ configured: configured, amount: amount });
		emit SelectorFeeConfigUpdated(selector, configured, amount);
	}

	/// @notice Base fee for a single operation with the given function `selector`, before core multipliers or quota.
	function getBaseOperationalFee(bytes4 selector) external view returns (uint256) {
		return _baseSelectorFee(selector);
	}

	/// @notice Quote account fees for InstantLayer and indexed GaslessWallet operations.
	/// @dev Targets are checked and calls decoded before applying quotas, even for operations covered by the free quota.
	///      Includes one flat creation fee per undeployed wallet, even when its operation uses the free quota.
	///      Billing uses the parent's quota and quotes the signer VA's fee when the parent cannot pay.
	///      An approval-only quote uses the parent's post-approval multiplier; a later VA fallback can change the actual charge.
	/// @param account Account whose operations are quoted; virtual accounts resolve to their billing parent.
	/// @param signedOps Operations to identify and price; only the requested billing account's operations contribute to the quote.
	/// @param walletIds Wallet index per operation; use zero for InstantLayer operations or the original wallet.
	/// @return amountDue Total quoted collateral charge; zero when fully waived or blocked by the quota policy.
	/// @return freeOpsApplied Number of the billing account's operations covered by its remaining daily quota.
	/// @return wouldBlockOnQuota Whether execution would exceed the daily quota in block mode.
	function getAccountOperationalFee(
		address account,
		IInstantLayer.SignedOperation[] calldata signedOps,
		uint256[] calldata walletIds
	) external view returns (uint256 amountDue, uint256 freeOpsApplied, bool wouldBlockOnQuota) {
		return GaslessFeeQuoteLib.accountOperationalFee(account, signedOps, walletIds);
	}

	// ═══════════════════════ Admin Recovery ═══════════════════════

	function setTreasury(address treasury_) external onlyRole(CONFIG_ADMIN_ROLE) {
		if (treasury_ == address(0)) revert ZeroAddress();
		treasury = treasury_;
		emit TreasuryUpdated(treasury_);
	}

	/// @notice Set the gateway's InstantLayer address.
	/// @dev InstantLayer is not upgradeable. Call this after deploying its replacement,
	///      typically through the init data of upgradeToAndCall. The new layer must
	///      grant this gateway OPERATOR_ROLE before relays resume.
	function setInstantLayer(address instantLayer_) external onlyRole(CONFIG_ADMIN_ROLE) {
		if (instantLayer_ == address(0)) revert ZeroAddress();
		instantLayer = IInstantLayer(instantLayer_);
		emit InstantLayerUpdated(instantLayer_);
	}

	/// @notice Recover non-collateral tokens from the selected GaslessWallet.
	/// @dev Config-admin-only. Rejects the collateral token and a zero recipient. Deploys the wallet if needed
	///      and pays its creation fee from wallet collateral to treasury before recovering the other token.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @param token Non-collateral token to recover.
	/// @param recipient Address receiving the wallet's full balance of token.
	/// @return amount Token amount recovered.
	function recoverNonCollateralToken(
		address owner,
		uint256 walletId,
		address token,
		address recipient
	) external onlyRole(CONFIG_ADMIN_ROLE) nonReentrant returns (uint256 amount) {
		if (token == collateralToken) revert CollateralRecoveryDisabled();
		if (recipient == address(0)) revert ZeroAddress();
		GaslessWallet qWallet = _getWalletAndCollectCreationFee(owner, walletId);
		amount = qWallet.sweepTokenBalance(token, recipient);
		emit WalletNonCollateralTokenRecovered(address(qWallet), token, recipient, amount);
	}

	/// @dev Owner withdrawals and admin recovery pay first-deployment fees from the wallet's collateral.
	function _getWalletAndCollectCreationFee(address owner, uint256 walletId) internal returns (GaslessWallet) {
		(GaslessWallet qWallet, bool deployed) = GaslessWalletDeployerLib.getOrDeployGaslessWallet(owner, walletId);
		uint256 creationFee = deployed ? walletCreationFee : 0;
		if (creationFee > 0) {
			qWallet.transfer(collateralToken, treasury, creationFee);
			emit WalletCreationFeeCollected(address(qWallet), address(qWallet), creationFee);
		}
		GaslessFeeQuoteLib.recordWalletPayment(collateralToken, address(qWallet), 0, creationFee);
		return qWallet;
	}

	// ═══════════════════════ Internal: Deposits ═══════════════════════

	/// @dev Enforce the gross minimum, then deduct the deposit fee and any fee for deploying this wallet.
	function _sweepDepositAndCollectFee(address owner, uint256 walletId) internal returns (uint256 netDeposit, uint256 collectedDepositFee) {
		(GaslessWallet qWallet, bool deployed) = GaslessWalletDeployerLib.getOrDeployGaslessWallet(owner, walletId);
		uint256 creationFee = deployed ? walletCreationFee : 0;
		uint256 grossDeposit = qWallet.sweepTokenBalance(collateralToken, address(this));
		if (grossDeposit < minimumDeposit) revert DepositAmountBelowMinimum(grossDeposit, minimumDeposit);
		collectedDepositFee = depositFee;
		uint256 totalFees = collectedDepositFee + creationFee;
		if (grossDeposit <= totalFees) revert DepositAmountNotAboveFees(grossDeposit, totalFees);
		if (totalFees > 0) IERC20(collateralToken).safeTransfer(treasury, totalFees);
		if (collectedDepositFee > 0) emit DepositFeeCollected(owner, treasury, collectedDepositFee);
		if (creationFee > 0) emit WalletCreationFeeCollected(address(qWallet), address(qWallet), creationFee);
		GaslessFeeQuoteLib.recordWalletPayment(collateralToken, address(qWallet), collectedDepositFee, creationFee);
		netDeposit = grossDeposit - totalFees;
	}

	function _depositCollateralToCore(address account, uint256 amount) internal {
		IERC20(collateralToken).forceApprove(address(core), amount);
		core.depositFor(account, amount);
	}

	// ═════════════════════ Internal: Account Resolution ═════════════════════

	/// @dev VA → parent SubAccount; SubAccount / PartyB / EOA / unknown → as-is.
	function _resolveBillingAccount(address account) internal view returns (address) {
		return GaslessBillingIdentity.resolveBillingAccount(accountLayer, account);
	}

	// ═════════════════════ Internal: Wallet Dispatch ═════════════════════

	/// @dev Match the target to the selected owner-derived wallet; reject mismatches for positive indices.
	function _isWalletOperation(IInstantLayer.SignedOperation calldata signedOp, uint256 walletId) internal view returns (bool) {
		return GaslessWalletExecutionLib.isWalletOperation(address(accountLayer), signedOp, walletId);
	}

	/// @dev Check whether the batch requires wallet dispatch using the supplied indices.
	function _hasWalletOperation(IInstantLayer.SignedOperation[] calldata signedOps, uint256[] memory walletIds) internal view returns (bool) {
		for (uint256 i = 0; i < signedOps.length; i++) {
			if (_isWalletOperation(signedOps[i], walletIds[i])) return true;
		}
		return false;
	}

	/// @dev Use the selected wallet's nonce storage and return its execution result with the decoded inner-call selectors.
	/// @return result Encoded results of the wallet's calls.
	/// @return feeSelectors Inner-call selectors used for subsequent fee calculation.
	/// @return creationFee Fee due only if this operation deployed the wallet.
	function _executeWalletOperation(
		IInstantLayer.SignedOperation calldata signedOp,
		bytes calldata signature,
		uint256 walletId
	) internal returns (bytes memory result, bytes4[] memory feeSelectors, uint256 creationFee) {
		uint256 configuredCreationFee = walletCreationFee;
		// Index zero retains the original nonce storage, including signatures made before upgrading.
		mapping(address => uint256) storage nonces = _legacyWalletOperationNonces;
		if (walletId != 0) nonces = walletNonces[signedOp.target];
		GaslessWalletExecutionLib.WalletExecutionResult memory execution = GaslessWalletExecutionLib.executeWalletOperation(
			nonces,
			address(accountLayer),
			address(instantLayer),
			signedOp,
			signature,
			walletId
		);
		emit WalletOperationRelayed(msg.sender, execution.owner, execution.wallet, execution.callCount);
		return (execution.result, execution.feeSelectors, execution.deployed ? configuredCreationFee : 0);
	}

	function _executeSingleInstantOperation(
		IInstantLayer.SignedOperation calldata signedOp,
		bytes calldata signature,
		bytes[] memory fills,
		bytes[] memory flexFillerSignatures
	) internal returns (bytes memory result) {
		IInstantLayer.SignedOperation[] memory ops = new IInstantLayer.SignedOperation[](1);
		bytes[] memory sigs = new bytes[](1);
		bytes[][] memory fillSet = new bytes[][](1);
		bytes[][] memory flexSigSet = new bytes[][](1);

		ops[0] = signedOp;
		sigs[0] = signature;
		fillSet[0] = fills;
		flexSigSet[0] = flexFillerSignatures;

		bytes[] memory results = instantLayer.executeBatch(ops, sigs, fillSet, flexSigSet);
		return results[0];
	}

	/// @dev Read fills or flex signatures by operation index in a mixed batch.
	///      Wallet operations do not need entries; an out-of-range index returns an empty array.
	function _opValuesOrEmpty(bytes[][] calldata values, uint256 index) internal pure returns (bytes[] memory result) {
		if (index >= values.length) return new bytes[](0);

		bytes[] calldata opValues = values[index];
		result = new bytes[](opValues.length);
		for (uint256 i = 0; i < opValues.length; i++) {
			result[i] = opValues[i];
		}
	}

	// ═════════════════════ Internal: Fee Accounting ═════════════════════

	/// @dev Core balances and allowances use 18 decimals; deposit and recovery fees use collateral token decimals.
	///      Core only permits collateral tokens with at most 18 decimals, so conversion is exact.
	function _creationFeeInCoreDecimals(uint256 amount) internal view returns (uint256) {
		if (amount == 0) return 0;
		return amount * (10 ** (18 - IERC20Metadata(collateralToken).decimals()));
	}

	/// @dev Base per-selector fee, before any core allowance multiplier.
	function _baseSelectorFee(bytes4 selector) internal view returns (uint256) {
		SelectorFeeConfig memory config = selectorFeeConfigs[selector];
		return config.configured ? config.amount : defaultSelectorFee;
	}

	/// @dev Sum one operation's selector fees. The settlement library applies the actual payer's core multiplier later.
	function _baseOperationalFee(bytes4[] memory selectors) internal view returns (uint256 fee) {
		for (uint256 i = 0; i < selectors.length; i++) {
			fee += _baseSelectorFee(selectors[i]);
		}
	}

	/// @dev InstantLayer operations are priced by their outer selector, even if another contract
	///      exposes the same execute signature as GaslessWallet. Classification belongs to dispatch.
	function _instantOperationFeeSelectors(IInstantLayer.SignedOperation calldata signedOp) internal pure returns (bytes4[] memory selectors) {
		selectors = new bytes4[](1);
		selectors[0] = signedOp.callData.length < 4 ? bytes4(0) : bytes4(signedOp.callData[:4]);
	}

	function _instantBatchFeeSelectors(IInstantLayer.SignedOperation[] calldata signedOps) internal pure returns (bytes4[][] memory selectors) {
		selectors = new bytes4[][](signedOps.length);
		for (uint256 i = 0; i < signedOps.length; i++) selectors[i] = _instantOperationFeeSelectors(signedOps[i]);
	}

	function _collectOneOperationalFee(address signerAccount, bytes4 selector) internal returns (address payer, uint256 fee) {
		address billingParent = _resolveBillingAccount(signerAccount);
		GaslessOperationalFeeLib.OpBilling[] memory ops = new GaslessOperationalFeeLib.OpBilling[](1);
		ops[0] = GaslessOperationalFeeLib.OpBilling({
			signer: signerAccount,
			billingParent: billingParent,
			baseFee: _useDailyFreeOp(billingParent) ? 0 : _baseSelectorFee(selector),
			creationFee: 0
		});
		(uint256 totalFee, address[] memory opPayers, ) = GaslessOperationalFeeLib.settleOperationalFees(address(core), address(accountLayer), ops);
		payer = opPayers[0];
		fee = totalFee;
		emit OperationalFeeRouted(signerAccount, payer, fee);
	}

	/// @dev Price the selectors captured during dispatch and resolve payers after execution.
	///      VA signers bill their parent SubAccount, even if deleted in this batch: parentAccount remains on the
	///      pooled record, and the parent receives the VA's returned funds. If the parent cannot pay, settlement tries
	///      the signer VA under the rules in GaslessOperationalFeeLib.settleOperationalFees.
	///      Each payer is charged once after execution. OperationalFeeRouted records each operation's share of that charge.
	///      A later failure reverts every charge.
	function _collectOperationalFees(
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes4[][] memory feeSelectors,
		uint256[] memory creationFees
	) internal returns (uint256 totalFee) {
		uint256 n = signedOps.length;
		GaslessOperationalFeeLib.OpBilling[] memory ops = new GaslessOperationalFeeLib.OpBilling[](n);
		for (uint256 i = 0; i < n; i++) {
			address signer = signedOps[i].signerAccount.addr;
			address billingParent = _resolveBillingAccount(signer);
			// Use the parent's free quota regardless of the eventual payer.
			// Otherwise, pass the operation's summed selector fees to settlement.
			ops[i] = GaslessOperationalFeeLib.OpBilling({
				signer: signer,
				billingParent: billingParent,
				baseFee: _useDailyFreeOp(billingParent) ? 0 : _baseOperationalFee(feeSelectors[i]),
				creationFee: _creationFeeInCoreDecimals(creationFees[i])
			});
		}

		address[] memory opPayers;
		uint256[] memory opFees;
		(totalFee, opPayers, opFees) = GaslessOperationalFeeLib.settleOperationalFees(address(core), address(accountLayer), ops);

		for (uint256 i = 0; i < n; i++) {
			GaslessFeeLimits.check(signedOps[i].replayAttackHeader.salt, opFees[i]);
			emit OperationalFeeRouted(ops[i].signer, opPayers[i], opFees[i]);
			if (creationFees[i] > 0) emit WalletCreationFeeCollected(signedOps[i].target, opPayers[i], creationFees[i]);
		}
	}

	// dailyFreeOpsRemaining, getAccountOperationalFee, and _useDailyFreeOp share these day and quota calculations.
	// Tests check that quotes and charges agree on whether an operation is free.

	/// @dev Current UTC day index (matches the packed DailyFreeOpsUsage.day).
	function _todayIndex() internal view returns (uint64) {
		return uint64(block.timestamp / 1 days);
	}

	/// @dev Free ops already used by an account on `today`, resetting to 0 when the packed day is stale.
	function _usedFreeOpsToday(DailyFreeOpsUsage memory usage, uint64 today) internal pure returns (uint256) {
		return usage.day == today ? usage.count : 0;
	}

	/// @dev Free ops still available given how many are used and the daily limit.
	function _remainingFreeOps(uint256 usedToday, uint256 limit) internal pure returns (uint256) {
		return usedToday >= limit ? 0 : limit - usedToday;
	}

	/// @dev Consume one free-operation slot for `account` today, returning true if this op is covered
	///      (free). Returns false when there is no quota (`dailyFreeOpsLimit == 0`) or it is exhausted in
	///      charge mode; reverts in block mode once the quota is exhausted.
	function _useDailyFreeOp(address account) internal returns (bool covered) {
		uint256 limit = dailyFreeOpsLimit;
		if (limit == 0) return false;

		uint64 today = _todayIndex();
		uint256 usedToday = _usedFreeOpsToday(dailyFreeOpsUsage[account], today);

		if (_remainingFreeOps(usedToday, limit) == 0) {
			if (revertWhenFreeQuotaExhausted) revert DailyFreeOpsLimitExceeded(account, limit);
			return false;
		}

		dailyFreeOpsUsage[account] = DailyFreeOpsUsage({ day: today, count: uint192(usedToday + 1) });
		GaslessFeeAccounting.freeOperation();
		emit DailyFreeOpsUsed(account, 1, usedToday + 1, limit);
		return true;
	}

	// ═════════════════════ Upgrade Authorization ═════════════════════

	function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
