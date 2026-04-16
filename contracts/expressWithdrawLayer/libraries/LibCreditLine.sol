// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IMuonSignatureVerifier } from "../../core/interfaces/IMuonSignatureVerifier.sol";

import { AffiliateCredit, CreditData } from "../types/CreditTypes.sol";
import { WithdrawInfo } from "../types/WithdrawTypes.sol";

import { ISymmio } from "../interfaces/ISymmio.sol";

import { CreditLineStorage } from "../storages/CreditLineStorage.sol";
import { GlobalStorage } from "../storages/GlobalStorage.sol";
import { PoolStorage } from "../storages/PoolStorage.sol";

/// @title LibCreditLine
/// @notice Shared credit line helpers used by SymmioHookFacet and OperatorFacet.
///         All debt operations work directly on diamond storage — no external contract calls.
library LibCreditLine {
	// ═══════════════════════════════════════════════════════════════════
	//                              ERRORS
	// ═══════════════════════════════════════════════════════════════════

	error CreditLinePaused();
	error UserBlacklisted();
	error MuonSignatureExpired();
	error DebtExceedsAbsoluteCap();
	error DebtExceedsPercentCap();
	error NoDebtForRequest();
	error DebtAlreadyActivated();
	error DebtAlreadyReserved();
	error DebtNotActivated();
	error AffiliateLimitExceedsProtocol();
	error CreditLineNotConfigured();

	// ═══════════════════════════════════════════════════════════════════
	//                              EVENTS
	// ═══════════════════════════════════════════════════════════════════

	event DebtReserved(address indexed affiliate, address indexed user, uint256 indexed requestId, uint256 amount);
	event DebtActivated(address indexed affiliate, address indexed user, uint256 indexed requestId, uint256 amount);
	event DebtSettled(address indexed affiliate, address indexed user, uint256 indexed requestId, uint256 amount);
	event DebtCancelled(address indexed affiliate, address indexed user, uint256 indexed requestId, uint256 amount);
	event BadDebtAccrued(address indexed affiliate, address indexed user, uint256 indexed requestId, uint256 amount);

	// ═══════════════════════════════════════════════════════════════════
	//                         DEBT OPERATIONS
	// ═══════════════════════════════════════════════════════════════════

	/// @dev Reserves credit for a pending withdrawal. Validates Muon data and caps.
	function reserveDebt(address affiliate, address user, uint256 requestId, uint256 creditAmount, CreditData memory data) internal {
		CreditLineStorage.Layout storage cl = CreditLineStorage.layout();
		AffiliateCredit storage ac = cl.affiliates[affiliate];

		if (cl.signatureVerifier == address(0)) revert CreditLineNotConfigured();
		if (ac.paused) revert CreditLinePaused();
		if (ac.blacklisted[user]) revert UserBlacklisted();

		// Verify Muon signature freshness
		if (block.timestamp > data.timestamp + cl.muonFreshnessWindow) revert MuonSignatureExpired();

		// Verify Muon signature via the shared verifier.
		// NOTE: Includes express provider (address(this)) and symmio addresses to prevent cross-deployment replay.
		//       The Muon oracle app must sign over both contract addresses.
		address symmio = GlobalStorage.layout().symmio;
		bytes32 hash = keccak256(
			abi.encodePacked(cl.muonAppId, data.reqId, affiliate, data.eligibleBase, data.timestamp, block.chainid, address(this), symmio)
		);
		IMuonSignatureVerifier(cl.signatureVerifier).verify(hash, data.sigs, data.gatewaySignature);

		// Check caps
		uint256 newTotalDebt = ac.reservedDebt + ac.activeDebt + creditAmount;

		uint256 effectiveMaxDebt = _effectiveMax(ac.protocolMaxDebt, ac.affiliateMaxDebt);
		if (effectiveMaxDebt > 0 && newTotalDebt > effectiveMaxDebt) revert DebtExceedsAbsoluteCap();

		uint256 effectiveMaxBps = _effectiveMax(ac.protocolMaxDebtBps, ac.affiliateMaxDebtBps);
		if (effectiveMaxBps > 0 && newTotalDebt > (data.eligibleBase * effectiveMaxBps) / 10000) revert DebtExceedsPercentCap();

		// Record debt
		bytes32 key = _key(user, requestId);
		if (ac.requestDebt[key] != 0) revert DebtAlreadyReserved();
		ac.requestDebt[key] = creditAmount;
		ac.reservedDebt += creditAmount;

		emit DebtReserved(affiliate, user, requestId, creditAmount);
	}

	/// @dev Activates reserved credit and advances collateral from core.
	///      No-op if creditAmount == 0.
	function activate(address symmio, address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.creditAmount == 0) return;
		_activateDebt(info.affiliate, user, requestId);
		ISymmio(symmio).advanceWithdraw(user, requestId, info.creditAmount);
	}

	/// @dev Settles active credit debt after finalization. No-op if creditAmount == 0.
	function settle(address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.creditAmount == 0) return;
		_settleDebt(info.affiliate, user, requestId);
	}

	/// @dev Releases reserved credit on cancel/suspend before payout. No-op if creditAmount == 0.
	function releaseReservation(address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.creditAmount == 0) return;
		_cancelReservation(info.affiliate, user, requestId);
	}

	/// @dev Covers credit loss on post-payout rollback (suspend/force-cancel after PROCESSED).
	///      Deducts from the affiliate pool up to available balance; any shortfall is accrued as bad debt.
	function coverLoss(IERC20, address, address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.creditAmount == 0) return;

		PoolStorage.Layout storage p = PoolStorage.layout();
		uint256 available = p.affiliateBalances[info.affiliate];
		uint256 coverable = available < info.creditAmount ? available : info.creditAmount;
		uint256 deficit = info.creditAmount - coverable;

		if (coverable > 0) {
			p.affiliateBalances[info.affiliate] -= coverable;
		}
		if (deficit > 0) {
			CreditLineStorage.layout().affiliates[info.affiliate].badDebt += deficit;
			emit BadDebtAccrued(info.affiliate, user, requestId, deficit);
		}

		_settleDebt(info.affiliate, user, requestId);
	}

	// ═══════════════════════════════════════════════════════════════════
	//                           INTERNAL
	// ═══════════════════════════════════════════════════════════════════

	function _activateDebt(address affiliate, address user, uint256 requestId) private {
		AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		bytes32 key = _key(user, requestId);
		uint256 amount = ac.requestDebt[key];
		if (amount == 0) revert NoDebtForRequest();
		if (ac.requestActivated[key]) revert DebtAlreadyActivated();

		ac.requestActivated[key] = true;
		ac.reservedDebt -= amount;
		ac.activeDebt += amount;

		emit DebtActivated(affiliate, user, requestId, amount);
	}

	function _settleDebt(address affiliate, address user, uint256 requestId) private {
		AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		bytes32 key = _key(user, requestId);
		uint256 amount = ac.requestDebt[key];
		if (amount == 0) revert NoDebtForRequest();

		if (ac.requestActivated[key]) {
			ac.activeDebt -= amount;
		} else {
			ac.reservedDebt -= amount;
		}

		delete ac.requestDebt[key];
		delete ac.requestActivated[key];

		emit DebtSettled(affiliate, user, requestId, amount);
	}

	function _cancelReservation(address affiliate, address user, uint256 requestId) private {
		AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		bytes32 key = _key(user, requestId);
		uint256 amount = ac.requestDebt[key];
		if (amount == 0) revert NoDebtForRequest();
		if (ac.requestActivated[key]) revert DebtAlreadyActivated();

		ac.reservedDebt -= amount;
		delete ac.requestDebt[key];

		emit DebtCancelled(affiliate, user, requestId, amount);
	}

	function _key(address user, uint256 requestId) private pure returns (bytes32) {
		return keccak256(abi.encodePacked(user, requestId));
	}

	/// @dev Returns the effective (tighter) of two limits. 0 means "no limit".
	function _effectiveMax(uint256 protocolVal, uint256 affiliateVal) private pure returns (uint256) {
		if (protocolVal == 0) return affiliateVal;
		if (affiliateVal == 0) return protocolVal;
		return protocolVal < affiliateVal ? protocolVal : affiliateVal;
	}
}
