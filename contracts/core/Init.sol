// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
*
* Implementation of a diamond.
/******************************************************************************/

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { IDiamondLoupe } from "../diamond/facets/DiamondLoup/IDiamondLoupe.sol";
import { IDiamondCut } from "../diamond/facets/DiamondCut/IDiamondCut.sol";
import { IERC165 } from "../diamond/interfaces/IERC165.sol";

contract Init {
	function init() external {
		LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
		ds.supportedInterfaces[type(IERC165).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
	}
}
