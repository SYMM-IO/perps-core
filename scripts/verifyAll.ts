import hre from "hardhat"
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"

// Import to initialize the hardhat connection
import "../test/helpers/hardhat-connection.js"

const facets = {
	AccountFacet: "",
	ControlFacet: "",
	DiamondLoupeFacet: "",
	PartyALiquidationFacet: "",
	PartyBLiquidationFacet: "",
	PartyAFacet: "",
	PartyBFacet: "",
	ViewFacet: "",
	FundingRateFacet: "",
}
for (const facet in facets) {
	if (!facets.hasOwnProperty(facet)) continue
	const facetAddr = (facets as any)[facet]
	console.log(`Verifying ${facet} with impl in ${facetAddr}`)
	await verifyContract(
		{
			address: facetAddr,
			constructorArgs: [],
		},
		hre,
	)
}
