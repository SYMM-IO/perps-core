// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountFacet } from "../facets/Account/IAccountFacet.sol";
import { IControlFacet } from "../facets/Control/IControlFacet.sol";
import { ISymbolControlFacet } from "../facets/SymbolControl/ISymbolControlFacet.sol";
import { ISymbolAdjustmentFacet } from "../facets/SymbolAdjustment/ISymbolAdjustmentFacet.sol";
import { IPauseControlFacet } from "../facets/PauseControl/IPauseControlFacet.sol";
import { IFundingRateFacet } from "../facets/FundingRate/IFundingRateFacet.sol";
import { IPartyALiquidationFacet } from "../facets/PartyALiquidation/IPartyALiquidationFacet.sol";
import { IPartyALiquidationSnapshotFacet } from "../facets/PartyALiquidationSnapshot/IPartyALiquidationSnapshotFacet.sol";
import { IPartyBLiquidationFacet } from "../facets/PartyBLiquidation/IPartyBLiquidationFacet.sol";
import { IPartyAFacet } from "../facets/PartyA/IPartyAFacet.sol";
import { IBridgeFacet } from "../facets/Bridge/IBridgeFacet.sol";
import { IViewFacet } from "../facets/ViewFacet/IViewFacet.sol";
import { IViewFacetSymbol } from "../facets/ViewFacetSymbol/IViewFacetSymbol.sol";
import { IViewFacetQuote } from "../facets/ViewFacetQuote/IViewFacetQuote.sol";
import { IDiamondCut } from "../../diamond/facets/DiamondCut/IDiamondCut.sol";
import { IDiamondLoupe } from "../../diamond/facets/DiamondLoup/IDiamondLoupe.sol";
import { IPartyBQuoteActionsFacet } from "../facets/PartyBQuoteActions/IPartyBQuoteActionsFacet.sol";
import { IPartyBPositionActionsFacet } from "../facets/PartyBPositionActions/IPartyBPositionActionsFacet.sol";
import { IPartyBSolverFeeActionsFacet } from "../facets/PartyBSolverFeeActions/IPartyBSolverFeeActionsFacet.sol";
import { IForceActionsFacet } from "../facets/ForceActions/IForceActionsFacet.sol";
import { ISettlementFacet } from "../facets/Settlement/ISettlementFacet.sol";
import { IPartyBBatchActionsFacet } from "../facets/PartyBBatchActions/IPartyBBatchActionsFacet.sol";

/// @notice Composite interface aggregating a subset of Symmio Diamond facet interfaces
interface ISymmio is
	IAccountFacet,
	IControlFacet,
	ISymbolControlFacet,
	ISymbolAdjustmentFacet,
	IPauseControlFacet,
	IFundingRateFacet,
	IBridgeFacet,
	ISettlementFacet,
	IForceActionsFacet,
	IPartyBQuoteActionsFacet,
	IPartyBPositionActionsFacet,
	IPartyBSolverFeeActionsFacet,
	IPartyBBatchActionsFacet,
	IPartyAFacet,
	IPartyALiquidationFacet,
	IPartyALiquidationSnapshotFacet,
	IPartyBLiquidationFacet,
	IViewFacet,
	IViewFacetSymbol,
	IViewFacetQuote,
	IDiamondCut,
	IDiamondLoupe
{
	/// @notice Categories of balance changes tracked for accounting and event emission
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
		FUNDING_FEE_OUT,
		DEFERRED_BALANCE_IN,
		DEFERRED_BALANCE_OUT,
		REIMBURSEMENT_IN,
		OPERATIONAL_FEE_OUT,
		OPEN_SOLVER_FEE_OUT,
		CLOSE_SOLVER_FEE_OUT
	}

	/// @notice Emitted when a PartyA's allocated balance changes
	event BalanceChangePartyA(address indexed partyA, uint256 amount, BalanceChangeType _type);

	/// @notice Emitted when a PartyB's allocated balance changes for a specific PartyA
	event BalanceChangePartyB(address indexed partyB, address indexed partyA, uint256 amount, BalanceChangeType _type);
}
