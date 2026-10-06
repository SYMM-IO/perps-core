import { expect } from "chai"

import { mineCreate2Salt } from "../tasks/utils/create2Mining.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"

async function deployCreate2FactoryFixture() {
	const [deployer] = await ethers.getSigners()
	const factory = await ethers.getContractFactory("Create2Factory")
	const create2Factory = await factory.connect(deployer).deploy()
	await create2Factory.waitForDeployment()
	return { create2Factory, deployer }
}

export function shouldBehaveLikeCreate2Factory(): void {
	describe("Create2Factory", function () {
		it("should deploy a contract to the predicted address", async function () {
			const { create2Factory, deployer } = await loadFixture(deployCreate2FactoryFixture)
			const factoryAddress = await create2Factory.getAddress()

			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			const bytecode = DiamondCutFactory.bytecode
			const salt = ethers.zeroPadValue("0x01", 32)
			const bytecodeHash = ethers.keccak256(bytecode)

			const predictedAddress = await create2Factory.computeAddress(salt, bytecodeHash)
			const offchainPredicted = ethers.getCreate2Address(factoryAddress, salt, bytecodeHash)
			expect(predictedAddress.toLowerCase()).to.equal(offchainPredicted.toLowerCase())

			await create2Factory.deploy(salt, bytecode)

			const code = await ethers.provider.getCode(predictedAddress)
			expect(code).to.not.equal("0x")
		})

		it("should deploy Diamond via CREATE2 to a vanity address", async function () {
			const { create2Factory, deployer } = await loadFixture(deployCreate2FactoryFixture)
			const factoryAddress = await create2Factory.getAddress()

			// Deploy DiamondCutFacet first (Diamond needs it)
			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			const diamondCutFacet = await DiamondCutFactory.deploy()
			await diamondCutFacet.waitForDeployment()
			const diamondCutFacetAddress = await diamondCutFacet.getAddress()

			// Build Diamond init code
			const DiamondFactory = await ethers.getContractFactory("Diamond")
			const constructorArgs = [deployer.address, diamondCutFacetAddress]
			const initCode = ethers.concat([DiamondFactory.bytecode, DiamondFactory.interface.encodeDeploy(constructorArgs)])
			const initCodeHex = ethers.hexlify(initCode)

			// Mine a short prefix (2 hex chars) for fast test
			const prefix = "00"
			const result = mineCreate2Salt(factoryAddress, initCodeHex, prefix)
			expect(result.address.toLowerCase().startsWith("0x" + prefix)).to.be.true
			expect(result.attempts).to.be.greaterThan(0)

			// Deploy through factory
			await create2Factory.deploy(result.salt, initCode)

			// Verify Diamond has code at predicted address
			const code = await ethers.provider.getCode(result.address)
			expect(code).to.not.equal("0x")

			// Verify diamondCut function is callable (the only facet registered in constructor)
			const diamond = await ethers.getContractAt("IDiamondCut", result.address)
			// An empty diamond cut should succeed (no-op)
			await expect(diamond.connect(deployer).diamondCut([], ethers.ZeroAddress, "0x")).to.not.be.reverted
		})

		it("should revert when deploying with the same salt and bytecode twice", async function () {
			const { create2Factory } = await loadFixture(deployCreate2FactoryFixture)

			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			const bytecode = DiamondCutFactory.bytecode
			const salt = ethers.zeroPadValue("0x42", 32)

			await create2Factory.deploy(salt, bytecode)
			await expect(create2Factory.deploy(salt, bytecode)).to.be.reverted
		})
	})
}
