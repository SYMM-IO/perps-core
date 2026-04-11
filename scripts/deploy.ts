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

const facetName = "Multicall3"

const Facet = await ethers.getContractFactory(facetName)
const facet = await Facet.deploy()
await facet.waitForDeployment()

const address = await facet.getAddress()

console.log(`Facet deployed: ${facetName} -> ${address}`)
