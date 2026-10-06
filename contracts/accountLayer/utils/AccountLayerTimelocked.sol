// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibTimelock } from "../libraries/LibTimelock.sol";

/// @notice Modifiers that put owner entry points behind the account family's timelock gate.
abstract contract AccountLayerTimelocked {
	/// @notice When this function's selector is timelocked for the family, the call must be approved or scheduled.
	modifier timelocked(address account) {
		LibTimelock.requireCallApprovedOrScheduled(account, msg.sig);
		_;
	}

	/// @notice Checks each call's own selector and calldata: the entry, any implied standalone call, and each inner core call.
	modifier timelockedWithInnerCalls(address account, bytes[] calldata callDatas, bytes memory sideCallData) {
		LibTimelock.requireCallsApprovedOrScheduled(account, callDatas, sideCallData);
		_;
	}
}
