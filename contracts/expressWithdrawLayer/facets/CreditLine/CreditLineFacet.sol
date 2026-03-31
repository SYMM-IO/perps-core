// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ICreditLineFacet } from "./ICreditLineFacet.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";
import { LibCreditLine } from "../../libraries/LibCreditLine.sol";

import { CreditLineStorage } from "../../storages/CreditLineStorage.sol";

/// @title CreditLineFacet
/// @notice Admin and view functions for the per-affiliate credit line system.
contract CreditLineFacet is ICreditLineFacet {
	// ═══════════════════════════════════════════════════════════════════
	//                     PROTOCOL ADMIN SETTERS
	// ═══════════════════════════════════════════════════════════════════

	function setCreditLineMuonConfig(address signatureVerifier, uint256 muonAppId, uint256 muonFreshnessWindow) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.Layout storage cl = CreditLineStorage.layout();
		cl.signatureVerifier = signatureVerifier;
		cl.muonAppId = muonAppId;
		cl.muonFreshnessWindow = muonFreshnessWindow;
		emit CreditLineMuonConfigUpdated(signatureVerifier, muonAppId, muonFreshnessWindow);
	}

	function setCreditLineProtocolConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		ac.protocolMaxDebt = maxDebt;
		ac.protocolMaxDebtBps = maxDebtBps;
		emit CreditLineProtocolConfigUpdated(affiliate, maxDebt, maxDebtBps);
	}

	// ═══════════════════════════════════════════════════════════════════
	//                    AFFILIATE ADMIN SETTERS
	// ═══════════════════════════════════════════════════════════════════

	function setCreditLineAffiliateConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];

		// Affiliate limits must be stricter (or equal) to protocol limits
		if (ac.protocolMaxDebt > 0 && maxDebt > ac.protocolMaxDebt) revert LibCreditLine.AffiliateLimitExceedsProtocol();
		if (ac.protocolMaxDebtBps > 0 && maxDebtBps > ac.protocolMaxDebtBps) revert LibCreditLine.AffiliateLimitExceedsProtocol();

		ac.affiliateMaxDebt = maxDebt;
		ac.affiliateMaxDebtBps = maxDebtBps;
		emit CreditLineAffiliateConfigUpdated(affiliate, maxDebt, maxDebtBps);
	}

	function setCreditLinePaused(address affiliate, bool paused) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.layout().affiliates[affiliate].paused = paused;
		emit CreditLinePausedUpdated(affiliate, paused);
	}

	function setCreditLineBlacklisted(address affiliate, address user, bool blacklisted) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.layout().affiliates[affiliate].blacklisted[user] = blacklisted;
		emit CreditLineUserBlacklistUpdated(affiliate, user, blacklisted);
	}

	// ═══════════════════════════════════════════════════════════════════
	//                              VIEWS
	// ═══════════════════════════════════════════════════════════════════

	function creditLineSignatureVerifier() external view returns (address) {
		return CreditLineStorage.layout().signatureVerifier;
	}

	function creditLineMuonAppId() external view returns (uint256) {
		return CreditLineStorage.layout().muonAppId;
	}

	function creditLineMuonFreshnessWindow() external view returns (uint256) {
		return CreditLineStorage.layout().muonFreshnessWindow;
	}

	function creditLineProtocolMaxDebt(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].protocolMaxDebt;
	}

	function creditLineProtocolMaxDebtBps(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].protocolMaxDebtBps;
	}

	function creditLineAffiliateMaxDebt(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].affiliateMaxDebt;
	}

	function creditLineAffiliateMaxDebtBps(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].affiliateMaxDebtBps;
	}

	function creditLineReservedDebt(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].reservedDebt;
	}

	function creditLineActiveDebt(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].activeDebt;
	}

	function creditLineTotalDebt(address affiliate) external view returns (uint256) {
		CreditLineStorage.AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		return ac.reservedDebt + ac.activeDebt;
	}

	function creditLineRequestDebt(address affiliate, address user, uint256 requestId) external view returns (uint256) {
		bytes32 key = keccak256(abi.encodePacked(user, requestId));
		return CreditLineStorage.layout().affiliates[affiliate].requestDebt[key];
	}

	function creditLineRequestActivated(address affiliate, address user, uint256 requestId) external view returns (bool) {
		bytes32 key = keccak256(abi.encodePacked(user, requestId));
		return CreditLineStorage.layout().affiliates[affiliate].requestActivated[key];
	}

	function creditLinePaused(address affiliate) external view returns (bool) {
		return CreditLineStorage.layout().affiliates[affiliate].paused;
	}

	function creditLineBlacklisted(address affiliate, address user) external view returns (bool) {
		return CreditLineStorage.layout().affiliates[affiliate].blacklisted[user];
	}
}
