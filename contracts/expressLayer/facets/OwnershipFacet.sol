// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";

/// @title OwnershipFacet
/// @notice Two-step ownership transfer for the ExpressProvider diamond.
contract OwnershipFacet {
	function owner() external view returns (address) {
		return LibDiamond.contractOwner();
	}

	function pendingOwner() external view returns (address) {
		return LibDiamond.diamondStorage().pendingOwner;
	}

	function transferOwnership(address _newOwner) external {
		LibDiamond.enforceIsContractOwner();
		LibDiamond.transferOwnership(_newOwner);
	}

	function acceptOwnership() external {
		LibDiamond.acceptOwnership();
	}

	function cancelOwnershipTransfer() external {
		LibDiamond.enforceIsContractOwner();
		LibDiamond.cancelOwnershipTransfer();
	}
}
