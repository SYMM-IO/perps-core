import { expect } from "chai"

import { MiningBudgetExceeded, expectedAttempts, mineCreate2Salt } from "../tasks/utils/create2Mining.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"

async function deployCreate2FactoryFixture() {
	const [deployer] = await ethers.getSigners()
	const factory = await ethers.getContractFactory("Create2Factory")
	const create2Factory = await factory.connect(deployer).deploy(deployer.address, deployer.address)
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

			const predictedAddress = await create2Factory["getAddress(bytes,uint256)"](bytecode, salt)
			const offchainPredicted = ethers.getCreate2Address(factoryAddress, salt, bytecodeHash)
			expect(predictedAddress.toLowerCase()).to.equal(offchainPredicted.toLowerCase())

			await create2Factory.deploy(bytecode, salt)

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
			const result = mineCreate2Salt(factoryAddress, initCodeHex, { prefix })
			expect(result.address.toLowerCase().startsWith("0x" + prefix)).to.be.true
			expect(result.attempts).to.be.greaterThan(0)

			// Deploy through factory
			await create2Factory.deploy(initCode, result.salt)

			// Verify Diamond has code at predicted address
			const code = await ethers.provider.getCode(result.address)
			expect(code).to.not.equal("0x")

			// Verify diamondCut function is callable (the only facet registered in constructor)
			const diamond = await ethers.getContractAt("IDiamondCut", result.address)
			// An empty diamond cut should succeed (no-op)
			await expect(diamond.connect(deployer).diamondCut([], ethers.ZeroAddress, "0x")).to.not.be.reverted
		})

		it("mines a suffix-only pattern and deploys to the mined address", async function () {
			const { create2Factory, deployer } = await loadFixture(deployCreate2FactoryFixture)
			const factoryAddress = await create2Factory.getAddress()

			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			const initCodeHex = ethers.hexlify(DiamondCutFactory.bytecode)

			const result = mineCreate2Salt(factoryAddress, initCodeHex, { suffix: "ab" })
			expect(result.address.toLowerCase().endsWith("ab")).to.be.true
			expect(result.address).to.equal(ethers.getCreate2Address(factoryAddress, result.salt, ethers.keccak256(initCodeHex)))

			await create2Factory.connect(deployer).deploy(initCodeHex, result.salt)
			expect(await ethers.provider.getCode(result.address)).to.not.equal("0x")
		})

		it("mines a combined prefix and suffix pattern", async function () {
			const { create2Factory } = await loadFixture(deployCreate2FactoryFixture)
			const factoryAddress = await create2Factory.getAddress()
			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			const initCodeHex = ethers.hexlify(DiamondCutFactory.bytecode)

			const result = mineCreate2Salt(factoryAddress, initCodeHex, { prefix: "a", suffix: "b" })
			const body = result.address.toLowerCase().slice(2)
			expect(body.startsWith("a")).to.be.true
			expect(body.endsWith("b")).to.be.true
		})

		it("returns the same salt for the same factory and init code", async function () {
			const { create2Factory } = await loadFixture(deployCreate2FactoryFixture)
			const factoryAddress = await create2Factory.getAddress()
			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			const initCodeHex = ethers.hexlify(DiamondCutFactory.bytecode)

			const first = mineCreate2Salt(factoryAddress, initCodeHex, { suffix: "cd" })
			const second = mineCreate2Salt(factoryAddress, initCodeHex, { suffix: "cd" })
			expect(second.salt).to.equal(first.salt)
			expect(second.address).to.equal(first.address)
		})

		it("throws MiningBudgetExceeded instead of searching forever", async function () {
			const { create2Factory } = await loadFixture(deployCreate2FactoryFixture)
			const factoryAddress = await create2Factory.getAddress()
			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			const initCodeHex = ethers.hexlify(DiamondCutFactory.bytecode)

			expect(() => mineCreate2Salt(factoryAddress, initCodeHex, { prefix: "abcdef" }, { maxAttempts: 50 })).to.throw(MiningBudgetExceeded)
		})

		it("computes expected attempts as 16 to the power of constrained hex characters", function () {
			expect(expectedAttempts({ suffix: "86" })).to.equal(256)
			expect(expectedAttempts({ prefix: "573310" })).to.equal(16_777_216)
			expect(expectedAttempts({ prefix: "57", suffix: "86" })).to.equal(65_536)
			expect(expectedAttempts({})).to.equal(1)
		})

		it("rejects an empty pattern", async function () {
			const { create2Factory } = await loadFixture(deployCreate2FactoryFixture)
			const factoryAddress = await create2Factory.getAddress()
			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			expect(() => mineCreate2Salt(factoryAddress, ethers.hexlify(DiamondCutFactory.bytecode), {})).to.throw(/requires a prefix or a suffix/)
		})

		it("should revert when deploying with the same salt and bytecode twice", async function () {
			const { create2Factory } = await loadFixture(deployCreate2FactoryFixture)

			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")
			const bytecode = DiamondCutFactory.bytecode
			const salt = ethers.zeroPadValue("0x42", 32)

			await create2Factory.deploy(bytecode, salt)
			await expect(create2Factory.deploy(bytecode, salt)).to.be.reverted
		})

		it("allows only DEPLOYER_ROLE holders to deploy", async function () {
			const { create2Factory } = await loadFixture(deployCreate2FactoryFixture)
			const [, outsider] = await ethers.getSigners()
			const DiamondCutFactory = await ethers.getContractFactory("DiamondCutFacet")

			await expect(create2Factory.connect(outsider).deploy(DiamondCutFactory.bytecode, 7n)).to.be.revertedWith(
				"AccessControl: account " + outsider.address.toLowerCase() + " is missing role " + (await create2Factory.DEPLOYER_ROLE()),
			)
		})
	})
}
