import { ethers } from "../test/helpers/hardhat-connection.js"

const facetName = ""
const Facet = await ethers.getContractFactory(facetName)
const facet = await Facet.deploy()

await facet.waitForDeployment()

console.log(`${facetName} deployed: ${await facet.getAddress()}`)
