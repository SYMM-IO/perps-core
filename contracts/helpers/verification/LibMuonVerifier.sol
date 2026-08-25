// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

import { IMuonSignatureVerifier } from "../../core/interfaces/IMuonSignatureVerifier.sol";

/// @notice Shared compatibility checks for Muon signature verifiers.
library LibMuonVerifier {
	/// @notice Returns whether a deployed verifier explicitly supports a function category ID.
	/// @dev A missing capability selector, malformed return value, revert, or EOA returns false.
	function supportsMuonFunction(address verifier, uint8 functionId) internal view returns (bool) {
		if (verifier.code.length == 0) return false;

		try IMuonSignatureVerifier(verifier).supportsMuonFunction(functionId) returns (bool supported) {
			return supported;
		} catch {
			return false;
		}
	}
}
