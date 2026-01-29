// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
*
* Implementation of a diamond.
/******************************************************************************/

import { LibDiamond } from "../core/libraries/LibDiamond.sol";
import { IDiamondLoupe } from "../core/facets/DiamondLoup/IDiamondLoupe.sol";
import { IDiamondCut } from "../core/facets/DiamondCut/IDiamondCut.sol";
import { IERC165 } from "../core/interfaces/IERC165.sol";

contract DiamondInit {
	function init() external {
		LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
		ds.supportedInterfaces[type(IERC165).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
	}
}
