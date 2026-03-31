// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ICreditLineEvents } from "./ICreditLineEvents.sol";

interface ICreditLineFacet is ICreditLineEvents {
	// ── Protocol admin setters ──

	function setCreditLineMuonConfig(address signatureVerifier, uint256 muonAppId, uint256 muonFreshnessWindow) external;

	function setCreditLineProtocolConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external;

	// ── Affiliate admin setters ──

	function setCreditLineAffiliateConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external;

	function setCreditLinePaused(address affiliate, bool paused) external;

	function setCreditLineBlacklisted(address affiliate, address user, bool blacklisted) external;

	// ── Views ──

	function creditLineSignatureVerifier() external view returns (address);

	function creditLineMuonAppId() external view returns (uint256);

	function creditLineMuonFreshnessWindow() external view returns (uint256);

	function creditLineProtocolMaxDebt(address affiliate) external view returns (uint256);

	function creditLineProtocolMaxDebtBps(address affiliate) external view returns (uint256);

	function creditLineAffiliateMaxDebt(address affiliate) external view returns (uint256);

	function creditLineAffiliateMaxDebtBps(address affiliate) external view returns (uint256);

	function creditLineReservedDebt(address affiliate) external view returns (uint256);

	function creditLineActiveDebt(address affiliate) external view returns (uint256);

	function creditLineTotalDebt(address affiliate) external view returns (uint256);

	function creditLineRequestDebt(address affiliate, address user, uint256 requestId) external view returns (uint256);

	function creditLineRequestActivated(address affiliate, address user, uint256 requestId) external view returns (bool);

	function creditLinePaused(address affiliate) external view returns (bool);

	function creditLineBlacklisted(address affiliate, address user) external view returns (bool);
}
