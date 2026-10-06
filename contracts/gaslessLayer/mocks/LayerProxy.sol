// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Thin ERC1967 (UUPS) proxy, declared here so Hardhat emits it as a first-class artifact
///         (`getContractFactory("LayerProxy")`). Hardhat 3 does not emit artifacts for
///         transitively-imported dependency contracts, so the OZ proxy must be wrapped to be
///         deployable from tests and scripts.
contract LayerProxy is ERC1967Proxy {
	constructor(address implementation, bytes memory data) payable ERC1967Proxy(implementation, data) {}
}
