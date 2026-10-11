// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IControlFacet } from "../facets/Control/IControlFacet.sol";
import { IExecutionFacet } from "../facets/Execution/IExecutionFacet.sol";
import { IDelegationFacet } from "../facets/Delegation/IDelegationFacet.sol";
import { IInstantLayerViewFacet } from "../facets/View/IViewFacet.sol";
import { IDiamondCut } from "../../diamond/facets/DiamondCut/IDiamondCut.sol";
import { IDiamondLoupe } from "../../diamond/facets/DiamondLoup/IDiamondLoupe.sol";
import { IERC165 } from "../../diamond/interfaces/IERC165.sol";

/// @notice Every function, event and error the InstantLayer diamond exposes at its one address
interface IInstantLayerDiamond is IControlFacet, IExecutionFacet, IDelegationFacet, IInstantLayerViewFacet, IDiamondCut, IDiamondLoupe, IERC165 {}
