import { FacetCutAction, getSelectors } from "../tasks/utils/diamondCut.js"
import { ethers } from "../test/helpers/hardhat-connection.js"

// Quick facet deploy helper.
// Env/args:
//   FACET (or argv[2]) - facet contract path/name (e.g., contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet)
//   ACTION (optional)  - Add | Replace | Remove (default: Add) for the sample cut payload
//   SELECTORS (optional) - comma-separated function names to include; defaults to all
//
// Example:
//   FACET=contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet \
//   ACTION=Add \
//   ts-node scripts/deploy.ts

const facetName = process.env.FACET || process.argv[2]
if (!facetName) {
	throw new Error("Missing facet name. Usage: FACET=contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet ts-node scripts/deploy.ts")
}

const actionEnv = (process.env.ACTION || "Add").toLowerCase()
const action = actionEnv === "replace" ? FacetCutAction.Replace : actionEnv === "remove" ? FacetCutAction.Remove : FacetCutAction.Add

const Facet = await ethers.getContractFactory(facetName)
const facet = await Facet.deploy()
await facet.waitForDeployment()

const address = await facet.getAddress()

// If SELECTORS env is set, only include those (comma-separated function names); otherwise use all selectors
let selectors = getSelectors(ethers, Facet).selectors
if (process.env.SELECTORS) {
	const names = process.env.SELECTORS.split(",").map(s => s.trim())
	selectors = getSelectors(ethers, Facet).get(names)
}

console.log(`Facet deployed: ${facetName} -> ${address}`)
console.log("Function selectors:", selectors)
console.log(
	`Diamond cut entry (${FacetCutAction[action]}):`,
	JSON.stringify(
		[
			{
				facetAddress: address,
				action,
				functionSelectors: selectors,
			},
		],
		null,
		2,
	),
)
