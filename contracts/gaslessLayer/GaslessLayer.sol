// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { GaslessWallet } from "./GaslessWallet.sol";
import { IGaslessLayer } from "./interfaces/IGaslessLayer.sol";
import { IInstantLayer } from "./interfaces/IInstantLayer.sol";
import { ISymmioCore } from "./interfaces/ISymmioCore.sol";
import { ISymmioAccountLayer, SubAccountCreationData } from "./interfaces/ISymmioAccountLayer.sol";
import { GaslessBillingIdentity } from "./libraries/GaslessBillingIdentity.sol";
import { GaslessNativeGasTopUpLib } from "./libraries/GaslessNativeGasTopUpLib.sol";
import { GaslessOperationalFeeLib } from "./libraries/GaslessOperationalFeeLib.sol";
import { GaslessWalletDeployerLib } from "./libraries/GaslessWalletDeployerLib.sol";
import { GaslessWalletExecutionLib } from "./libraries/GaslessWalletExecutionLib.sol";

/// @title GaslessLayer
/// @notice Relay signed operations, settle bridged deposits, and fund native gas top-ups.
/// @dev The UUPS proxy is the CREATE2 deployer of every GaslessWallet. Index zero preserves the
///      original wallet address and nonce storage; positive indices identify additional wallets.
///      Wallet operations execute through the gateway, while ordinary operations use InstantLayer.
///      Operational fees are charged to SYMMIO billing accounts after batch execution. Deposits
///      sweep the selected wallet's full collateral balance and deduct the configured flat fee.
///      Linked libraries execute in proxy context and keep implementation size within EIP-170.
contract GaslessLayer is IGaslessLayer, Initializable, AccessControlUpgradeable, ReentrancyGuard, UUPSUpgradeable {
	using SafeERC20 for IERC20;

	// ───────────────────────── Constants ──────────────────────────

	bytes32 public constant CONFIG_ADMIN_ROLE = keccak256("CONFIG_ADMIN_ROLE");
	bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
	uint256 internal constant FEE_MULTIPLIER_BASE = 10000;
	// ABI-facing wallet signing constants. The execution library owns the logic, but integrators read
	// these values from the layer proxy when building wallet-operation typed data and delegation grants.
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

	/// @notice Owner and index identifying the GaslessWallet used for deposit settlement.
	/// @dev Keeping these fields in one memory value avoids duplicated settlement code with the pinned compiler.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param index Wallet index; zero selects the original wallet.
	struct DepositWallet {
		address owner;
		uint256 index;
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
	mapping(address => uint256) public walletOperationNonces;

	/// @notice Last consumed nonce by GaslessWallet address and signer account for positive wallet indices.
	/// @dev Index zero uses walletOperationNonces to preserve its existing nonce stream.
	mapping(address => mapping(address => uint256)) public walletNonces;

	uint256[32] private __gap;

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

	/// @notice Relay InstantLayer and index-zero GaslessWallet operations and collect their fees.
	/// @dev Relayer-only. The signed target selects the execution route. The gateway must be an InstantLayer executor.
	///      All operations execute before fees are collected, so fee approvals can fund the same batch.
	///      Wallet operations are priced by their inner-call selectors; InstantLayer operations use their outer selector.
	///      Virtual accounts share their parent's billing quota, and fee settlement can use a signer-VA fallback.
	/// @param signedOps Signed operations in execution order.
	/// @param signatures Signature for each operation, in the same order.
	/// @param fills InstantLayer flexible-field values by operation; wallet operations ignore their entries.
	/// @param flexFillerSignatures InstantLayer flexible-field signatures by operation; wallet operations ignore their entries.
	/// @return results Encoded result of each operation, in execution order.
	function relayInstantBatch(
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (bytes[] memory results) {
		return _relayInstantBatch(signedOps, signatures, fills, flexFillerSignatures, new uint256[](0));
	}

	/// @notice Relay InstantLayer and indexed GaslessWallet operations and collect their fees.
	/// @dev Relayer-only. Positive indices require an owner-derived wallet target; zero retains target-based dispatch.
	///      Uses the same signature, execution, and fee rules as relayInstantBatch, including the original nonce stream at zero.
	/// @param signedOps Signed operations in execution order.
	/// @param signatures Signature for each operation, in the same order.
	/// @param fills InstantLayer flexible-field values by operation; wallet operations ignore their entries.
	/// @param flexFillerSignatures InstantLayer flexible-field signatures by operation; wallet operations ignore their entries.
	/// @param walletIds Wallet index per operation; use zero for InstantLayer operations or the original wallet.
	/// @return results Encoded result of each operation, in execution order.
	function relayWalletBatch(
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures,
		uint256[] calldata walletIds
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (bytes[] memory results) {
		if (walletIds.length != signedOps.length) revert ArrayLengthMismatch();
		return _relayInstantBatch(signedOps, signatures, fills, flexFillerSignatures, walletIds);
	}

	/// @dev Execute each operation through its selected route and pass the identified selectors to fee collection.
	/// @param walletIds Wallet indices aligned with signedOps; an empty array defaults every index to zero.
	function _relayInstantBatch(
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures,
		uint256[] memory walletIds
	) internal returns (bytes[] memory results) {
		if (signedOps.length == 0) revert EmptyOperationBatch();
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();

		// Fill array lengths are left to the InstantLayer for pure instant batches. Mixed
		// wallet+instant batches run op-by-op: wallet ops ignore fills, and instant ops read their
		// own slot via _opValuesOrEmpty so omitted wallet slots default to empty.

		bytes4[][] memory feeSelectors;
		if (!_hasWalletOperation(signedOps, walletIds)) {
			results = instantLayer.executeBatch(signedOps, signatures, fills, flexFillerSignatures);
			feeSelectors = _instantBatchFeeSelectors(signedOps);
		} else {
			results = new bytes[](signedOps.length);
			feeSelectors = new bytes4[][](signedOps.length);
			for (uint256 i = 0; i < signedOps.length; i++) {
				uint256 walletId = _walletIdAt(walletIds, i);
				if (_isWalletOperation(signedOps[i], walletId)) {
					(results[i], feeSelectors[i]) = _executeWalletOperation(signedOps[i], signatures[i], walletId);
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

		uint256 totalFee = _collectOperationalFees(signedOps, feeSelectors);

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

		// A template is always a pure instant sequence; instantLayer.executeTemplate validates the
		// signature/fill/flex lengths and the op shape against the registered template.
		results = instantLayer.executeTemplate(templateId, signedOps, signatures, fills, flexFillerSignatures);

		uint256 totalFee = _collectOperationalFees(signedOps, _instantBatchFeeSelectors(signedOps));

		emit InstantTemplateRelayed(msg.sender, templateId, signedOps.length, totalFee);
	}

	/// @notice Relay a user-signed InstantLayer delegation setup and settle one operational fee/free usage.
	/// @dev Delegation grants can also ride relayInstantBatch as owner-signed grant operations; this
	///      dedicated surface relays the InstantLayer's standalone grantBatchDelegationBySig form. The
	///      payer is the delegation account resolved through the same VA→parent billing rule as normal
	///      instant operations. One relay call consumes one free daily usage, regardless of how many
	///      selectors are granted inside the delegation.
	function relayGrantBatchDelegationBySig(
		IInstantLayer.SignedDelegation calldata signedDelegation,
		bytes calldata signature
	) external onlyRole(RELAYER_ROLE) nonReentrant {
		IInstantLayer.DelegationInfo calldata info = signedDelegation.delegationInfo;
		address delegatorAccount = info.account.addr;
		(address payer, uint256 fee) = _collectOneOperationalFee(delegatorAccount, IInstantLayer.grantBatchDelegationBySig.selector);

		instantLayer.grantBatchDelegationBySig(signedDelegation, signature);

		emit DelegationBySigRelayed(msg.sender, delegatorAccount, payer, info.delegatedSigner, info.selectors.length, fee);
	}

	/// @notice Relay a user-signed native gas top-up funded by the relayer's `msg.value`.
	/// @dev The payer is sponsored while its daily native allowance covers the request. Once exhausted,
	///      config decides whether to revert or charge the signed collateral amount plus the configured
	///      on-chain top-up fee through core. Signature checks, nonce consumption, sponsor accounting,
	///      and native transfer live in GaslessNativeGasTopUpLib to keep the implementation below EIP-170.
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

	/// @notice Settle collateral from wallet index zero into a new owner-held sub-account.
	/// @dev Relayer-only. Sweeps the wallet's full collateral balance, deducts the flat deposit fee, and emits WalletDepositSettled.
	///      The relayer supplies the affiliate and account settings without a user signature. AccountLayer validates those settings.
	/// @param wallet Owner address used to derive the index-zero GaslessWallet address.
	/// @param affiliate Affiliate selected by the relayer for the new account.
	/// @param accountData Account settings; symmioCore is replaced with the gateway's configured core.
	/// @return subAccount Address of the created and funded sub-account.
	function settleDepositToNewAccount(
		address wallet,
		address affiliate,
		SubAccountCreationData calldata accountData
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (address subAccount) {
		return _settleDepositToNewAccount(DepositWallet(wallet, 0), affiliate, accountData);
	}

	/// @notice Settle collateral from the selected wallet into a new owner-held sub-account.
	/// @dev Uses the same relayer authorization, full-balance sweep, fee, and account-creation rules as settleDepositToNewAccount.
	///      Emits WalletDepositSettled for every index, including zero.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletIndex Wallet index; zero selects the original wallet.
	/// @param affiliate Affiliate selected by the relayer for the new account.
	/// @param accountData Account settings; symmioCore is replaced with the gateway's configured core.
	/// @return subAccount Address of the created and funded sub-account.
	function settleWalletDepositToNewAccount(
		address owner,
		uint256 walletIndex,
		address affiliate,
		SubAccountCreationData calldata accountData
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (address subAccount) {
		return _settleDepositToNewAccount(DepositWallet(owner, walletIndex), affiliate, accountData);
	}

	/// @dev Sweep the selected wallet, create the sub-account, verify its owner, and deposit the net collateral.
	function _settleDepositToNewAccount(
		DepositWallet memory wallet,
		address affiliate,
		SubAccountCreationData calldata accountData
	) internal returns (address subAccount) {
		if (wallet.owner == address(0)) revert ZeroAddress();

		(uint256 netDeposit, uint256 collectedDepositFee) = _sweepDepositAndCollectFee(wallet);

		SubAccountCreationData[] memory accountsData = new SubAccountCreationData[](1);
		accountsData[0] = accountData;
		accountsData[0].symmioCore = address(core); // the gateway deposits to its own core — keep them consistent
		address[] memory created = accountLayer.createSubAccountsFor(wallet.owner, affiliate, accountsData);
		subAccount = created[0];

		// Defense in depth: the created account must be owned by the wallet owner we are crediting.
		address actualOwner = accountLayer.ownerOf(subAccount);
		if (actualOwner != wallet.owner) revert AccountOwnerMismatch(subAccount, wallet.owner, actualOwner);

		_depositCollateralToCore(subAccount, netDeposit);
		emit WalletDepositSettled(wallet.owner, wallet.index, subAccount, netDeposit, collectedDepositFee);
	}

	/// @notice Settle collateral from wallet index zero into an existing owner-held sub-account.
	/// @dev Relayer-only. The sub-account must belong to wallet. Sweeps the full collateral balance, deducts the flat deposit fee,
	///      and emits WalletDepositSettled. Relayer authorization controls which of the owner's sub-accounts receives the deposit.
	/// @param wallet Owner address used to derive the index-zero GaslessWallet address.
	/// @param subAccount Existing sub-account that receives the net deposit.
	function settleDepositToExistingAccount(address wallet, address subAccount) external onlyRole(RELAYER_ROLE) nonReentrant {
		_settleDepositToExistingAccount(DepositWallet(wallet, 0), subAccount);
	}

	/// @notice Settle collateral from the selected wallet into an existing owner-held sub-account.
	/// @dev Uses the same relayer authorization, destination-owner check, full-balance sweep, and fee rules as settleDepositToExistingAccount.
	///      Emits WalletDepositSettled for every index, including zero.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletIndex Wallet index; zero selects the original wallet.
	/// @param subAccount Existing sub-account that receives the net deposit.
	function settleWalletDepositToExistingAccount(
		address owner,
		uint256 walletIndex,
		address subAccount
	) external onlyRole(RELAYER_ROLE) nonReentrant {
		_settleDepositToExistingAccount(DepositWallet(owner, walletIndex), subAccount);
	}

	/// @dev Verify the destination owner, sweep the selected wallet, and deposit the net collateral.
	function _settleDepositToExistingAccount(DepositWallet memory wallet, address subAccount) internal {
		if (wallet.owner == address(0) || subAccount == address(0)) revert ZeroAddress();

		address owner = accountLayer.ownerOf(subAccount);
		if (owner != wallet.owner) revert AccountOwnerMismatch(subAccount, wallet.owner, owner);

		(uint256 netDeposit, uint256 collectedDepositFee) = _sweepDepositAndCollectFee(wallet);
		_depositCollateralToCore(subAccount, netDeposit);
		emit WalletDepositSettled(wallet.owner, wallet.index, subAccount, netDeposit, collectedDepositFee);
	}

	// ═══════════════════════ Wallet Views ════════════════════════

	/// @notice Predict the owner's index-zero GaslessWallet address without deploying it.
	/// @dev Preserves the original CREATE2 address. Collateral can arrive at this address before deployment.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @return Predicted index-zero GaslessWallet address.
	function getGaslessWalletAddress(address owner) public view returns (address) {
		return GaslessWalletDeployerLib.getGaslessWalletAddress(owner);
	}

	/// @notice Predict the owner's selected GaslessWallet address without deploying it.
	/// @dev Index zero returns the same address as getGaslessWalletAddress.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @return Predicted GaslessWallet address.
	function getWalletAddress(address owner, uint256 walletId) external view returns (address) {
		return GaslessWalletDeployerLib.getWalletAddress(owner, walletId);
	}

	/// @notice Read the last consumed wallet-operation nonce for the selected wallet and signer account.
	/// @dev Index zero reads the original signer-account nonce mapping; positive indices use wallet-specific mappings.
	/// @param owner Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @param signerAccount Account specified in the signed operation.
	/// @return Last consumed nonce; the next operation must use this value plus one.
	function getWalletOperationNonce(address owner, uint256 walletId, address signerAccount) external view returns (uint256) {
		if (walletId == 0) return walletOperationNonces[signerAccount];
		address wallet = GaslessWalletDeployerLib.getWalletAddress(owner, walletId);
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

	/// @notice Set the per-account daily free-operation quota — the first N ops per account per UTC day waive
	///         their base fee. 0 = no free quota (every op pays its base fee).
	function setDailyFreeOpsLimit(uint256 limit) external onlyRole(CONFIG_ADMIN_ROLE) {
		dailyFreeOpsLimit = limit;
		emit DailyFreeOpsLimitUpdated(limit);
	}

	/// @notice Choose what happens once an account's free quota is exhausted.
	/// @dev true = revert (`DailyFreeOpsLimitExceeded`) instead of charging — the pre-0.8.6 "free then
	///      block" mode, since charging needs core.chargeOperationalFee. false = charge the op's base fee.
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

	/// @notice Quote account fees for InstantLayer and index-zero GaslessWallet operations.
	/// @dev Target identification and call decoding run before quota pricing, including for free-covered operations.
	///      Billing uses the parent's quota and plans signer-VA fallback fees when the parent cannot pay.
	///      An approval-only quote uses the parent's post-approval multiplier; a later VA fallback can change the actual charge.
	/// @param account Account whose operations are quoted; virtual accounts resolve to their billing parent.
	/// @param signedOps Operations to identify and price; only the requested billing account's operations contribute to the quote.
	/// @return amountDue Total quoted collateral charge; zero when fully waived or blocked by the quota policy.
	/// @return freeOpsApplied Number of the billing account's operations covered by its remaining daily quota.
	/// @return wouldBlockOnQuota Whether execution would exceed the daily quota in block mode.
	function getAccountOperationalFee(
		address account,
		IInstantLayer.SignedOperation[] calldata signedOps
	) external view returns (uint256 amountDue, uint256 freeOpsApplied, bool wouldBlockOnQuota) {
		return _getAccountOperationalFee(account, signedOps, _quoteBatchFeeSelectors(signedOps, new uint256[](0)));
	}

	/// @notice Quote account fees for InstantLayer and indexed GaslessWallet operations.
	/// @dev Target identification and call decoding run before quota pricing, including for free-covered operations.
	///      Billing uses the parent's quota and plans signer-VA fallback fees when the parent cannot pay.
	///      An approval-only quote uses the parent's post-approval multiplier; a later VA fallback can change the actual charge.
	/// @param account Account whose operations are quoted; virtual accounts resolve to their billing parent.
	/// @param signedOps Operations to identify and price; only the requested billing account's operations contribute to the quote.
	/// @param walletIds Wallet index per operation; use zero for InstantLayer operations or the original wallet.
	/// @return amountDue Total quoted collateral charge; zero when fully waived or blocked by the quota policy.
	/// @return freeOpsApplied Number of the billing account's operations covered by its remaining daily quota.
	/// @return wouldBlockOnQuota Whether execution would exceed the daily quota in block mode.
	function getAccountOperationalFeeForWallets(
		address account,
		IInstantLayer.SignedOperation[] calldata signedOps,
		uint256[] calldata walletIds
	) external view returns (uint256 amountDue, uint256 freeOpsApplied, bool wouldBlockOnQuota) {
		if (walletIds.length != signedOps.length) revert ArrayLengthMismatch();
		return _getAccountOperationalFee(account, signedOps, _quoteBatchFeeSelectors(signedOps, walletIds));
	}

	/// @dev Apply account quotas and payer rules to selectors already identified by the quote entry point.
	/// @param account Account whose operations are quoted.
	/// @param signedOps Operations supplying signer identities and any fee-approval data.
	/// @param feeSelectors Identified call selectors aligned with signedOps; no wallet identification occurs here.
	/// @return amountDue Total quoted collateral charge; zero when fully waived or blocked by the quota policy.
	/// @return freeOpsApplied Number of the billing account's operations covered by its remaining daily quota.
	/// @return wouldBlockOnQuota Whether execution would exceed the daily quota in block mode.
	function _getAccountOperationalFee(
		address account,
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes4[][] memory feeSelectors
	) internal view returns (uint256 amountDue, uint256 freeOpsApplied, bool wouldBlockOnQuota) {
		address billingAccount = _resolveBillingAccount(account);
		bool approvalOnlyQuote = signedOps.length == 1 && _isOperationalFeeApproval(signedOps[0]);
		uint256 limit = dailyFreeOpsLimit;
		uint256 freeRemaining;
		if (limit > 0) {
			uint256 usedToday = _usedFreeOpsToday(dailyFreeOpsUsage[billingAccount], _todayIndex());
			freeRemaining = _remainingFreeOps(usedToday, limit);
		}

		GaslessOperationalFeeLib.OpBilling[] memory ops = new GaslessOperationalFeeLib.OpBilling[](signedOps.length);
		uint256 chargeableCount;
		for (uint256 i = 0; i < signedOps.length; i++) {
			if (_resolveBillingAccount(signedOps[i].signerAccount.addr) != billingAccount) continue;
			if (freeRemaining > 0) {
				freeRemaining--;
				freeOpsApplied++;
				continue; // covered by this billing account's daily quota
			}
			if (limit > 0 && revertWhenFreeQuotaExhausted) return (0, freeOpsApplied, true);
			if (approvalOnlyQuote) {
				// An approval funds itself before fee collection, so it is always priced on the parent.
				amountDue += _postApprovalOperationalFee(billingAccount, signedOps[i]);
				continue;
			}
			ops[chargeableCount++] = GaslessOperationalFeeLib.OpBilling({
				signer: signedOps[i].signerAccount.addr,
				billingParent: billingAccount,
				baseFee: _baseOperationalFee(feeSelectors[i])
			});
		}
		if (chargeableCount > 0) {
			assembly ("memory-safe") {
				mstore(ops, chargeableCount) // trim to the chargeable prefix
			}
			(, uint256[] memory opFees) = GaslessOperationalFeeLib.planOperationalFees(address(core), address(accountLayer), ops);
			for (uint256 i = 0; i < opFees.length; i++) {
				amountDue += opFees[i];
			}
		}
	}

	// ═══════════════════════ Admin Recovery ═══════════════════════

	function setTreasury(address treasury_) external onlyRole(CONFIG_ADMIN_ROLE) {
		if (treasury_ == address(0)) revert ZeroAddress();
		treasury = treasury_;
		emit TreasuryUpdated(treasury_);
	}

	/// @notice Re-point the gateway at a replacement InstantLayer.
	/// @dev The InstantLayer is not upgradeable, so a redeploy has to be followed by this call
	///      (typically as the init data of the accompanying upgradeToAndCall). The new layer must
	///      grant this gateway OPERATOR_ROLE before relays resume.
	function setInstantLayer(address instantLayer_) external onlyRole(CONFIG_ADMIN_ROLE) {
		if (instantLayer_ == address(0)) revert ZeroAddress();
		instantLayer = IInstantLayer(instantLayer_);
		emit InstantLayerUpdated(instantLayer_);
	}

	/// @notice Recover non-collateral tokens from the owner's index-zero GaslessWallet.
	/// @dev Config-admin-only. Rejects the collateral token and a zero recipient. Deploys the wallet if needed
	///      and emits WalletNonCollateralTokenRecovered with the source GaslessWallet address.
	/// @param wallet Owner address used to derive the GaslessWallet address.
	/// @param token Non-collateral token to recover.
	/// @param recipient Address receiving the wallet's full balance of token.
	/// @return amount Token amount recovered.
	function recoverNonCollateralToken(
		address wallet,
		address token,
		address recipient
	) external onlyRole(CONFIG_ADMIN_ROLE) returns (uint256 amount) {
		if (token == collateralToken) revert CollateralRecoveryDisabled();
		if (recipient == address(0)) revert ZeroAddress();
		(GaslessWallet qWallet, ) = GaslessWalletDeployerLib.getOrDeployGaslessWallet(wallet, 0);
		amount = qWallet.sweepTokenBalance(token, recipient);
		emit WalletNonCollateralTokenRecovered(address(qWallet), token, recipient, amount);
	}

	/// @notice Recover non-collateral tokens from the selected GaslessWallet.
	/// @dev Config-admin-only. Rejects the collateral token and a zero recipient. Deploys the wallet if needed
	///      and emits WalletNonCollateralTokenRecovered with the source GaslessWallet address.
	/// @param wallet Owner address used to derive the GaslessWallet address.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @param token Non-collateral token to recover.
	/// @param recipient Address receiving the wallet's full balance of token.
	/// @return amount Token amount recovered.
	function recoverWalletNonCollateralToken(
		address wallet,
		uint256 walletId,
		address token,
		address recipient
	) external onlyRole(CONFIG_ADMIN_ROLE) returns (uint256 amount) {
		if (token == collateralToken) revert CollateralRecoveryDisabled();
		if (recipient == address(0)) revert ZeroAddress();
		(GaslessWallet qWallet, ) = GaslessWalletDeployerLib.getOrDeployGaslessWallet(wallet, walletId);
		amount = qWallet.sweepTokenBalance(token, recipient);
		emit WalletNonCollateralTokenRecovered(address(qWallet), token, recipient, amount);
	}

	// ═══════════════════════ Internal: Deposits ═══════════════════════

	/// @dev Deploy the selected wallet if needed, sweep all collateral, enforce the minimum deposit, and deduct the flat fee.
	function _sweepDepositAndCollectFee(DepositWallet memory wallet) internal returns (uint256 netDeposit, uint256 collectedDepositFee) {
		(GaslessWallet qWallet, ) = GaslessWalletDeployerLib.getOrDeployGaslessWallet(wallet.owner, wallet.index);
		uint256 grossDeposit = qWallet.sweepTokenBalance(collateralToken, address(this));
		if (grossDeposit < minimumDeposit) revert DepositAmountBelowMinimum(grossDeposit, minimumDeposit);
		collectedDepositFee = depositFee;
		if (collectedDepositFee > 0) {
			IERC20(collateralToken).safeTransfer(treasury, collectedDepositFee);
			emit DepositFeeCollected(wallet.owner, treasury, collectedDepositFee);
		}
		netDeposit = grossDeposit - collectedDepositFee;
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
			if (_isWalletOperation(signedOps[i], _walletIdAt(walletIds, i))) return true;
		}
		return false;
	}

	/// @dev Identify targets and decode selectors before quota and fee calculation; validates every supplied operation.
	/// @param signedOps Operations whose fee selectors are identified.
	/// @param walletIds Wallet indices aligned with signedOps; an empty array defaults every index to zero.
	/// @return selectors Inner selectors for wallet operations or the outer selector for InstantLayer operations.
	function _quoteBatchFeeSelectors(
		IInstantLayer.SignedOperation[] calldata signedOps,
		uint256[] memory walletIds
	) internal view returns (bytes4[][] memory selectors) {
		selectors = new bytes4[][](signedOps.length);
		for (uint256 i = 0; i < signedOps.length; i++) {
			selectors[i] = GaslessWalletExecutionLib.quoteOperationalFeeSelectors(address(accountLayer), signedOps[i], _walletIdAt(walletIds, i));
		}
	}

	/// @dev Read an operation's wallet index, defaulting to zero when the index array is empty.
	function _walletIdAt(uint256[] memory walletIds, uint256 index) internal pure returns (uint256) {
		return walletIds.length == 0 ? 0 : walletIds[index];
	}

	/// @dev Recognizes the only post-state mutation that the read-only fee quote can price exactly.
	///      Flex fields are excluded because they could mutate the selector after this classification.
	function _isOperationalFeeApproval(IInstantLayer.SignedOperation calldata signedOp) internal view returns (bool) {
		if (signedOp.target != address(core) || signedOp.callData.length < 4 || signedOp.flexFields.length != 0) return false;
		bytes4 selector = bytes4(signedOp.callData[:4]);
		return selector == ISymmioCore.approveOperationalFee.selector || selector == ISymmioCore.approveOperationalFeeWithMultiplier.selector;
	}

	/// @dev Use the selected wallet's nonce storage and return its execution result with the decoded inner-call selectors.
	/// @return result Encoded results of the wallet's calls.
	/// @return feeSelectors Inner-call selectors used for subsequent fee calculation.
	function _executeWalletOperation(
		IInstantLayer.SignedOperation calldata signedOp,
		bytes calldata signature,
		uint256 walletId
	) internal returns (bytes memory result, bytes4[] memory feeSelectors) {
		// Index zero retains the original nonce storage, including signatures made before upgrading.
		mapping(address => uint256) storage nonces = walletOperationNonces;
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
		return (execution.result, execution.feeSelectors);
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

	/// @dev Per-op fills/flex lookup for the mixed wallet+instant loop. A wallet op occupying an earlier
	///      slot means the relayer may legitimately omit that index, so an out-of-range lookup returns
	///      an empty array rather than reverting.
	function _opValuesOrEmpty(bytes[][] calldata values, uint256 index) internal pure returns (bytes[] memory result) {
		if (index >= values.length) return new bytes[](0);

		bytes[] calldata opValues = values[index];
		result = new bytes[](opValues.length);
		for (uint256 i = 0; i < opValues.length; i++) {
			result[i] = opValues[i];
		}
	}

	// ═════════════════════ Internal: Fee Accounting ═════════════════════

	/// @dev Base per-selector fee, before any core allowance multiplier.
	function _baseSelectorFee(bytes4 selector) internal view returns (uint256) {
		SelectorFeeConfig memory config = selectorFeeConfigs[selector];
		return config.configured ? config.amount : defaultSelectorFee;
	}

	/// @dev Summed base selector fees for one op, before any core multiplier (the settlement library
	///      prices the fee with the actual payer's multiplier).
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

	/// @dev Quote an approval-only batch against the multiplier that the approval will establish before
	///      its fee is collected. Plain allowance approvals retain the current multiplier.
	function _postApprovalOperationalFee(address account, IInstantLayer.SignedOperation calldata signedOp) internal view returns (uint256 fee) {
		bytes4 selector = bytes4(signedOp.callData[:4]);
		return
			GaslessOperationalFeeLib.postApprovalOperationalFee(address(core), account, address(this), signedOp.callData, _baseSelectorFee(selector));
	}

	function _collectOneOperationalFee(address signerAccount, bytes4 selector) internal returns (address payer, uint256 fee) {
		address billingParent = _resolveBillingAccount(signerAccount);
		GaslessOperationalFeeLib.OpBilling[] memory ops = new GaslessOperationalFeeLib.OpBilling[](1);
		ops[0] = GaslessOperationalFeeLib.OpBilling({
			signer: signerAccount,
			billingParent: billingParent,
			baseFee: _useDailyFreeOp(billingParent) ? 0 : _baseSelectorFee(selector)
		});
		(uint256 totalFee, address[] memory opPayers, ) = GaslessOperationalFeeLib.settleOperationalFees(address(core), address(accountLayer), ops);
		payer = opPayers[0];
		fee = totalFee;
		emit OperationalFeeRouted(signerAccount, payer, fee);
	}

	/// @dev Price the selectors captured by dispatch and resolve billing AFTER execution: VA signers roll up to their parent
	///      SubAccount (a VA deleted inside the batch still resolves — parentAccount survives on the
	///      pooled record, and that parent holds the VA's returned funds), and an op whose parent cannot
	///      cover its fee falls back to its own signer VA (see
	///      GaslessOperationalFeeLib.settleOperationalFees). Each distinct payer is charged once after
	///      successful execution, and one OperationalFeeRouted event is emitted PER OP so off-chain
	///      accounting can reconcile every operation against the consolidated charges. The call is
	///      atomic, so any later failure rolls every charge back.
	function _collectOperationalFees(
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes4[][] memory feeSelectors
	) internal returns (uint256 totalFee) {
		uint256 n = signedOps.length;
		GaslessOperationalFeeLib.OpBilling[] memory ops = new GaslessOperationalFeeLib.OpBilling[](n);
		for (uint256 i = 0; i < n; i++) {
			address signer = signedOps[i].signerAccount.addr;
			address billingParent = _resolveBillingAccount(signer);
			// Free this op against the parent's daily quota (regardless of who ends up paying), else
			// carry its summed base selector fees into settlement.
			ops[i] = GaslessOperationalFeeLib.OpBilling({
				signer: signer,
				billingParent: billingParent,
				baseFee: _useDailyFreeOp(billingParent) ? 0 : _baseOperationalFee(feeSelectors[i])
			});
		}

		address[] memory opPayers;
		uint256[] memory opFees;
		(totalFee, opPayers, opFees) = GaslessOperationalFeeLib.settleOperationalFees(address(core), address(accountLayer), ops);

		for (uint256 i = 0; i < n; i++) {
			emit OperationalFeeRouted(ops[i].signer, opPayers[i], opFees[i]);
		}
	}

	// Single source of the daily-free-quota clamp, shared by the view path (dailyFreeOpsRemaining,
	// getAccountOperationalFee) and the charging path (_useDailyFreeOp). Keeping the day-boundary reset and
	// the limit comparison in one place is what makes the quoted free/charge decision and the on-chain
	// charge stay in lock-step; the view/charge parity is asserted in the test suite.

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
		emit DailyFreeOpsUsed(account, 1, usedToday + 1, limit);
		return true;
	}

	// ═════════════════════ Upgrade Authorization ═════════════════════

	function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
