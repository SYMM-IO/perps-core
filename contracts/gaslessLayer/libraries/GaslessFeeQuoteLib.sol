// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";
import { IGaslessLayerActions } from "../interfaces/IGaslessLayerActions.sol";
import { IInstantLayer } from "../interfaces/IInstantLayer.sol";
import { ISymmioCore } from "../interfaces/ISymmioCore.sol";
import { ISymmioAccountLayer, SubAccountCreationData } from "../interfaces/ISymmioAccountLayer.sol";
import { GaslessBillingIdentity } from "./GaslessBillingIdentity.sol";
import { GaslessOperationalFeeLib } from "./GaslessOperationalFeeLib.sol";
import { GaslessWalletExecutionLib } from "./GaslessWalletExecutionLib.sol";
import { GaslessFeeAccounting } from "./GaslessFeeAccounting.sol";

interface IGaslessFeeConfig {
	function core() external view returns (address);
	function accountLayer() external view returns (address);
	function collateralToken() external view returns (address);
	function depositFee() external view returns (uint256);
	function getGaslessWalletAddress(address owner, uint256 walletId) external view returns (address);
	function getWalletCreationFee(address owner, uint256 walletId) external view returns (uint256);
	function walletCreationFee() external view returns (uint256);
	function getBaseOperationalFee(bytes4 selector) external view returns (uint256);
	function dailyFreeOpsLimit() external view returns (uint256);
	function dailyFreeOpsRemaining(address account) external view returns (uint256);
	function revertWhenFreeQuotaExhausted() external view returns (bool);
	function dailySponsoredNativeLimit() external view returns (uint256);
	function dailyNativeSponsorUsage(address payer) external view returns (uint64 day, uint192 amount);
	function revertWhenNativeSponsorLimitExhausted() external view returns (bool);
	function maxNativeGasTopUpAmount() external view returns (uint256);
	function nativeGasTopUpFeeBps() external view returns (uint256);
}

