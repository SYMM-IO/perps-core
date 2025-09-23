// contracts/facets/ADL/IADLFacet.sol
// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./IADLEvents.sol";
import "../../storages/MuonStorage.sol";

interface IADLFacet is IADLEvents {
	function adlClosePositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external;
}
