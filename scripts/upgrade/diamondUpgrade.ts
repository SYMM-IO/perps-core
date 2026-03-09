import { FacetCutAction } from "../../tasks/utils/diamondCut.js"
import { ethers } from "../../test/helpers/hardhat-connection.js"

const diamondAddress = ""
const [deployer] = await ethers.getSigners()

const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondAddress, deployer)
// Prepare _init and _calldata (set to zero address and empty bytes for this example)
const _init = ethers.ZeroAddress
const _calldata = "0x"

const diamondCut: any[] = [
	{
		facetAddress: "",
		action: FacetCutAction.Add,
		functionSelectors: [""],
	},
]

console.log(diamondCutFacet.interface.encodeFunctionData("diamondCut", [diamondCut, _init, _calldata]))
