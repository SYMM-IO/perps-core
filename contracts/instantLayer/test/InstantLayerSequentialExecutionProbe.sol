// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SignedOperation } from "../InstantLayerTypes.sol";
import { IExecutionFacet } from "../facets/Execution/IExecutionFacet.sol";

/// @notice Sequential (non-reentrant) two-call probe for the core diamond's execution-context
///         open/close lifecycle.
/// @dev Calls executeBatch twice, one after another, in a single transaction — not nested, so
///      InstantLayerReentrancyGuard never sees an entered call: each executeBatch returns before
///      the next one starts. What this isolates is core's own
///      beginInstantLayerExecution/endInstantLayerExecution pairing. If the first call's closing
///      endInstantLayerExecution is ever dropped, the transient context core opened for it stays
///      active into the second call, and that call's own beginInstantLayerExecution reverts
///      (TransientContextAlreadyActive). This is only observable because both calls share one
///      transaction: two separate transactions would never see it, since EIP-1153 transient
///      storage clears at transaction end regardless of whether the close ran.
contract InstantLayerSequentialExecutionProbe {
	/// @notice Whitelistable no-op operation target.
	function noop() external {}

	/// @notice Calls executeBatch twice, back to back, within this one transaction.
	function runTwice(
		address diamond,
		SignedOperation[] calldata ops1,
		bytes[] calldata sigs1,
		bytes[][] calldata fills1,
		bytes[][] calldata flexFillerSigs1,
		SignedOperation[] calldata ops2,
		bytes[] calldata sigs2,
		bytes[][] calldata fills2,
		bytes[][] calldata flexFillerSigs2
	) external {
		IExecutionFacet(diamond).executeBatch(ops1, sigs1, fills1, flexFillerSigs1);
		IExecutionFacet(diamond).executeBatch(ops2, sigs2, fills2, flexFillerSigs2);
	}
}
