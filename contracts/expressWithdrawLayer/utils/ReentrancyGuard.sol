// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibErrors } from "../libraries/LibErrors.sol";
import { GlobalStorage } from "../storages/GlobalStorage.sol";

abstract contract ReentrancyGuard {
	modifier nonReentrant() {
		GlobalStorage.Layout storage s = GlobalStorage.layout();
		if (s.reentrancyStatus == 1) revert LibErrors.Reentrancy();
		s.reentrancyStatus = 1;
		_;
		s.reentrancyStatus = 0;
	}
}
