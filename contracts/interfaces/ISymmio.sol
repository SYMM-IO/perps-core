// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountFacet } from "../facets/Account/IAccountFacet.sol";
import { IControlFacet } from "../facets/Control/IControlFacet.sol";
import { ISymbolControlFacet } from "../facets/Control/ISymbolControlFacet.sol";
import { IPauseControlFacet } from "../facets/Control/IPauseControlFacet.sol";
import { IFundingRateFacet } from "../facets/FundingRate/IFundingRateFacet.sol";
import { IPartyALiquidationFacet } from "../facets/liquidation/IPartyALiquidationFacet.sol";
import { IPartyBLiquidationFacet } from "../facets/liquidation/IPartyBLiquidationFacet.sol";
import { IPartyAFacet } from "../facets/PartyA/IPartyAFacet.sol";
import { IBridgeFacet } from "../facets/Bridge/IBridgeFacet.sol";
import { IViewFacet } from "../facets/ViewFacet/IViewFacet.sol";
import { IViewFacetSymbol } from "../facets/ViewFacet/IViewFacetSymbol.sol";
import { IViewFacetQuote } from "../facets/ViewFacet/IViewFacetQuote.sol";
import { IDiamondCut } from "../facets/DiamondCut/IDiamondCut.sol";
import { IDiamondLoupe } from "../facets/DiamondLoup/IDiamondLoupe.sol";
import { IPartyBQuoteActionsFacet } from "../facets/PartyBQuoteActions/IPartyBQuoteActionsFacet.sol";
import { IPartyBPositionActionsFacet } from "../facets/PartyBPositionActions/IPartyBPositionActionsFacet.sol";
import { IForceActionsFacet } from "../facets/ForceActions/IForceActionsFacet.sol";
import { ISettlementFacet } from "../facets/Settlement/ISettlementFacet.sol";
import { IPartyBBatchActionsFacet } from "../facets/PartyBBatchActions/IPartyBBatchActionsFacet.sol";

interface ISymmio is
	IAccountFacet,
	IControlFacet,
	ISymbolControlFacet,
	IPauseControlFacet,
	IFundingRateFacet,
	IBridgeFacet,
	ISettlementFacet,
	IForceActionsFacet,
	IPartyBQuoteActionsFacet,
	IPartyBPositionActionsFacet,
	IPartyBBatchActionsFacet,
	IPartyAFacet,
	IPartyALiquidationFacet,
	IPartyBLiquidationFacet,
	IViewFacet,
	IViewFacetSymbol,
	IViewFacetQuote,
	IDiamondCut,
	IDiamondLoupe
{
	// Copied from SharedEvents library
	enum BalanceChangeType {
		ALLOCATE,
		DEALLOCATE,
		PLATFORM_FEE_IN,
		PLATFORM_FEE_OUT,
		REALIZED_PNL_IN,
		REALIZED_PNL_OUT,
		CVA_IN,
		CVA_OUT,
		LF_IN,
		LF_OUT,
		FUNDING_FEE_IN,
		FUNDING_FEE_OUT
	}

	// Copied from SharedEvents library
	event BalanceChangePartyA(address indexed partyA, uint256 amount, BalanceChangeType _type);

	// Copied from SharedEvents library
	event BalanceChangePartyB(address indexed partyB, address indexed partyA, uint256 amount, BalanceChangeType _type);
}
