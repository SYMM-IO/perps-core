// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";

/// @notice Opt-in fee limits committed by the existing signed replay salt.
/// @dev Layout: 8-byte domain tag, 16-byte maximum fee (18 decimals), 8-byte caller salt.
///      Changing or removing the limit changes the signed operation. Nonces, deadlines and maxUses retain their original meaning.
///      Legacy salts remain uncapped. A limit applies to each use of its operation, including wallet deployment fees and VA fallback.
library GaslessFeeLimits {
	bytes8 internal constant TAG = bytes8(keccak256("SYMMIO_GASLESS_FEE_LIMIT_V1"));

	function check(bytes32 salt, uint256 actual) internal pure {
		if (bytes8(salt) != TAG) return;
		uint256 maximum = uint128(uint256(salt) >> 64);
		if (actual > maximum) revert IGaslessLayer.FeeLimitExceeded(actual, maximum);
	}
}
