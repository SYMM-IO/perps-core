// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SignedOperation } from "../InstantLayerTypes.sol";
import { IExecutionFacet } from "../facets/Execution/IExecutionFacet.sol";

/// @notice Reentrancy-guard probe for ExecutionFacet.
/// @dev Deployed as the whitelisted target of one operation in a batch. When the diamond routes
///      that operation here, reenter() calls straight back into the same diamond's executeBatch
///      with an empty batch. That nested call carries no signature, no role, and no account
///      context of its own, so whichever check stops it first is exactly whichever guards
///      executeBatch's entry: nonReentrant if it is doing its job, something else (a role check,
///      most likely) if it is not. A test comparing the exact wrapped revert selector against
///      ReentrancyGuardReentrantCall's therefore isolates that one guard from every other check
///      executeBatch performs, including the core diamond's own transient-context guard, which
///      independently refuses a nested beginInstantLayerExecution and would otherwise mask
///      whether InstantLayer's own guard ever ran.
contract InstantLayerReentrancyProbe {
	/// @notice Re-enters the diamond's executeBatch with an empty batch.
	/// @param diamond The InstantLayer diamond under test.
	function reenter(address diamond) external {
		IExecutionFacet(diamond).executeBatch(new SignedOperation[](0), new bytes[](0), new bytes[][](0), new bytes[][](0));
	}
}