/// @notice Shared frontend quote dispatch and atomic simulation using the actual fee collection paths.
library GaslessFeeQuoteLib {
	/// @notice Preserve the original account-specific quote, including its approval-only special case and quota flag.
	function accountOperationalFee(
		address account,
		IInstantLayer.SignedOperation[] calldata signedOps,
		uint256[] calldata walletIds
	) external view returns (uint256 amountDue, uint256 freeOpsApplied, bool wouldBlockOnQuota) {
		if (walletIds.length != signedOps.length) revert IGaslessLayer.ArrayLengthMismatch();
		IGaslessFeeConfig config = IGaslessFeeConfig(address(this));
		ISymmioAccountLayer accounts = ISymmioAccountLayer(config.accountLayer());
		address billingAccount = GaslessBillingIdentity.resolveBillingAccount(accounts, account);
		uint256 limit = config.dailyFreeOpsLimit();
		uint256 freeRemaining = limit > 0 ? config.dailyFreeOpsRemaining(billingAccount) : 0;
		GaslessOperationalFeeLib.OpBilling[] memory ops = new GaslessOperationalFeeLib.OpBilling[](signedOps.length);
		uint256[] memory creations = new uint256[](signedOps.length);
		uint256 count;
		bool blocked;
		for (uint256 i; i < signedOps.length; i++) {
			// Decode and validate every target before handling quota, including other accounts' operations.
			bytes4[] memory selectors = GaslessWalletExecutionLib.quoteOperationalFeeSelectors(address(accounts), signedOps[i], walletIds[i]);
			if (
				config.walletCreationFee() > 0 &&
				signedOps[i].target.code.length == 0 &&
				GaslessWalletExecutionLib.isWalletOperation(address(accounts), signedOps[i], walletIds[i])
			) {
				creations[i] = config.walletCreationFee();
				for (uint256 j; j < i; j++) {
					if (creations[j] > 0 && signedOps[j].target == signedOps[i].target) {
						creations[i] = 0;
						break;
					}
				}
			}
			if (GaslessBillingIdentity.resolveBillingAccount(accounts, signedOps[i].signerAccount.addr) != billingAccount) continue;
			bool free = freeRemaining > 0;
			if (free) {
				freeRemaining--;
				freeOpsApplied++;
			}
			if (!free && limit > 0 && config.revertWhenFreeQuotaExhausted()) blocked = true;
			uint256 base;
			if (!free) for (uint256 j; j < selectors.length; j++) base += config.getBaseOperationalFee(selectors[j]);
			bytes4 selector = signedOps[i].callData.length < 4 ? bytes4(0) : bytes4(signedOps[i].callData[:4]);
			if (
				signedOps.length == 1 &&
				signedOps[i].target == config.core() &&
				signedOps[i].flexFields.length == 0 &&
				(selector == ISymmioCore.approveOperationalFee.selector || selector == ISymmioCore.approveOperationalFeeWithMultiplier.selector)
			) {
				amountDue = GaslessOperationalFeeLib.postApprovalOperationalFee(
					config.core(),
					billingAccount,
					address(this),
					signedOps[i].callData,
					base
				);
				continue;
			}
			uint256 creation = creations[i] == 0 ? 0 : creations[i] * 10 ** (18 - IERC20Metadata(config.collateralToken()).decimals());
			ops[count++] = GaslessOperationalFeeLib.OpBilling(signedOps[i].signerAccount.addr, billingAccount, base, creation);
		}
		if (blocked) return (0, freeOpsApplied, true);
		assembly ("memory-safe") {
			mstore(ops, count)
		}
		(, uint256[] memory fees) = GaslessOperationalFeeLib.planOperationalFees(config.core(), address(accounts), ops);
		for (uint256 i; i < fees.length; i++) amountDue += fees[i];
	}

	function recordWalletPayment(address token, address wallet, uint256 deposit, uint256 creation) external {
		if (!GaslessFeeAccounting.state().active) return;
		uint256 scale = 10 ** (18 - IERC20Metadata(token).decimals());
		GaslessFeeAccounting.record(
			IGaslessLayer.FeePayment(wallet, wallet, uint8(IGaslessLayer.FeeSource.WALLET_COLLATERAL), 0, deposit * scale, creation * scale, 0, 0)
		);
	}

	function preview(bytes calldata callData, uint256 nativeAmount) external view returns (IGaslessLayer.FeeQuote memory quote) {
		bytes4 selector = _checkSelector(callData);
		IGaslessFeeConfig config = IGaslessFeeConfig(address(this));
		quote = _newQuote(config);
		if (selector != IGaslessLayerActions.relayNativeGasTopUp.selector && nativeAmount != 0)
			revert IGaslessLayer.UnexpectedNativeValue(nativeAmount);
		if (selector == IGaslessLayerActions.relayInstantBatch.selector) {
			(IInstantLayer.SignedOperation[] memory ops, , , , uint256[] memory walletIds) = abi.decode(
				callData[4:],
				(IInstantLayer.SignedOperation[], bytes[], bytes[][], bytes[][], uint256[])
			);
			_operations(config, quote, ops, walletIds, false);
		} else if (selector == IGaslessLayerActions.relayInstantTemplate.selector) {
			(, IInstantLayer.SignedOperation[] memory ops, , , ) = abi.decode(
				callData[4:],
				(uint256, IInstantLayer.SignedOperation[], bytes[], bytes[][], bytes[][])
			);
			_operations(config, quote, ops, new uint256[](ops.length), true);
		} else if (selector == IGaslessLayerActions.relayGrantBatchDelegationBySig.selector) {
			(IInstantLayer.SignedDelegation memory delegation, ) = abi.decode(callData[4:], (IInstantLayer.SignedDelegation, bytes));
			IInstantLayer.SignedOperation[] memory ops = new IInstantLayer.SignedOperation[](1);
			ops[0].signerAccount = delegation.delegationInfo.account;
			ops[0].callData = abi.encodePacked(IInstantLayer.grantBatchDelegationBySig.selector);
			_operations(config, quote, ops, new uint256[](1), true);
		} else if (selector == IGaslessLayerActions.relayNativeGasTopUp.selector) {
			(IGaslessLayer.NativeGasTopUpRequest memory request, ) = abi.decode(callData[4:], (IGaslessLayer.NativeGasTopUpRequest, bytes));
			_native(config, quote, request, nativeAmount);
		} else {
			_wallet(config, quote, callData, selector);
		}
		_total(quote);
	}

	/// @dev Runs the original action with the original caller/value/roles. Simulation always reverts, even on success.
	///      Wrap failures so an inner call cannot impersonate the outer successful quote result.
	function execute(bytes calldata callData, bool simulation, uint256 maxTotalDebit) external returns (bytes memory result) {
		bytes4 selector = _checkSelector(callData);
		if (selector != IGaslessLayerActions.relayNativeGasTopUp.selector && msg.value != 0) revert IGaslessLayer.UnexpectedNativeValue(msg.value);
		GaslessFeeAccounting.State storage s = GaslessFeeAccounting.state();
		if (s.active) revert IGaslessLayer.FeeQuoteContextActive();
		IGaslessLayer.FeeQuote memory quote = _newQuote(IGaslessFeeConfig(address(this)));
		s.active = true;
		bool success;
		(success, result) = address(this).delegatecall(callData);
		if (!success) {
			if (simulation) revert IGaslessLayer.FeeQuoteExecutionFailed(result);
			assembly ("memory-safe") {
				revert(add(result, 32), mload(result))
			}
		}
		quote.exact = true;
		quote.payments = s.payments;
		quote.freeOpsApplied = s.freeOps;
		quote.nativeSponsored = s.nativeSponsored;
		_total(quote);
		if (simulation) revert IGaslessLayer.FeeQuoteResult(quote);
		if (quote.totalDebit > maxTotalDebit) revert IGaslessLayer.FeeLimitExceeded(quote.totalDebit, maxTotalDebit);
		GaslessFeeAccounting.clear();
	}

	function _newQuote(IGaslessFeeConfig config) private view returns (IGaslessLayer.FeeQuote memory q) {
		q.collateralToken = config.collateralToken();
		q.collateralDecimals = IERC20Metadata(q.collateralToken).decimals();
		q.blockNumber = block.number;
		q.timestamp = block.timestamp;
	}

	function _total(IGaslessLayer.FeeQuote memory q) private pure {
		for (uint256 i; i < q.payments.length; i++) {
			IGaslessLayer.FeePayment memory p = q.payments[i];
			q.totalFee += p.operationalFee + p.depositFee + p.walletCreationFee + p.nativeTopUpFee;
			q.totalDebit += p.nativeGasCollateral;
		}
		q.totalDebit += q.totalFee;
	}

	function _operations(
		IGaslessFeeConfig config,
		IGaslessLayer.FeeQuote memory q,
		IInstantLayer.SignedOperation[] memory signedOps,
		uint256[] memory walletIds,
		bool template
	) private view {
		uint256 n = signedOps.length;
		if (n == 0) revert IGaslessLayer.EmptyOperationBatch();
		if (walletIds.length != n) revert IGaslessLayer.ArrayLengthMismatch();
		ISymmioAccountLayer accounts = ISymmioAccountLayer(config.accountLayer());
		GaslessOperationalFeeLib.OpBilling[] memory ops = new GaslessOperationalFeeLib.OpBilling[](n);
		uint256 limit = config.dailyFreeOpsLimit();
		for (uint256 i; i < n; i++) {
			ops[i].signer = signedOps[i].signerAccount.addr;
			ops[i].billingParent = GaslessBillingIdentity.resolveBillingAccount(accounts, ops[i].signer);
			bytes4[] memory selectors;
			if (template) {
				selectors = new bytes4[](1);
				selectors[0] = signedOps[i].callData.length < 4 ? bytes4(0) : bytes4(signedOps[i].callData);
			} else {
				selectors = GaslessWalletExecutionLib.quoteOperationalFeeSelectors(address(accounts), signedOps[i], walletIds[i]);
				if (
					signedOps[i].target.code.length == 0 && GaslessWalletExecutionLib.isWalletOperation(address(accounts), signedOps[i], walletIds[i])
				) {
					ops[i].creationFee = config.walletCreationFee() * 10 ** (18 - q.collateralDecimals);
					for (uint256 j; j < i; j++) {
						if (signedOps[j].target == signedOps[i].target && ops[j].creationFee > 0) {
							ops[i].creationFee = 0;
							break;
						}
					}
				}
			}
			bool free;
			if (limit > 0) {
				uint256 preceding;
				for (uint256 j; j < i; j++) if (ops[j].billingParent == ops[i].billingParent) preceding++;
				free = preceding < config.dailyFreeOpsRemaining(ops[i].billingParent);
				if (!free && config.revertWhenFreeQuotaExhausted()) revert IGaslessLayer.DailyFreeOpsLimitExceeded(ops[i].billingParent, limit);
			}
			if (free) q.freeOpsApplied++;
			else for (uint256 j; j < selectors.length; j++) ops[i].baseFee += config.getBaseOperationalFee(selectors[j]);
		}
		(address[] memory payers, uint256[] memory fees) = GaslessOperationalFeeLib.planOperationalFees(config.core(), address(accounts), ops);
		q.payments = new IGaslessLayer.FeePayment[](n);
		for (uint256 i; i < n; i++) {
			q.payments[i] = IGaslessLayer.FeePayment(
				ops[i].signer,
				payers[i],
				uint8(IGaslessLayer.FeeSource.SYMMIO_ACCOUNT),
				fees[i] - ops[i].creationFee,
				0,
				ops[i].creationFee,
				0,
				0
			);
		}
	}

	function _native(
		IGaslessFeeConfig config,
		IGaslessLayer.FeeQuote memory q,
		IGaslessLayer.NativeGasTopUpRequest memory request,
		uint256 nativeAmount
	) private view {
		if (request.recipientWallet == address(0)) revert IGaslessLayer.ZeroAddress();
		if (request.collateralAmount == 0) revert IGaslessLayer.NativeGasTopUpCollateralAmountZero();
		if (nativeAmount == 0) revert IGaslessLayer.NativeGasTopUpAmountZero();
		if (nativeAmount < request.minNativeAmountOut) revert IGaslessLayer.NativeGasTopUpAmountBelowMin(nativeAmount, request.minNativeAmountOut);
		if (nativeAmount > config.maxNativeGasTopUpAmount())
			revert IGaslessLayer.NativeGasTopUpAmountExceedsMax(nativeAmount, config.maxNativeGasTopUpAmount());
		address payer = GaslessBillingIdentity.resolveBillingAccount(ISymmioAccountLayer(config.accountLayer()), request.payerAccount);
		(uint64 day, uint192 used) = config.dailyNativeSponsorUsage(payer);
		uint256 next = (day == block.timestamp / 1 days ? used : 0) + nativeAmount;
		q.nativeSponsored = next <= config.dailySponsoredNativeLimit() && next <= type(uint192).max;
		if (!q.nativeSponsored && config.revertWhenNativeSponsorLimitExhausted())
			revert IGaslessLayer.DailySponsoredNativeLimitExceeded(payer, config.dailySponsoredNativeLimit());
		q.payments = new IGaslessLayer.FeePayment[](1);
		q.payments[0] = IGaslessLayer.FeePayment(
			request.payerAccount,
			payer,
			uint8(IGaslessLayer.FeeSource.SYMMIO_ACCOUNT),
			0,
			0,
			0,
			q.nativeSponsored ? 0 : (request.collateralAmount * config.nativeGasTopUpFeeBps()) / 10000,
			q.nativeSponsored ? 0 : request.collateralAmount
		);
	}

	function _wallet(IGaslessFeeConfig config, IGaslessLayer.FeeQuote memory q, bytes calldata data, bytes4 selector) private view {
		address owner;
		uint256 walletId;
		bool recovery = selector == IGaslessLayerActions.recoverNonCollateralToken.selector;
		bool withdrawal = selector == IGaslessLayerActions.withdrawWalletFunds.selector;
		if (withdrawal) {
			address recipient;
			uint256 amount;
			(walletId, , recipient, amount) = abi.decode(data[4:], (uint256, address, address, uint256));
			if (recipient == address(0)) revert IGaslessLayer.ZeroAddress();
			if (amount == 0) revert IGaslessLayer.WalletWithdrawalAmountZero();
			owner = msg.sender;
		} else if (recovery) {
			address token;
			address recipient;
			(owner, walletId, token, recipient) = abi.decode(data[4:], (address, uint256, address, address));
			if (token == q.collateralToken) revert IGaslessLayer.CollateralRecoveryDisabled();
			if (recipient == address(0)) revert IGaslessLayer.ZeroAddress();
		} else if (selector == IGaslessLayerActions.settleDepositToExistingAccount.selector) {
			address account;
			(owner, walletId, account) = abi.decode(data[4:], (address, uint256, address));
			if (account == address(0)) revert IGaslessLayer.ZeroAddress();
			address actualOwner = ISymmioAccountLayer(config.accountLayer()).ownerOf(account);
			if (actualOwner != owner) revert IGaslessLayer.AccountOwnerMismatch(account, owner, actualOwner);
		} else {
			(owner, walletId, , ) = abi.decode(data[4:], (address, uint256, address, SubAccountCreationData));
		}
		if (!recovery && owner == address(0)) revert IGaslessLayer.ZeroAddress();
		address wallet = config.getGaslessWalletAddress(owner, walletId);
		uint256 creation = config.getWalletCreationFee(owner, walletId);
		uint256 deposit = recovery || withdrawal ? 0 : config.depositFee();
		q.payments = new IGaslessLayer.FeePayment[](1);
		uint256 scale = 10 ** (18 - q.collateralDecimals);
		q.payments[0] = IGaslessLayer.FeePayment(
			wallet,
			wallet,
			uint8(IGaslessLayer.FeeSource.WALLET_COLLATERAL),
			0,
			deposit * scale,
			creation * scale,
			0,
			0
		);
	}

	function _checkSelector(bytes calldata callData) private pure returns (bytes4 selector) {
		selector = callData.length < 4 ? bytes4(0) : bytes4(callData[:4]);
		if (
			selector != IGaslessLayerActions.relayInstantBatch.selector &&
			selector != IGaslessLayerActions.relayInstantTemplate.selector &&
			selector != IGaslessLayerActions.relayGrantBatchDelegationBySig.selector &&
			selector != IGaslessLayerActions.relayNativeGasTopUp.selector &&
			selector != IGaslessLayerActions.settleDepositToNewAccount.selector &&
			selector != IGaslessLayerActions.settleDepositToExistingAccount.selector &&
			selector != IGaslessLayerActions.recoverNonCollateralToken.selector &&
			selector != IGaslessLayerActions.withdrawWalletFunds.selector
		) revert IGaslessLayer.UnsupportedFeeQuoteCall(selector);
	}
}
