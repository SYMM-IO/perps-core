// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

import { IMuonSignatureVerifier } from "../../core/interfaces/IMuonSignatureVerifier.sol";

/// @notice Reverted when a Muon `reqId` is not exactly 32 bytes long.
/// @dev `bytes` stays the ABI/storage type so valid 32-byte IDs hash exactly as before;
///      this only rejects IDs that would otherwise silently change the signed payload.
error InvalidMuonReqIdLength(uint256 actualLength);

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

	/// @notice Requires a Muon `reqId` to be exactly 32 bytes, before signature verification.
	/// @dev Every production Muon verification path calls this first so a short or long ID
	///      reverts with a specific error instead of silently altering the signed hash.
	function requireValidReqId(bytes memory reqId) internal pure {
		if (reqId.length != 32) revert InvalidMuonReqIdLength(reqId.length);
	}
}
