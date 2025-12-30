// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SubAccountCreationData, SubAccountDetail } from "../storages/AccountHubStorage.sol";

interface IAccountLayerDiamond {
	// From ControlFacet
	function setSigner(address _signer) external;

	// From CoreFacet
	function createSubAccounts(address affiliate, SubAccountCreationData[] memory accountsData) external returns (address[] memory);
	function _call(address account, bytes[] calldata callDatas) external returns (bytes[] memory);

	// From ViewFacet
	function getRelatedCore(address account) external view returns (address);
	function getSubAccountsCountOfUser(address owner) external view returns (uint256);
	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (SubAccountDetail[] memory);
	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory);
}
