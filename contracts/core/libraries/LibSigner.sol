// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibExecutionContext } from "./LibExecutionContext.sol";

library LibSigner {
	/// @notice Returns the current signer address, falling back to msg.sender if no signer is set.
	function getSigner() internal view returns (address) {
		return LibExecutionContext.signer();
	}
}
