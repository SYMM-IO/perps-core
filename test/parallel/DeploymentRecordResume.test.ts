import { expect } from "chai"
import fs from "node:fs"
import path from "node:path"

import { createCheckpoint } from "../../tasks/deploy/checkpoint.js"
import {
	DEPLOYMENT_LOG_FILE,
	INSTANTLAYER_DEPLOYMENT_FILE,
	STABLECOIN_DEPLOYMENT_FILE,
	SYMBOLMANAGER_DEPLOYMENT_FILE,
} from "../../tasks/deploy/constants.js"
import { deployInstantLayer } from "../../tasks/deploy/instantLayer.js"
import { deploySignatureVerifier } from "../../tasks/deploy/signatureVerifier.js"
import { deployStablecoin } from "../../tasks/deploy/stablecoin.js"
import { deploySymbolManager } from "../../tasks/deploy/symbolManager.js"
import { readData, resetDataScope, setDataScope, writeData } from "../../tasks/utils/fs.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

describe("checkpoint deployment-record recovery", function () {
	const testChainId = 98_601_338
	const checkpointPath = path.resolve(`tasks/data/checkpoints/checkpoint-${testChainId}.json`)

	after(function () {
		fs.rmSync(path.resolve(`tasks/data/${testChainId}-fork`), { recursive: true, force: true })
		fs.rmSync(checkpointPath, { force: true })
		resetDataScope()
	})

	it("rebuilds every non-proxy verification record after a checkpoint/file crash window", async function () {
		setDataScope(testChainId, { simulated: true })
		const [adminSigner, symmioSigner] = await ethers.getSigners()
		const admin = await adminSigner.getAddress()
		const symmio = await symmioSigner.getAddress()
		const checkpoint = createCheckpoint("deployment-record-resume-test", testChainId)

		const stablecoin = await deployStablecoin(hre, { checkpoint, logData: true })
		const verifier = await deploySignatureVerifier(hre, { admin, checkpoint, logData: true })
		const instantLayer = await deployInstantLayer(hre, { symmioaddress: symmio, admin, checkpoint, logData: true })
		const symbolManager = await deploySymbolManager(hre, { symmioAddress: symmio, admin, checkpoint, logData: true })

		for (const file of [STABLECOIN_DEPLOYMENT_FILE, DEPLOYMENT_LOG_FILE, INSTANTLAYER_DEPLOYMENT_FILE, SYMBOLMANAGER_DEPLOYMENT_FILE]) {
			writeData(file, [])
		}

		await deployStablecoin(hre, { checkpoint, logData: true })
		await deploySignatureVerifier(hre, { admin, checkpoint, logData: true })
		await deployInstantLayer(hre, { symmioaddress: symmio, admin, checkpoint, logData: true })
		await deploySymbolManager(hre, { symmioAddress: symmio, admin, checkpoint, logData: true })

		expect(readData(STABLECOIN_DEPLOYMENT_FILE)).to.deep.equal([
			{ name: "FakeStablecoin", address: await stablecoin.getAddress(), constructorArguments: [] },
		])
		expect(readData(DEPLOYMENT_LOG_FILE)).to.deep.equal([
			{ name: "MuonSignatureVerifier", address: await verifier.getAddress(), constructorArguments: [admin] },
		])
		const instantLayerRecords = readData(INSTANTLAYER_DEPLOYMENT_FILE) as Array<{ name: string; address: string; constructorArguments: unknown[] }>
		const diamondRecord = instantLayerRecords.find(record => record.name === "Diamond")!
		expect(diamondRecord.address).to.equal(await instantLayer.getAddress())
		expect(diamondRecord.constructorArguments[0]).to.equal(admin)
		expect(instantLayerRecords.map(record => record.name)).to.deep.equal([
			"DiamondCutFacet",
			"Diamond",
			"contracts/instantLayer/Init.sol:Init",
			"contracts/instantLayer/facets/Control/ControlFacet.sol:ControlFacet",
			"contracts/instantLayer/facets/View/ViewFacet.sol:ViewFacet",
			"contracts/instantLayer/facets/Delegation/DelegationFacet.sol:DelegationFacet",
			"contracts/instantLayer/facets/Execution/ExecutionFacet.sol:ExecutionFacet",
			"contracts/diamond/facets/DiamondLoup/DiamondLoupeFacet.sol:DiamondLoupeFacet",
		])
		expect(readData(SYMBOLMANAGER_DEPLOYMENT_FILE)).to.deep.equal([
			{ name: "SymmioSymbolManager", address: await symbolManager.getAddress(), constructorArguments: [symmio, admin] },
		])
	})
})
