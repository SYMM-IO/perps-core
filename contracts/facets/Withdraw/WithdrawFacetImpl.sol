// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../../storages/AccountStorage.sol";
import "../../storages/GlobalAppStorage.sol";
import "../../storages/MAStorage.sol";
import "../../storages/WithdrawStorage.sol";
import {IVirtualProvider} from "../../interfaces/IVirtualProvider.sol";
import {IExpressProvider} from "../../interfaces/IExpressProvider.sol";



library WithdrawFacetImpl {
    using SafeERC20 for IERC20;
    event Withdraw(address sender, address user, uint256 amount);

    function initiateWithdraw(
        WithdrawReceiverPart[] memory parts,
        bytes memory data
    ) internal returns (uint256) {
        AccountStorage.Layout storage accountLayout = AccountStorage.layout();
        WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
        GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
        address collateral = appLayout.collateral;
        uint256 collateralDecimals = IERC20Metadata(collateral).decimals();

        require(parts.length <= withdrawLayout.maxWithdrawParts, "Too many withdraw parts");
        require(parts.length > 0, "No withdraw parts");

        uint256 totalAmount;
        address expressProvider;
        address pureVirtualProvider;

        for (uint256 i = 0; i < parts.length; i++) {
            WithdrawReceiverPart memory part = parts[i];

            bool isExpress = part.expressProvider != address(0);
            bool isVirtual = part.virtualProvider != address(0);

            if (isExpress) {
                if (expressProvider == address(0)) {
                    expressProvider = part.expressProvider;
                } else {
                    require(
                        expressProvider == part.expressProvider,
                        "Multiple express providers not allowed"
                    );
                }
            }

            if (!isExpress && isVirtual) {
                if (pureVirtualProvider == address(0)) {
                    pureVirtualProvider = part.virtualProvider;
                } else {
                    require(
                        pureVirtualProvider == part.virtualProvider,
                        "Multiple virtual providers not allowed"
                    );
                }
            }

            totalAmount += part.amount;
        }

        require(totalAmount > 0, "Total withdraw amount must be greater than zero");

        uint256 totalAmountWith18Decimals =
            (totalAmount * 1e18) / (10 ** collateralDecimals);
        require(
            accountLayout.balances[msg.sender] >= totalAmountWith18Decimals,
            "AccountFacet: Insufficient balance"
        );

        accountLayout.balances[msg.sender] -= totalAmountWith18Decimals;

        uint256 currentId = ++withdrawLayout.lastWithdrawRequestId[msg.sender];

        WithdrawRequest memory withdrawRequest = WithdrawRequest({
            id: currentId,
            user: msg.sender,
            parts: parts,
            timestamp: block.timestamp,
            cooldownEndTime: block.timestamp + withdrawLayout.withdrawCooldownPeriod,
            status: WithdrawStatus.PENDING,
            providerData: data
        });

        withdrawLayout.withdrawRequests[msg.sender][currentId] = withdrawRequest;

        // If there is any express usage , notify the unique express provider.
        if (expressProvider != address(0)) {
            IExpressProvider(expressProvider).onWithdrawRequest(withdrawRequest);
        }

        // If there is NO express provider at all, but there are virtual-only parts,
        // notify the unique virtual provider.
        // (virtual providers used only in express+virtual parts are not "pure" virtual-only)
        if (expressProvider == address(0) && pureVirtualProvider != address(0)) {
            IVirtualProvider(pureVirtualProvider).onWithdrawRequest(withdrawRequest);
        }

        return currentId;
    }

    function finalizeWithdrawRequest(uint256 requestId) internal {
        WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
        GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
        address collateral = appLayout.collateral;

        require(
            requestId <= withdrawLayout.lastWithdrawRequestId[msg.sender],
            "Invalid withdraw request ID"
        );

        WithdrawRequest storage withdrawRequest =
                                withdrawLayout.withdrawRequests[msg.sender][requestId];

        require(withdrawRequest.user == msg.sender, "Not withdraw request owner");
        require(
            block.timestamp >= withdrawRequest.cooldownEndTime,
            "Withdraw cooldown not over"
        );
        require(
            uint8(withdrawRequest.status) == uint8(WithdrawStatus.PENDING) ||
            uint8(withdrawRequest.status) == uint8(WithdrawStatus.PROVIDER_ACCEPTED),
            "Invalid withdraw request status"
        );

        address expressProvider;
        address pureVirtualProvider;
        uint256 totalExpressAmount;
        uint256 totalAmount;

        for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
            WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];

            bool isExpress = withdrawal.expressProvider != address(0);
            bool isVirtual = withdrawal.virtualProvider != address(0);

            totalAmount += withdrawal.amount;

            if (!isExpress && !isVirtual) {
                IERC20(collateral).safeTransfer(
                    _bytesToAddress(withdrawal.receiver),
                    withdrawal.amount
                );
                continue;
            }

            if (isExpress) {
                if (expressProvider == address(0)) {
                    expressProvider = withdrawal.expressProvider;
                } else {
                    require(
                        expressProvider == withdrawal.expressProvider,
                        "Multiple express providers not allowed"
                    );
                }
                totalExpressAmount += withdrawal.amount;
            }

            if (!isExpress && isVirtual) {
                if (pureVirtualProvider == address(0)) {
                    pureVirtualProvider = withdrawal.virtualProvider;
                } else {
                    require(
                        pureVirtualProvider == withdrawal.virtualProvider,
                        "Multiple virtual providers not allowed"
                    );
                }
            }
        }

        if (expressProvider != address(0)) {
            require(
                uint8(withdrawRequest.status) ==
                uint8(WithdrawStatus.PROVIDER_ACCEPTED),
                "Invalid withdraw request status"
            );
            IERC20(collateral).safeTransfer(expressProvider, totalExpressAmount);
            IExpressProvider(expressProvider).onWithdrawComplete(withdrawRequest);
        } else if (pureVirtualProvider != address(0)) {
            require(
                uint8(withdrawRequest.status) ==
                uint8(WithdrawStatus.PROVIDER_ACCEPTED),
                "Invalid withdraw request status"
            );
            IVirtualProvider(pureVirtualProvider).onWithdrawComplete(withdrawRequest);
        }

        withdrawRequest.status = WithdrawStatus.COMPLETED;

        // Event wise old events should still be emitted here
        emit Withdraw(msg.sender, withdrawRequest.user, totalAmount);
    }


    function requestCancelWithdraw(uint256 requestId) internal {
        AccountStorage.Layout storage accountLayout = AccountStorage.layout();
        WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
        GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
        uint256 collateralDecimals = IERC20Metadata(appLayout.collateral).decimals();

        require(
            requestId <= withdrawLayout.lastWithdrawRequestId[msg.sender],
            "Invalid withdraw request ID"
        );

        WithdrawRequest storage withdrawRequest =
                                withdrawLayout.withdrawRequests[msg.sender][requestId];

        require(withdrawRequest.user == msg.sender, "Not withdraw request owner");
        require(
            uint8(withdrawRequest.status) == uint8(WithdrawStatus.PENDING),
            "Invalid withdraw request status"
        );

        uint256 totalCancelAmount;
        bool hasAnyProvider;
        address expressProvider;
        address pureVirtualProvider;

        for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
            WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];

            bool isExpress = withdrawal.expressProvider != address(0);
            bool isVirtual = withdrawal.virtualProvider != address(0);

            if (!isExpress && !isVirtual) {
                totalCancelAmount += withdrawal.amount;
                continue;
            }

            hasAnyProvider = true;

            if (isExpress) {
                if (expressProvider == address(0)) {
                    expressProvider = withdrawal.expressProvider;
                } else {
                    require(
                        expressProvider == withdrawal.expressProvider,
                        "Multiple express providers not allowed"
                    );
                }
            }

            if (!isExpress && isVirtual) {
                if (pureVirtualProvider == address(0)) {
                    pureVirtualProvider = withdrawal.virtualProvider;
                } else {
                    require(
                        pureVirtualProvider == withdrawal.virtualProvider,
                        "Multiple virtual providers not allowed"
                    );
                }
            }
        }

        if (!hasAnyProvider) {
            withdrawRequest.status = WithdrawStatus.CANCELLED;
        } else {
            withdrawRequest.status = WithdrawStatus.CANCEL_REQUESTED;
        }

        if (totalCancelAmount > 0) {
            uint256 totalAmountWith18Decimals =
                (totalCancelAmount * 1e18) / (10 ** collateralDecimals);
            accountLayout.balances[withdrawRequest.user] += totalAmountWith18Decimals;
        }

        // Provider notifications:
        // If there is any express usage, we consider expressProvider the master.
        if (expressProvider != address(0)) {
            IExpressProvider(expressProvider).onWithdrawCancelRequest(withdrawRequest);
        } else if (pureVirtualProvider != address(0)) {
            IVirtualProvider(pureVirtualProvider).onWithdrawCancelRequest(withdrawRequest);
        }
    }

    function forceCancelWithdraw(uint256 requestId) internal {
        // it is for virtual withdrawal users to force cancel after cooldown
        AccountStorage.Layout storage accountLayout = AccountStorage.layout();
        WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
        GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
        uint256 collateralDecimals = IERC20Metadata(appLayout.collateral).decimals();

        require(
            requestId <= withdrawLayout.lastWithdrawRequestId[msg.sender],
            "Invalid withdraw request ID"
        );

        WithdrawRequest storage withdrawRequest =
                                withdrawLayout.withdrawRequests[msg.sender][requestId];

        require(withdrawRequest.user == msg.sender, "Not withdraw request owner");
        require(
            uint8(withdrawRequest.status) == uint8(WithdrawStatus.CANCEL_REQUESTED),
            "Invalid withdraw request status"
        );
        require(
            block.timestamp >= withdrawRequest.cooldownEndTime,
            "Withdraw cooldown not over"
        );

        uint256 totalAmount;
        address pureVirtualProvider;

        for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
            WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];

            require(
                withdrawal.expressProvider == address(0),
                "Not allowed for express withdrawals"
            );

            if (withdrawal.virtualProvider != address(0)) {
                if (pureVirtualProvider == address(0)) {
                    pureVirtualProvider = withdrawal.virtualProvider;
                } else {
                    require(
                        pureVirtualProvider == withdrawal.virtualProvider,
                        "Multiple virtual providers not allowed"
                    );
                }
                totalAmount += withdrawal.amount;
            }
        }

        require(pureVirtualProvider != address(0), "No virtual withdrawal part found");

        withdrawRequest.status = WithdrawStatus.CANCELLED;

        uint256 totalAmountWith18Decimals =
            (totalAmount * 1e18) / (10 ** collateralDecimals);
        accountLayout.balances[withdrawRequest.user] += totalAmountWith18Decimals;

        IVirtualProvider(pureVirtualProvider).onForceWithdrawCancel(withdrawRequest);
    }


    function _bytesToAddress(bytes memory data) internal pure returns (address addr) {
        require(data.length == 20, "Invalid address bytes length");
        assembly {
            addr := shr(96, mload(add(data, 32)))
        }
    }
}
