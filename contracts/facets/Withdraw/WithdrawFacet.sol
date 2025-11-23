// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

import "../../utils/Accessibility.sol";
import "../../utils/Pausable.sol";
import "../../storages/GlobalAppStorage.sol";
import "../../libraries/SharedEvents.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IWithdrawFacet} from "./IWithdrawFacet.sol";
import {WithdrawFacetImpl} from "./WithdrawFacetImpl.sol";
import "../../storages/WithdrawStorage.sol";

contract WithdrawFacet is Accessibility, Pausable, IWithdrawFacet, ReentrancyGuard {

    function initiateWithdraw(WithdrawReceiverPart[] memory parts, bytes memory data) external nonReentrant {
        uint256 requestId = WithdrawFacetImpl.initiateWithdraw(parts, data);
        emit WithdrawInitiated(requestId, msg.sender, parts, data);
    }

    function finalizeWithdrawRequest(uint256 requestId) external nonReentrant {
        WithdrawFacetImpl.finalizeWithdrawRequest(requestId);
        emit WithdrawFinalized(requestId, msg.sender);

    }

    function requestCancelWithdraw(uint256 requestId) external nonReentrant {
        WithdrawFacetImpl.requestCancelWithdraw(requestId);
        emit WithdrawCancelRequested(requestId, msg.sender);
    }

    function forceCancelWithdraw(uint256 requestId) external nonReentrant {
        WithdrawFacetImpl.forceCancelWithdraw(requestId);
        emit WithdrawCancelled(requestId, msg.sender);
    }
}
