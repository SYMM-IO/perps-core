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

	/// @notice Reasons for exact changes to PartyA's liquidation reimbursement bucket.
	enum ReimbursementChangeType {
		CLEARING_HOUSE_IN,
		PLATFORM_FEE_IN,
		CLEARING_HOUSE_OUT,
		RELEASE_TO_ALLOCATED,
		MOVE_TO_LIQUIDATION_ESCROW
	}

	/// @notice Emitted only when a PartyA's allocated balance changes.
	/// @dev `amount` is the absolute allocated-balance delta represented by `_type`.
	event BalanceChangePartyA(address indexed partyA, uint256 amount, BalanceChangeType _type);

	/// @notice Emitted only when a PartyB allocated-balance bucket changes.
	/// @dev `partyA` is the exact storage key: the PartyA address for isolated allocations or address(0) for cross mode.
	///      `amount` is the absolute allocated-balance delta represented by `_type`.
	event BalanceChangePartyB(address indexed partyB, address indexed partyA, uint256 amount, BalanceChangeType _type);

	/// @notice Emitted only when PartyA's liquidation reimbursement bucket changes.
	/// @dev `amount` is the absolute bucket delta and `newBalance` is the post-change bucket balance.
	event PartyAReimbursementChange(address indexed partyA, uint256 amount, uint256 newBalance, ReimbursementChangeType _type);
}
