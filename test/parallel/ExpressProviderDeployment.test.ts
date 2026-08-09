import { expect } from "chai"

import { deployExpressProvider } from "../../tasks/deploy/expressWithdrawLayerDiamond.js"
import connection, { ethers, hre } from "../helpers/hardhat-connection.js"

describe("ExpressProvider deployment helper", function () {
	it("installs the cut as the deployer, then starts a two-step handover to a distinct admin", async function () {
		const [deployer, finalAdmin] = await ethers.getSigners()
		const collateral = await ethers.deployContract("FakeStablecoin")
		const symmio = await ethers.deployContract("MockSymmio")
		await (await symmio.setCollateral(await collateral.getAddress())).wait()

		const provider = await deployExpressProvider(hre, connection, {
			admin: finalAdmin.address,
			symmio: await symmio.getAddress(),
			collateral: await collateral.getAddress(),
		})

		expect(await provider.owner()).to.equal(deployer.address)
		expect(await provider.pendingOwner()).to.equal(finalAdmin.address)
		expect(await provider.hasRole(ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE")), finalAdmin.address)).to.equal(true)

		await (await provider.connect(finalAdmin).acceptOwnership()).wait()
		expect(await provider.owner()).to.equal(finalAdmin.address)
		expect(await provider.pendingOwner()).to.equal(ethers.ZeroAddress)
	})
})
