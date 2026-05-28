// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";

library LibPartyBState {
	function requireNotLiquidatingAgainst(address partyB, address partyA) internal view {
		require(!MAStorage.layout().partyBLiquidationStatus[partyB][partyA], "PartyBState: PartyB is in liquidation");
	}

	function requireNotCrossLiquidating(address partyB) internal view {
		require(!ClearingHouseStorage.layout().crossLiquidationDetails[partyB].inProgress, "PartyBState: PartyB is in cross liquidation");
	}

	function requireNotLiquidating(address partyB, address partyA) internal view {
		require(
			!MAStorage.layout().partyBLiquidationStatus[partyB][partyA] && !ClearingHouseStorage.layout().crossLiquidationDetails[partyB].inProgress,
			"PartyBState: PartyB is in liquidation"
		);
	}
}
