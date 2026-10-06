import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"

import type { MockSymmio, MockToken, SymmioFeeDistributor, MultiAccount, SymmioPartyB, SymmioGlobalRelayer } from "../src/types/index.js"
import { deployProxy } from "../utils/upgrades-shim.js"
import { ethers, hre } from "./helpers/hardhat-connection.js"

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

async function getImplementation(proxyAddress: string): Promise<string> {
	const value = await ethers.provider.getStorage(proxyAddress, IMPLEMENTATION_SLOT)
	return ethers.getAddress("0x" + value.slice(26))
}

export function shouldBehaveLikeUUPSUpgradeable() {
	describe("UUPS Upgrade", function () {
		let admin: HardhatEthersSigner
		let nonAdmin: HardhatEthersSigner

		beforeEach(async function () {
			;[, admin, nonAdmin] = await ethers.getSigners()
		})

		describe("SymmioFeeDistributor", function () {
			let feeDistributor: SymmioFeeDistributor
			let mockSymmio: MockSymmio
			let mockToken: MockToken

			beforeEach(async function () {
				const MockSymmio = await ethers.getContractFactory("MockSymmio")
				mockSymmio = await MockSymmio.deploy()

				const MockToken = await ethers.getContractFactory("MockToken")
				mockToken = await MockToken.deploy("Mock Token", "MTK")
				await mockSymmio.setCollateral(await mockToken.getAddress())

				const Factory = await ethers.getContractFactory("SymmioFeeDistributor")
				feeDistributor = (await deployProxy(hre, Factory, [admin.address, await mockSymmio.getAddress(), admin.address, ethers.parseEther("1")], {
					kind: "erc1967",
				})) as any
			})

			it("admin can upgrade implementation", async function () {
				const proxyAddr = await feeDistributor.getAddress()
				const implBefore = await getImplementation(proxyAddr)

				// Deploy new implementation
				const NewFactory = await ethers.getContractFactory("SymmioFeeDistributor")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()

				await feeDistributor.connect(admin).upgradeTo(await newImpl.getAddress())

				const implAfter = await getImplementation(proxyAddr)
				expect(implAfter).to.not.equal(implBefore)
				expect(implAfter).to.equal(await newImpl.getAddress())
			})

			it("non-admin upgrade reverts", async function () {
				const NewFactory = await ethers.getContractFactory("SymmioFeeDistributor")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()

				await expect(feeDistributor.connect(nonAdmin).upgradeTo(await newImpl.getAddress())).to.be.reverted
			})

			it("state persists after upgrade", async function () {
				const symmioAddr = await feeDistributor.symmioAddress()

				const NewFactory = await ethers.getContractFactory("SymmioFeeDistributor")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()
				await feeDistributor.connect(admin).upgradeTo(await newImpl.getAddress())

				expect(await feeDistributor.symmioAddress()).to.equal(symmioAddr)
			})
		})

		describe("MultiAccount", function () {
			let multiAccount: MultiAccount

			beforeEach(async function () {
				const SymmioPartyA = await ethers.getContractFactory("SymmioPartyA")
				const Factory = await ethers.getContractFactory("MultiAccount")
				multiAccount = (await deployProxy(hre, Factory, [admin.address, ethers.ZeroAddress, SymmioPartyA.bytecode], { kind: "erc1967" })) as any
			})

			it("admin can upgrade implementation", async function () {
				const proxyAddr = await multiAccount.getAddress()
				const implBefore = await getImplementation(proxyAddr)

				const NewFactory = await ethers.getContractFactory("MultiAccount")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()

				await multiAccount.connect(admin).upgradeTo(await newImpl.getAddress())

				const implAfter = await getImplementation(proxyAddr)
				expect(implAfter).to.not.equal(implBefore)
				expect(implAfter).to.equal(await newImpl.getAddress())
			})

			it("non-admin upgrade reverts", async function () {
				const NewFactory = await ethers.getContractFactory("MultiAccount")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()

				await expect(multiAccount.connect(nonAdmin).upgradeTo(await newImpl.getAddress())).to.be.reverted
			})

			it("state persists after upgrade", async function () {
				const saltBefore = await multiAccount.saltCounter()

				const NewFactory = await ethers.getContractFactory("MultiAccount")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()
				await multiAccount.connect(admin).upgradeTo(await newImpl.getAddress())

				expect(await multiAccount.saltCounter()).to.equal(saltBefore)
			})
		})

		describe("SymmioPartyB", function () {
			let symmioPartyB: SymmioPartyB

			beforeEach(async function () {
				const Factory = await ethers.getContractFactory("SymmioPartyB")
				symmioPartyB = (await deployProxy(hre, Factory, [admin.address, ethers.ZeroAddress], { kind: "erc1967" })) as any
			})

			it("admin can upgrade implementation", async function () {
				const proxyAddr = await symmioPartyB.getAddress()
				const implBefore = await getImplementation(proxyAddr)

				const NewFactory = await ethers.getContractFactory("SymmioPartyB")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()

				await symmioPartyB.connect(admin).upgradeTo(await newImpl.getAddress())

				const implAfter = await getImplementation(proxyAddr)
				expect(implAfter).to.not.equal(implBefore)
				expect(implAfter).to.equal(await newImpl.getAddress())
			})

			it("non-admin upgrade reverts", async function () {
				const NewFactory = await ethers.getContractFactory("SymmioPartyB")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()

				await expect(symmioPartyB.connect(nonAdmin).upgradeTo(await newImpl.getAddress())).to.be.reverted
			})

			it("state persists after upgrade", async function () {
				const symmioAddr = await symmioPartyB.symmioAddress()

				const NewFactory = await ethers.getContractFactory("SymmioPartyB")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()
				await symmioPartyB.connect(admin).upgradeTo(await newImpl.getAddress())

				expect(await symmioPartyB.symmioAddress()).to.equal(symmioAddr)
			})
		})

		describe("SymmioGlobalRelayer", function () {
			let relayer: SymmioGlobalRelayer

			beforeEach(async function () {
				const Factory = await ethers.getContractFactory("SymmioGlobalRelayer")
				relayer = (await deployProxy(hre, Factory, [admin.address], { kind: "erc1967" })) as any
			})

			it("admin can upgrade implementation", async function () {
				const proxyAddr = await relayer.getAddress()
				const implBefore = await getImplementation(proxyAddr)

				const NewFactory = await ethers.getContractFactory("SymmioGlobalRelayer")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()

				await relayer.connect(admin).upgradeTo(await newImpl.getAddress())

				const implAfter = await getImplementation(proxyAddr)
				expect(implAfter).to.not.equal(implBefore)
				expect(implAfter).to.equal(await newImpl.getAddress())
			})

			it("non-admin upgrade reverts", async function () {
				const NewFactory = await ethers.getContractFactory("SymmioGlobalRelayer")
				const newImpl = await NewFactory.deploy()
				await newImpl.waitForDeployment()

				await expect(relayer.connect(nonAdmin).upgradeTo(await newImpl.getAddress())).to.be.reverted
			})
		})
	})
}
