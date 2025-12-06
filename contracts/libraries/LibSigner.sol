// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../storages/MAStorage.sol";

library LibSigner {
	function getSigner() internal view  returns (address) {
		return MAStorage.layout().signer == address(0) ? msg.sender : MAStorage.layout().signer;
	}
}
