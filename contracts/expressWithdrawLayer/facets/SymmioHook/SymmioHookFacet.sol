// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ISymmioHookFacet } from "./ISymmioHookFacet.sol";
import { SymmioHookFacetImpl } from "./SymmioHookFacetImpl.sol";
import { WithdrawRequest } from "../../../core/storages/WithdrawStorage.sol";
import { LibErrors } from "../../libraries/LibErrors.sol";
import { GlobalStorage } from "../../storages/GlobalStorage.sol";

/// @title SymmioHookFacet
/// @notice Handles SYMMIO callbacks for the ExpressProvider diamond.
contract SymmioHookFacet is ISymmioHookFacet {
	modifier nonReentrant() {
		GlobalStorage.Layout storage s = GlobalStorage.layout();
		if (s.reentrancyStatus == 1) revert LibErrors.Reentrancy();
		s.reentrancyStatus = 1;
		_;
		s.reentrancyStatus = 0;
	}

	function onWithdrawRequest(WithdrawRequest memory withdrawRequest, address) external nonReentrant {
		(uint8 optionType, bool processed) = SymmioHookFacetImpl.onWithdrawRequest(withdrawRequest);
		emit WithdrawAccepted(withdrawRequest.user, withdrawRequest.id, optionType);
		if (processed) {
			emit WithdrawProcessed(withdrawRequest.user, withdrawRequest.id);
		}
	}

	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external {
		SymmioHookFacetImpl.onWithdrawComplete(withdrawRequest);
		emit WithdrawFinalized(withdrawRequest.user, withdrawRequest.id);
	}

	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external nonReentrant {
		SymmioHookFacetImpl.onWithdrawCancelRequest(withdrawRequest);
		emit WithdrawCancelled(withdrawRequest.user, withdrawRequest.id);
	}

	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external nonReentrant {
		SymmioHookFacetImpl.onWithdrawSuspend(withdrawRequest);
		emit WithdrawSuspended(withdrawRequest.user, withdrawRequest.id);
	}
}
