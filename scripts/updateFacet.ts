import { FacetCutAction, getSelectors } from "../tasks/utils/diamondCut.js"
import { ethers } from "../test/helpers/hardhat-connection.js"

const addr = ""
const facetAddr = ""
const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", addr)
const NewFacet = await ethers.getContractFactory("PartyAFacet")
const selectors = getSelectors(ethers, NewFacet).selectors
await diamondCutFacet.diamondCut(
	[
		{
			facetAddress: facetAddr,
			action: FacetCutAction.Replace,
			functionSelectors: selectors,
		},
	],
	ethers.ZeroAddress,
	"0x",
)
