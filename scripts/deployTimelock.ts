import hre from "hardhat"
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { ethers } from "../test/helpers/hardhat-connection.js"

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

const [deployer] = await ethers.getSigners()

console.log("Deploying contracts with the account:", deployer.address)

const minDelay = 3 * 24 * 60 * 60 // 3 Days 259200

const multiSig = ""
const proposers = [multiSig]
const executors = [multiSig]

const TimelockController = await ethers.getContractFactory("SymmioTimelockController")
const timelock = await TimelockController.deploy(minDelay, proposers, executors, multiSig)

await timelock.waitForDeployment()

console.log("TimelockController deployed to:", await timelock.getAddress())

await sleep(30000)

await verifyContract(
	{
		address: await timelock.getAddress(),
		constructorArgs: [minDelay, proposers, executors, multiSig],
	},
	hre,
)
