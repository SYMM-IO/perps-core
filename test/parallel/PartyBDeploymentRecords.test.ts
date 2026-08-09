import { expect } from "chai"
import { Interface } from "ethers"
import fs from "node:fs"
import path from "node:path"

import { createCheckpoint } from "../../tasks/deploy/checkpoint.js"
import { PARTYB_DEPLOYMENT_FILE } from "../../tasks/deploy/constants.js"
import { createSymmioPartyBVerificationRecords, deploySymmioPartyB } from "../../tasks/deploy/partyB.js"
import { getDataDir, readData, resetDataScope, setDataScope, writeData } from "../../tasks/utils/fs.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

describe("SymmioPartyB deployment verification records", function () {
	const admin = "0x1111111111111111111111111111111111111111"
	const symmio = "0x2222222222222222222222222222222222222222"
	const implementation = "0x3333333333333333333333333333333333333333"
	const proxy = "0x4444444444444444444444444444444444444444"
	const factory = {
		interface: new Interface(["function initialize(address admin, address symmioAddress_)"]),
	}
	const testChainId = 98_601_337
	const checkpointPath = path.resolve(`tasks/data/checkpoints/checkpoint-${testChainId}.json`)

	after(function () {
		fs.rmSync(path.resolve(`tasks/data/${testChainId}-fork`), { recursive: true, force: true })
		fs.rmSync(path.resolve("tasks/data/31337-fork/partyb.json"), { force: true })
		fs.rmSync(checkpointPath, { force: true })
		resetDataScope()
	})

	it("records the implementation and LocalERC1967Proxy with exact FQNs and constructor arguments", function () {
		const initData = factory.interface.encodeFunctionData("initialize", [admin, symmio])

		expect(createSymmioPartyBVerificationRecords(factory, { implementation, proxy }, [admin, symmio])).to.deep.equal([
			{
				name: "contracts/helpers/accounts/SymmioPartyB.sol:SymmioPartyB",
				address: implementation,
				constructorArguments: [],
			},
			{
				name: "contracts/helpers/utils/LocalERC1967Proxy.sol:LocalERC1967Proxy",
				address: proxy,
				constructorArguments: [implementation, initData],
			},
		])
	})

	it("refuses to emit an unverifiable proxy-only record", function () {
		expect(() => createSymmioPartyBVerificationRecords(factory, { proxy }, [admin, symmio])).to.throw("ERC1967 implementation address is unavailable")
	})

	it("writes and reconstructs the exact record pair when resuming from a checkpoint", async function () {
		setDataScope(testChainId, { simulated: true })
		const [deployer, symmioSigner] = await ethers.getSigners()
		const deployerAddress = await deployer.getAddress()
		const symmioAddress = await symmioSigner.getAddress()
		const checkpoint = createCheckpoint("party-b-record-test", testChainId)

		const first = await deploySymmioPartyB(hre, {
			admin: deployerAddress,
			symmioAddress,
			checkpoint,
			logData: true,
		})
		const proxyAddress = await first.getAddress()
		const implementationAddress = checkpoint.contracts.symmioPartyB?.implementation
		expect(implementationAddress).to.be.a("string")

		// Simulate a crash-era/stale file while retaining the durable checkpoint.
		writeData(PARTYB_DEPLOYMENT_FILE, [
			{
				name: "SymmioPartyBProxy",
				address: proxyAddress,
				constructorArguments: [deployerAddress, symmioAddress],
			},
		])

		const resumed = await deploySymmioPartyB(hre, {
			admin: deployerAddress,
			symmioAddress,
			checkpoint,
			logData: true,
		})
		expect(await resumed.getAddress()).to.equal(proxyAddress)

		const records = readData(PARTYB_DEPLOYMENT_FILE)
		const expectedInitData = (await ethers.getContractFactory("SymmioPartyB")).interface.encodeFunctionData("initialize", [
			deployerAddress,
			symmioAddress,
		])
		expect(records).to.deep.equal([
			{
				name: "contracts/helpers/accounts/SymmioPartyB.sol:SymmioPartyB",
				address: implementationAddress,
				constructorArguments: [],
			},
			{
				name: "contracts/helpers/utils/LocalERC1967Proxy.sol:LocalERC1967Proxy",
				address: proxyAddress,
				constructorArguments: [implementationAddress, expectedInitData],
			},
		])
		expect(checkpoint.contracts.symmioPartyB?.constructorArgs).to.deep.equal([implementationAddress, expectedInitData])
		expect(await ethers.provider.getCode(implementationAddress!)).not.to.equal("0x")
		const providerChainId = Number((await ethers.provider.getNetwork()).chainId)
		expect(getDataDir()).to.equal(`./tasks/data/${providerChainId}-fork`)
	})
})
