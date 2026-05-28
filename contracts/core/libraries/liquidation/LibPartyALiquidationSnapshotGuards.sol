// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";

library LibPartyALiquidationSnapshotGuards {
	function requirePartyBSymbolSnapshotPricingEnabled(AccountStorage.Layout storage accountLayout, address partyA) internal view {
		require(
			accountLayout.liquidationUsesPartyBSymbolSnapshots[partyA][accountLayout.liquidationDetails[partyA].liquidationId],
			"LiquidationFacet: Not snapshot liquidation"
		);
	}

	function requirePartyBSymbolSnapshotPricingDisabled(AccountStorage.Layout storage accountLayout, address partyA) internal view {
		require(
			!accountLayout.liquidationUsesPartyBSymbolSnapshots[partyA][accountLayout.liquidationDetails[partyA].liquidationId],
			"LiquidationFacet: Not legacy liquidation"
		);
	}

	function enablePartyBSymbolSnapshotPricing(address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		accountLayout.liquidationUsesPartyBSymbolSnapshots[partyA][accountLayout.liquidationDetails[partyA].liquidationId] = true;
	}
}
