import { ethers } from "../test/helpers/hardhat-connection.js"

const symmioAddress = ""
const facet = await ethers.getContractAt("PartyBFacet", symmioAddress)
// console.log(await facet.settleUpnl(564))
