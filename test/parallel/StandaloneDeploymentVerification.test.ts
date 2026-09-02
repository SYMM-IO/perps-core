import { expect } from "chai"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { checkStandaloneDeployment } from "../../tasks/deploy/checkStandaloneDeployment.js"
import { deployProxy } from "../../utils/upgrades-shim.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

async function expectFailure(action: Promise<unknown>, message: RegExp): Promise<void> {
	let failure: unknown
	try {
		await action
	} catch (error) {
		failure = error
	}
	expect(failure).to.be.instanceOf(Error)
	expect((failure as Error).message).to.match(message)
}

describe("StandaloneDeploymentVerification", function () {
	it("independently verifies FeeDistributor initialization and rejects a wrong expected receiver", async function () {
		const [admin, receiver, wrongReceiver] = await ethers.getSigners()
		const MockSymmio = await ethers.getContractFactory("MockSymmio")
		const symmio = await MockSymmio.deploy()
		const Factory = await ethers.getContractFactory("SymmioFeeDistributor")
		const share = ethers.parseEther("0.4")
		const feeDistributor = await deployProxy(hre, Factory, [admin.address, await symmio.getAddress(), receiver.address, share], { kind: "erc1967" })

		expect(
			await checkStandaloneDeployment(hre, {
				kind: "feeDistributor",
				phase: "poststate",
				address: await feeDistributor.getAddress(),
				symmioAddress: await symmio.getAddress(),
				admin: admin.address,
				symmioShareReceiver: receiver.address,
				symmioShare: share.toString(),
			}),
		).to.equal(await feeDistributor.getAddress())

		await expectFailure(
			checkStandaloneDeployment(hre, {
				kind: "feeDistributor",
				phase: "poststate",
				address: await feeDistributor.getAddress(),
				symmioAddress: await symmio.getAddress(),
				admin: admin.address,
				symmioShareReceiver: wrongReceiver.address,
				symmioShare: share.toString(),
			}),
			/FeeDistributor receiver/,
		)
	})

	it("verifies MultiAccount roles, configuration, proxy implementation, and PartyA bytecode", async function () {
		const [admin] = await ethers.getSigners()
		const MockSymmio = await ethers.getContractFactory("MockSymmio")
		const symmio = await MockSymmio.deploy()
		const PartyA = await ethers.getContractFactory("SymmioPartyA")
		const Factory = await ethers.getContractFactory("MultiAccount")
		const multiAccount = await deployProxy(hre, Factory, [admin.address, await symmio.getAddress(), PartyA.bytecode], { kind: "erc1967" })

		expect(
			await checkStandaloneDeployment(hre, {
				kind: "multiAccount",
				phase: "poststate",
				address: await multiAccount.getAddress(),
				symmioAddress: await symmio.getAddress(),
				admin: admin.address,
			}),
		).to.equal(await multiAccount.getAddress())
	})

	it("loads the scoped Multicall deployment record and executes a read against the deployed contract", async function () {
		const Factory = await ethers.getContractFactory("Multicall3")
		const multicall = await Factory.deploy()
		await multicall.waitForDeployment()
		const originalDirectory = process.cwd()
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-standalone-verification-"))
		try {
			process.chdir(temporaryDirectory)
			const recordDirectory = path.join(temporaryDirectory, "tasks", "data", "31337-fork")
			fs.mkdirSync(recordDirectory, { recursive: true })
			fs.writeFileSync(
				path.join(recordDirectory, "deployed.json"),
				`${JSON.stringify([{ name: "Multicall3", address: await multicall.getAddress(), constructorArguments: [] }], null, 2)}\n`,
			)
			expect(
				await checkStandaloneDeployment(hre, {
					kind: "multicall",
					phase: "poststate",
				}),
			).to.equal(await multicall.getAddress())
		} finally {
			process.chdir(originalDirectory)
			fs.rmSync(temporaryDirectory, { recursive: true, force: true })
		}
	})
})
