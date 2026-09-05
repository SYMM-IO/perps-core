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
/// @notice Symmio-operated hub for gasless user operations. Two flows, one fee config:
///
///   1. Instant-layer operations (remove margin, withdrawal requests, sub-account mgmt, …):
///      relayers submit user-signed operations here; the layer forwards them to the
///      InstantLayer (as a registered executor) and charges an on-chain operational fee.
///
///   2. Cross-chain deposit + account creation: a user bridges collateral to a deterministic
///      CREATE2 address; the layer sweeps it, takes a flat fee, and either creates a
///      wallet-owned sub-account and deposits, or tops up an existing wallet-owned account.
///
/// @dev Upgradeable (UUPS). The proxy address is the CREATE2 deployer of every GaslessWallet, so
///      deposit/wallet addresses survive logic upgrades. The core and account-layer hooks are kept
///      behind narrow interfaces (see ISymmioCore.chargeOperationalFee and ISymmioAccountLayer.createSubAccountFor).
///      Linked libraries hold the largest self-contained execution paths so the implementation remains
///      deployable under EIP-170 without moving application state into libraries or changing the external API.
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

	uint256[33] private __gap;

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

	/// @notice Forward user-signed operations to the InstantLayer and settle the operational fee.
	/// @dev The layer must hold OPERATOR_ROLE on the InstantLayer (registered executor). The fee is
	///      derived ON-CHAIN from each operation's function selector (callData[:4]) via the fee
	///      schedule and summed across the batch — relayers do not submit the fee amount. The batch
	///      executes before fee collection so an account with no remaining layer allowance can approve
	///      the layer and pay for the complete batch in one atomic transaction.
	/// @dev Each op is billed to its resolved billing account: virtual accounts roll up to their parent
	///      SubAccount, and non-virtual accounts bill as-is. One call can still settle several payers
	///      (for example, user + solver) while keeping signer attribution in events.
	function relayInstantBatch(
		IInstantLayer.SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (bytes[] memory results) {
		if (signedOps.length == 0) revert EmptyOperationBatch();
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();

		// Fill array lengths are left to the InstantLayer for pure instant batches. Mixed
		// wallet+instant batches run op-by-op: wallet ops ignore fills, and instant ops read their
		// own slot via _opValuesOrEmpty so omitted wallet slots default to empty.

		if (!_hasWalletOperation(signedOps)) {
			results = instantLayer.executeBatch(signedOps, signatures, fills, flexFillerSignatures);
		} else {
			results = new bytes[](signedOps.length);
			for (uint256 i = 0; i < signedOps.length; i++) {
				if (_isWalletOperation(signedOps[i])) {
					results[i] = _executeWalletOperation(signedOps[i], signatures[i]);
				} else {
					results[i] = _executeSingleInstantOperation(
						signedOps[i],
						signatures[i],
						_opValuesOrEmpty(fills, i),
						_opValuesOrEmpty(flexFillerSignatures, i)
					);
				}
			}
		}

		uint256 totalFee = _collectOperationalFees(signedOps);

		emit InstantBatchRelayed(msg.sender, signedOps.length, totalFee);
	}

	/// @notice Forward a registered InstantLayer template (e.g. sendQuote→lockQuote→openPosition) and
	///         settle each signer's operational fee.
	/// @dev Same account-aware billing as relayInstantBatch. The InstantLayer chains results between ops
	///      (the quoteId from
	///      sendQuote flows into lock/open). templateId is opaque here; the InstantLayer validates the
	///      op-count/shape against the registered template. Fees are collected after execution, and a fee
	///      failure rolls back the complete template atomically.
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

		uint256 totalFee = _collectOperationalFees(signedOps);

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

	/// @notice Sweep a wallet's bridged collateral, create a wallet-owned sub-account, and deposit.
	/// @dev Relayer-only because it carries the user-chosen account settings supplied via the service.
	///      The caller (relayer) supplies the `affiliate` for this onboarding — it is relayed, not
	///      user-signed, and carries the same trust as the rest of the account settings.
	///      The caller provides the full SubAccountCreationData (name, metadata, isolation type, single-VA
	///      mode); the gateway only overrides `symmioCore` to its own configured core, since that is where
	///      it deposits. Other account-layer validations (name length, isolation/single-VA rules) are
	///      enforced by `createSubAccountsFor` and, being atomic, just revert the settlement if violated.
	function settleDepositToNewAccount(
		address wallet,
		address affiliate,
		SubAccountCreationData calldata accountData
	) external onlyRole(RELAYER_ROLE) nonReentrant returns (address subAccount) {
		if (wallet == address(0)) revert ZeroAddress();

		(uint256 netDeposit, uint256 collectedDepositFee) = _sweepDepositAndCollectFee(wallet);

		SubAccountCreationData[] memory accountsData = new SubAccountCreationData[](1);
		accountsData[0] = accountData;
		accountsData[0].symmioCore = address(core); // the gateway deposits to its own core — keep them consistent
		address[] memory created = accountLayer.createSubAccountsFor(wallet, affiliate, accountsData);
		subAccount = created[0];

		// Defense in depth: the created account must be owned by the wallet we are crediting.
		address actualOwner = accountLayer.ownerOf(subAccount);
		if (actualOwner != wallet) revert AccountOwnerMismatch(subAccount, wallet, actualOwner);

		_depositCollateralToCore(subAccount, netDeposit);
		emit DepositSettledToNewAccount(wallet, subAccount, netDeposit, collectedDepositFee);
	}

	/// @notice Sweep a wallet's bridged collateral and deposit into an existing wallet-owned account.
	/// @dev Relayer-only and owner-checked: funds can only land in an account owned by `wallet`.
	///      Relayer-gating (rather than permissionless) prevents a third party from misrouting the
	///      deposit into a different wallet-owned sub-account than the user intended.
	function settleDepositToExistingAccount(address wallet, address subAccount) external onlyRole(RELAYER_ROLE) nonReentrant {
		if (wallet == address(0) || subAccount == address(0)) revert ZeroAddress();

		address owner = accountLayer.ownerOf(subAccount);
		if (owner != wallet) revert AccountOwnerMismatch(subAccount, wallet, owner);

		(uint256 netDeposit, uint256 collectedDepositFee) = _sweepDepositAndCollectFee(wallet);
		_depositCollateralToCore(subAccount, netDeposit);
		emit DepositSettledToExistingAccount(wallet, subAccount, netDeposit, collectedDepositFee);
	}

	// ═══════════════════════ Wallet Views ════════════════════════

	/// @notice The deterministic address of `ownerWallet`'s GaslessWallet. Pure view — the frontend
	///         reads this with no transaction and no gas. It doubles as the bridged-deposit address:
	///         collateral is routed here, then swept by the gateway on settlement.
	function getGaslessWalletAddress(address ownerWallet) public view returns (address) {
		return GaslessWalletDeployerLib.getGaslessWalletAddress(ownerWallet);
	}

	function getWalletOperationHash(IInstantLayer.SignedOperation calldata signedOp) public view returns (bytes32) {
		return GaslessWalletExecutionLib.getWalletOperationHash(signedOp);
	}

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

	/// @notice What would be charged right now for `account`'s ops in `signedOps`, after quota. Virtual
	///         accounts are quoted through their parent SubAccount; when the parent cannot cover an op,
	///         the quote prices it against its signer-VA fallback payer (see settleOperationalFees).
	/// @dev Approval-only batches are always priced with the parent's post-approval multiplier, since the
	///      approval is expected to fund the parent's charge. If execution nevertheless falls back to the
	///      signer VA (empty parent), the charge uses the VA's own multiplier and can differ from this quote.
	/// @return amountDue Total that would be charged across the billing account and any fallback VA payers
	///         (0 if fully free-covered, or if it would revert).
	/// @return freeOpsApplied How many billing-account ops are waived by its remaining daily quota.
	/// @return wouldBlockOnQuota True if the call would revert with DailyFreeOpsLimitExceeded (block mode).
	function getAccountOperationalFee(
		address account,
		IInstantLayer.SignedOperation[] calldata signedOps
	) external view returns (uint256 amountDue, uint256 freeOpsApplied, bool wouldBlockOnQuota) {
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
				baseFee: _baseOperationalFee(signedOps[i])
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

	/// @notice Admin recovery for tokens that are not the gateway's collateral.
	/// @dev The gateway's collateral is permanently non-recoverable. Only non-collateral tokens
	///      accidentally sent to a deposit address can be swept to `to`.
	function recoverNonCollateralToken(
		address wallet,
		address token,
		address recipient
	) external onlyRole(CONFIG_ADMIN_ROLE) returns (uint256 amount) {
		if (token == collateralToken) revert CollateralRecoveryDisabled();
		if (recipient == address(0)) revert ZeroAddress();
		GaslessWallet qWallet = _getOrDeployGaslessWallet(wallet);
		amount = qWallet.sweepTokenBalance(token, recipient);
		emit NonCollateralTokenRecovered(wallet, token, recipient, amount);
	}

	// ═══════════════════════ Internal: Deposits ═══════════════════════

	function _sweepDepositAndCollectFee(address wallet) internal returns (uint256 netDeposit, uint256 collectedDepositFee) {
		GaslessWallet qWallet = _getOrDeployGaslessWallet(wallet);
		uint256 grossDeposit = qWallet.sweepTokenBalance(collateralToken, address(this));
		if (grossDeposit < minimumDeposit) revert DepositAmountBelowMinimum(grossDeposit, minimumDeposit);
		collectedDepositFee = depositFee;
		if (collectedDepositFee > 0) {
			IERC20(collateralToken).safeTransfer(treasury, collectedDepositFee);
			emit DepositFeeCollected(wallet, treasury, collectedDepositFee);
		}
		netDeposit = grossDeposit - collectedDepositFee;
	}

	function _depositCollateralToCore(address account, uint256 amount) internal {
		IERC20(collateralToken).forceApprove(address(core), amount);
		core.depositFor(account, amount);
	}

	function _getOrDeployGaslessWallet(address ownerWallet) internal returns (GaslessWallet wallet) {
		bool deployed;
		(wallet, deployed) = GaslessWalletDeployerLib.getOrDeployGaslessWallet(ownerWallet);
		if (deployed) emit GaslessWalletDeployed(ownerWallet, address(wallet));
	}

	// ═════════════════════ Internal: Account Resolution ═════════════════════

	/// @dev VA → parent SubAccount; SubAccount / PartyB / EOA / unknown → as-is.
	function _resolveBillingAccount(address account) internal view returns (address) {
		return GaslessBillingIdentity.resolveBillingAccount(accountLayer, account);
	}

	// ═════════════════════ Internal: Wallet Dispatch ═════════════════════

	function _isWalletOperation(IInstantLayer.SignedOperation calldata signedOp) internal view returns (bool) {
		return GaslessWalletExecutionLib.isWalletOperation(address(accountLayer), signedOp);
	}

	function _hasWalletOperation(IInstantLayer.SignedOperation[] calldata signedOps) internal view returns (bool) {
		for (uint256 i = 0; i < signedOps.length; i++) {
			if (_isWalletOperation(signedOps[i])) return true;
		}
		return false;
	}

	/// @dev Recognizes the only post-state mutation that the read-only fee quote can price exactly.
	///      Flex fields are excluded because they could mutate the selector after this classification.
	function _isOperationalFeeApproval(IInstantLayer.SignedOperation calldata signedOp) internal view returns (bool) {
		if (signedOp.target != address(core) || signedOp.callData.length < 4 || signedOp.flexFields.length != 0) return false;
		bytes4 selector = bytes4(signedOp.callData[:4]);
		return selector == ISymmioCore.approveOperationalFee.selector || selector == ISymmioCore.approveOperationalFeeWithMultiplier.selector;
	}

	function _executeWalletOperation(
		IInstantLayer.SignedOperation calldata signedOp,
		bytes calldata signature
	) internal returns (bytes memory result) {
		GaslessWalletExecutionLib.WalletExecutionResult memory execution = GaslessWalletExecutionLib.executeWalletOperation(
			walletOperationNonces,
			address(accountLayer),
			address(instantLayer),
			signedOp,
			signature
		);
		emit WalletOperationRelayed(msg.sender, execution.ownerWallet, execution.wallet, execution.callCount);
		return execution.result;
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
	function _baseOperationalFee(IInstantLayer.SignedOperation calldata signedOp) internal view returns (uint256 fee) {
		bytes4[] memory selectors = GaslessWalletExecutionLib.operationalFeeSelectors(address(accountLayer), signedOp);
		for (uint256 i = 0; i < selectors.length; i++) {
			fee += _baseSelectorFee(selectors[i]);
		}
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

	/// @dev Bill the batch per op, resolved entirely AFTER execution: VA signers roll up to their parent
	///      SubAccount (a VA deleted inside the batch still resolves — parentAccount survives on the
	///      pooled record, and that parent holds the VA's returned funds), and an op whose parent cannot
	///      cover its fee falls back to its own signer VA (see
	///      GaslessOperationalFeeLib.settleOperationalFees). Each distinct payer is charged once after
	///      successful execution, and one OperationalFeeRouted event is emitted PER OP so off-chain
	///      accounting can reconcile every operation against the consolidated charges. The call is
	///      atomic, so any later failure rolls every charge back.
	function _collectOperationalFees(IInstantLayer.SignedOperation[] calldata signedOps) internal returns (uint256 totalFee) {
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
				baseFee: _useDailyFreeOp(billingParent) ? 0 : _baseOperationalFee(signedOps[i])
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
