// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./interfaces/IAccountManager.sol";
import "./interfaces/IAccountHub.sol";

contract AccountManager is IAccountManager{
    address public hub;
    address public affiliate;

    modifier onlyHub() {
        require(msg.sender == hub, "AccountManager: Only hub");
        _;
    }

    function initialize(address _hub, address _affiliate) external{
        hub = _hub;
        affiliate = _affiliate;
    }
    // Backward compatible functions
    function addAccount(string memory name) external returns (address) {
        return IAccountHub(hub).createSubAccount(affiliate, name, "");
    }

    function depositForAccount(address account, uint256 amount) external {
        IAccountHub(hub).depositForAccount(account, amount);
    }

    function withdrawFromAccount(address account, uint256 amount) external {
        IAccountHub(hub).withdrawFromAccount(account, amount);
    }

    function _call(address account, bytes[] memory callDatas) external {
        IAccountHub(hub)._call(account, callDatas);
    }

    // function getAccountsLength(address user) external view returns (uint256) {
    //     return IAccountHub(hub).getAccountsLength(user);
    // }

    // function getAccounts(address user, uint256 start, uint256 size) external view returns (IAccountHub.Account[] memory) {
    //     return IAccountHub(hub).getAccounts(user, start, size);
    // }

    function getHub() external view returns (address) {
        return hub;
    }

    function getAffiliate() external view returns (address) {
        return affiliate;
    }
}