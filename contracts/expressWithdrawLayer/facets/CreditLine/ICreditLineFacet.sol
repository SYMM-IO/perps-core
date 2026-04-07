// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface ICreditLineEvents {
	event CreditLineProtocolConfigUpdated(address indexed affiliate, uint256 maxDebt, uint256 maxDebtBps);
	event CreditLineMuonConfigUpdated(address signatureVerifier, uint256 muonAppId, uint256 muonFreshnessWindow);
	event CreditLineAffiliateConfigUpdated(address indexed affiliate, uint256 maxDebt, uint256 maxDebtBps);
	event CreditLineUserBlacklistUpdated(address indexed affiliate, address indexed user, bool blacklisted);
	event CreditLinePausedUpdated(address indexed affiliate, bool paused);
}

interface ICreditLineFacet is ICreditLineEvents {
	// ── Protocol admin setters ──

	function setCreditLineMuonConfig(address signatureVerifier, uint256 muonAppId, uint256 muonFreshnessWindow) external;

	function setCreditLineProtocolConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external;

	// ── Affiliate admin setters ──

	function setCreditLineAffiliateConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external;

	function setCreditLinePaused(address affiliate, bool paused) external;

	function setCreditLineBlacklisted(address affiliate, address user, bool blacklisted) external;
}
