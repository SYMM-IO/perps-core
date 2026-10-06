import { expect } from "chai"

import { operationDigest } from "../../deployment-tooling/operations/inputs.js"
import { captureMuonConfiguration, verifyMuonConfiguration, MUON_UPGRADE_ABI } from "../../deployment-tooling/operations/muon-upgrade.js"
import { ethers } from "../helpers/hardhat-connection.js"

describe("Muon upgrade configuration against the deployed verifier", function () {
	it("reads exact key/gateway permissions and catches a setter changing a denied category", async function () {
		const [admin, gateway, coreIdentity] = await ethers.getSigners()
		const verifier = await (await ethers.getContractFactory("MuonSignatureVerifier")).deploy(admin.address)
		await verifier.addPublicKey({ x: 123, parity: 0 })
		await verifier.addGatewaySigner(gateway.address)
		await verifier.setPublicKeyPermissions({ x: 123, parity: 0 }, [0], true)
		await verifier.setGatewaySignerPermissions(gateway.address, [0], true)
		const checkpoint = async () => {
			const block = (await ethers.provider.getBlock("latest"))!
			return { blockNumber: block.number, blockHash: block.hash! }
		}
		const coreABI = new ethers.Interface(MUON_UPGRADE_ABI)
		// Only Core's configuration reader is modelled. Every verifier read uses the real EVM and pinned historical state.
		const provider = {
			send: async (method: string, args: any[]) => {
				if (method === "eth_getCode" && args[0] === coreIdentity.address) return "0x6000"
				if (method === "eth_call" && args[0].to === coreIdentity.address) {
					const name = coreABI.parseTransaction({ data: args[0].data })!.name
					const values: Record<string, any[]> = {
						getSignatureVerifier: [verifier.target],
						getMuonIds: [7],
						getMuonConfig: [60, 30],
						getMuonFunctionUpnlValidTime: [60, false],
					}
					return coreABI.encodeFunctionResult(name, values[name])
				}
				return ethers.provider.send(method, args)
			},
		}
		const profile = {
			schemaVersion: 1,
			kind: "symmio.muon-upgrade-profile",
			chainId: Number((await ethers.provider.getNetwork()).chainId),
			core: { address: coreIdentity.address, codeHash: ethers.keccak256("0x6000") },
			verifier: { address: String(verifier.target), codeHash: ethers.keccak256(await ethers.provider.getCode(verifier.target)) },
		}
		const initial = await checkpoint(),
			snapshot = await captureMuonConfiguration(provider, profile, initial)
		expect(snapshot.configuration.publicKeys[0].permissions).to.deep.equal([true, false, false, false, false, false, false, false, false])
		await verifyMuonConfiguration(provider, profile, snapshot, initial, operationDigest(snapshot))
		await verifier.setGatewaySignerPermissions(gateway.address, [1], true)
		let error: any
		try {
			await verifyMuonConfiguration(provider, profile, snapshot, await checkpoint(), operationDigest(snapshot))
		} catch (e) {
			error = e
		}
		expect(error?.message).to.include("configuration changed")
	})
})
