// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IControlEvents } from "../Control/IControlEvents.sol";

interface IPauseControlFacet is IControlEvents {
	function pauseGlobal() external;

	function pauseLiquidation() external;

	function pauseAccounting() external;

	function pausePartyAActions() external;

	function pausePartyBActions() external;

	function pausePartyBOpenPositions() external;

	function pauseInternalTransfer() external;

	function pauseExternalTransfer() external;

	function activeEmergencyMode() external;

	function unpauseGlobal() external;

	function unpauseLiquidation() external;

	function unpauseAccounting() external;

	function unpausePartyAActions() external;

	function unpausePartyBActions() external;

	function unpausePartyBOpenPositions() external;

	function unpauseInternalTransfer() external;

	function unpauseExternalTransfer() external;

	function deactiveEmergencyMode() external;

	function suspendedAddress(address user) external;

	function unsuspendedAddress(address user) external;

	function setPartyBEmergencyStatus(address[] memory partyBs, bool status) external;

	function deprecateOldWithdrawal() external;

	function deprecateOldFundingFee() external;
}
