import { ethers } from "../test/helpers/hardhat-connection.js"

const factory = await ethers.getContractFactory("SignatureVerifier")
const contract = await factory.deploy()
await contract.waitForDeployment()

const address = await contract.getAddress()
console.log(`SignatureVerifier deployed at: ${address}`)
