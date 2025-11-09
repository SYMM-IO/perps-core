// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface ISymmio {
    function depositFor(address user, uint256 amount) external;
    function withdrawTo(address user, uint256 amount) external;
    function allocate(uint256 amount) external;
    function getCollateral() external view returns (address);
    function balanceOf(address user) external view returns (uint256);
    function setSigner(address signer) external;
}