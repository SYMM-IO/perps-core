import hre from "hardhat"
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"

async function main() {
	let facets = {
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
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
