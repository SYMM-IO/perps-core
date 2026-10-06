// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartiesEvents } from "../../interfaces/IPartiesEvents.sol";
import { QuoteSettlementData, UnifiedQuoteSettlementData } from "../../storages/MuonStorage.sol";

interface SettlementFacetEvents is IPartiesEvents {
	event SettleUpnl(
		QuoteSettlementData[] settlementData,
		uint256[] updatedPrices,
		address partyA,
		uint256 newPartyAAllocatedBalance,
		uint256[] newPartyBsAllocatedBalances
	);

	event SettleUpnlUnified(
		bytes settlementId,
		UnifiedQuoteSettlementData[] settlementData,
		uint256[] updatedPrices,
		address partyB,
		address[] partyAs,
		uint256[] newPartyAsAllocatedBalances,
		uint256 newPartyBAllocatedBalance
	);

	event SettlePartyBUpnlForLiquidation(
		address indexed liquidatedPartyA,
		address indexed partyB,
		bytes settlementId,
		UnifiedQuoteSettlementData[] settlementData,
		uint256[] updatedPrices,
		address[] partyAs,
		uint256[] newPartyAsAllocatedBalances,
		uint256 newPartyBAllocatedBalance
	);
}
