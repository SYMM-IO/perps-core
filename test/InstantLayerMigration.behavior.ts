import { expect } from "chai"
import { TypedDataDomain, toUtf8Bytes } from "ethers"

import { deployGaslessLayerLibraries, gaslessLayerFactoryOptions } from "../scripts/gaslessLayer/layer-libraries.js"
import {
	checkInstantLayerWiring,
	executeSafeActions,
	migrateInstantLayer,
	simulateSafeActions,
	snapshotInstantLayer,
	verifyInstantLayerReplacement,
} from "../scripts/utils/instantLayerMigrationRunner.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { cloneTypes } from "./helpers/instantLayerEIP712Types.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { RunContext } from "./models/RunContext.js"
import { getBlockTimestamp } from "./utils/Common.js"

// Full rehearsal of scripts/migrateInstantLayer.ts against the real core + AccountLayer +
// InstantLayer + GaslessLayer stack: the deployer replaces the InstantLayer and hands it to the
// Safe, the Safe executes the generated cutover batch, and a relayed one-signature setup lands on
// the new layer. The old layer stays wired until the separate decommission batch runs.
describe("InstantLayer migration rehearsal", function () {
	const role = (name: string) => ethers.keccak256(toUtf8Bytes(name))

	let context: RunContext
	let safe: any, deployer: any, relayer: any, user: any, sessionKey: any
	let gateway: any
	let gatewayAddr: string
	let oldInstantLayer: string
	let libraries: Awaited<ReturnType<typeof deployGaslessLayerLibraries>>
	const emptyOp = { insertionPoints: [], sourceIndices: [], sourceOffsets: [] }

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		safe = context.signers.admin
		deployer = context.signers.user2
		relayer = context.signers.others[0]
		user = context.signers.user
		sessionKey = context.signers.others[1]
		oldInstantLayer = await context.instantLayer.getAddress()

		// Production-like wiring of the old layer (mirrors the Arbitrum snapshot)
		await context.controlFacet.connect(safe).grantRole(oldInstantLayer, role("INSTANT_LAYER_ROLE"))
		await context.controlFacet.connect(safe).registerPartyB(await context.symmioPartyB.getAddress())
		await context.symmioPartyB.connect(safe).grantRole(role("TRUSTED_ROLE"), oldInstantLayer)
		await context.symmioPartyB.connect(safe).setMulticastWhitelist(oldInstantLayer, true)
		await context.instantLayer.connect(safe).registerPartyBs([await context.symmioPartyB.getAddress()])
		await context.instantLayer.connect(safe).setTargetWhitelist(context.accountLayerDiamond, true)
		await context.instantLayer
			.connect(safe)
			.addTemplate("InstantOpen", [emptyOp, emptyOp, { insertionPoints: [0], sourceIndices: [1], sourceOffsets: [0] }])
		await context.instantLayer.connect(safe).setTemplateInstantOpenMode(0, true)
		await context.instantLayer.connect(safe).addTemplate("InstantClose", [emptyOp, emptyOp])
		await context.instantLayer.connect(safe).grantRole(role("REVOKER_ROLE"), safe.address)

		libraries = await deployGaslessLayerLibraries(ethers)
		const Gateway = await ethers.getContractFactory("GaslessLayer", gaslessLayerFactoryOptions(libraries))
		const impl = await Gateway.deploy()
		const initData = Gateway.interface.encodeFunctionData("initialize", [
			safe.address,
			context.diamond,
			context.accountLayerDiamond,
			oldInstantLayer,
			context.signers.feeCollector.address,
			2_000_000n,
			5_000_000n,
		])
		const Proxy = await ethers.getContractFactory("contracts/gaslessLayer/mocks/LayerProxy.sol:LayerProxy")
		const proxy = await Proxy.deploy(await impl.getAddress(), initData)
		gatewayAddr = await proxy.getAddress()
		gateway = await ethers.getContractAt("GaslessLayer", gatewayAddr)
		await gateway.connect(safe).grantRole(await gateway.RELAYER_ROLE(), relayer.address)
		await context.instantLayer.connect(safe).grantRole(role("OPERATOR_ROLE"), gatewayAddr)
		await context.controlFacet.connect(safe).registerOperationalFeeCharger(gatewayAddr)
	})

	function wiringTargets(instantLayer: string) {
		return {
			core: context.diamond,
			accountLayer: context.accountLayerDiamond,
			partyBs: [context.symmioPartyB.target as string],
			gaslessLayer: gatewayAddr,
			instantLayer,
		}
	}

	async function executeAsSafe(actions: { to: string; data: string; description: string; value: "0" }[]) {
		expect(await executeSafeActions(ethers, safe, actions)).to.equal(actions.length)
	}

	it("replaces the InstantLayer, hands it to the Safe, and relays a one-signature setup on the new layer", async function () {
		const before = await checkInstantLayerWiring(ethers, wiringTargets(oldInstantLayer))
		expect(before.ok, before.bindings.map(b => `${b.label}: ${b.detail}`).join("\n")).to.be.true

		const snapshot = await snapshotInstantLayer(ethers, oldInstantLayer, { fromBlock: 0 })
		expect(snapshot.templates.map(t => t.name)).to.deep.equal(["InstantOpen", "InstantClose"])
		expect(snapshot.registeredPartyBs).to.deep.equal([context.symmioPartyB.target])

		const additionalTemplates = [
			{
				id: 2n,
				name: "InstantOpenAndSettleUpnl",
				active: true,
				instantOpenMode: true,
				operations: [
					emptyOp,
					emptyOp,
					{ insertionPoints: [0n], sourceIndices: [1n], sourceOffsets: [0n] },
					{ insertionPoints: [448n], sourceIndices: [1n], sourceOffsets: [0n] },
				],
			},
		]
		const result = await migrateInstantLayer({
			ethers,
			deployer,
			oldInstantLayer,
			safe: safe.address,
			gaslessLayer: gatewayAddr,
			gaslessLibraries: libraries,
			additionalTemplates,
			log: () => {},
		})
		const newInstantLayer = await ethers.getContractAt("InstantLayer", result.newInstantLayer)
		const newAddr = result.newInstantLayer
		expect(newAddr).to.not.equal(oldInstantLayer)

		// Configuration replayed from the old layer
		expect(await newInstantLayer.accountLayer()).to.equal(context.accountLayerDiamond)
		expect(await newInstantLayer.whitelistedTargets(context.diamond)).to.be.true
		expect(await newInstantLayer.whitelistedTargets(context.accountLayerDiamond)).to.be.true
		expect(await newInstantLayer.registeredPartyBs(context.symmioPartyB.target)).to.be.true
		expect(await newInstantLayer.nextTemplateId()).to.equal(3n)
		expect((await newInstantLayer.getTemplate(0)).name).to.equal("InstantOpen")
		expect(await newInstantLayer.templateInstantOpenMode(0)).to.be.true
		expect((await newInstantLayer.getTemplate(1)).name).to.equal("InstantClose")
		// Additional template appended after the replayed ones, with its injection offsets intact
		const added = await newInstantLayer.getTemplate(2)
		expect(added.name).to.equal("InstantOpenAndSettleUpnl")
		expect(await newInstantLayer.templateInstantOpenMode(2)).to.be.true
		expect([...added.operations[3].insertionPoints]).to.deep.equal([448n])
		expect(await context.instantLayer.nextTemplateId()).to.equal(2n)
		expect(await newInstantLayer.revocationCooldown()).to.equal(await context.instantLayer.revocationCooldown())

		// Handed over: the Safe holds every role, the deployer none
		for (const r of [ethers.ZeroHash, role("SETTER_ROLE"), role("OPERATOR_ROLE"), role("REVOKER_ROLE")]) {
			expect(await newInstantLayer.hasRole(r, safe.address), r).to.be.true
			expect(await newInstantLayer.hasRole(r, deployer.address), r).to.be.false
		}
		expect(await newInstantLayer.hasRole(role("OPERATOR_ROLE"), gatewayAddr)).to.be.true

		// Re-running is a no-op that returns the same addresses
		const again = await migrateInstantLayer({
			ethers,
			deployer,
			oldInstantLayer,
			safe: safe.address,
			gaslessLayer: gatewayAddr,
			gaslessLibraries: libraries,
			state: result.state,
			additionalTemplates,
			log: () => {},
		})
		expect(again.newInstantLayer).to.equal(newAddr)
		expect(again.newGaslessImplementation).to.equal(result.newGaslessImplementation)
		expect(again.transactionsSent).to.equal(0)

		// The new layer is a faithful copy: same configuration, Safe-held roles, deployer gone
		const replacement = await verifyInstantLayerReplacement(ethers, {
			oldSnapshot: result.expectedSnapshot,
			newInstantLayer: newAddr,
			safe: safe.address,
			deployer: deployer.address,
			gaslessLayer: gatewayAddr,
		})
		expect(replacement.ok, replacement.findings.join("\n")).to.be.true

		// Nothing is bound to the new layer until the Safe acts, and every Safe action simulates cleanly first
		expect((await checkInstantLayerWiring(ethers, wiringTargets(newAddr))).ok).to.be.false
		const cutoverSimulation = await simulateSafeActions(ethers, safe.address, result.cutoverActions)
		expect(
			cutoverSimulation.every(s => s.ok),
			cutoverSimulation.map(s => `${s.description}: ${s.error ?? "ok"}`).join("\n"),
		).to.be.true
		await executeAsSafe(result.cutoverActions)
		const after = await checkInstantLayerWiring(ethers, wiringTargets(newAddr))
		expect(after.ok, after.bindings.map(b => `${b.label}: ${b.detail}`).join("\n")).to.be.true
		expect(await gateway.instantLayer()).to.equal(newAddr)
		// Transition window: the old layer keeps its core/AccountLayer/PartyB bindings
		const oldStill = await checkInstantLayerWiring(ethers, wiringTargets(oldInstantLayer))
		expect(oldStill.bindings.filter(b => b.label.startsWith("gasless")).every(b => !b.ok)).to.be.true
		expect(oldStill.bindings.filter(b => !b.label.startsWith("gasless")).every(b => b.ok)).to.be.true

		// One wallet signature on the new layer's EIP-712 domain, relayed through the upgraded gateway
		await context.accountManager.connect(user).addAccount("migrated")
		const [account] = await context.accountManager.getAccounts(user.address, 0, 1)
		const subAccount = account.accountAddress
		const bindSelector = context.bindingFacet.interface.getFunction("bindToPartyB")!.selector
		const domain: TypedDataDomain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: newAddr,
		}
		const grantOp = {
			signer: user.address,
			target: newAddr,
			callData: newInstantLayer.interface.encodeFunctionData("grantDelegations", [
				[
					{
						account: { addr: subAccount, isPartyB: false },
						delegatedSigner: sessionKey.address,
						selectors: [bindSelector],
						expiryTimestamp: await getBlockTimestamp(3600n),
					},
				],
			]),
			signerAccount: { addr: subAccount, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 0n, deadline: await getBlockTimestamp(300n), salt: ethers.hexlify(ethers.randomBytes(32)) },
		}
		const grantSig = await user.signTypedData(domain, cloneTypes(), grantOp)
		await gateway.connect(relayer).relayInstantBatch([grantOp], [grantSig], [[]], [[]])
		expect(await newInstantLayer.isDelegationActive(subAccount, sessionKey.address, bindSelector)).to.be.true
		expect(await context.instantLayer.isDelegationActive(subAccount, sessionKey.address, bindSelector)).to.be.false

		// Decommission: the old layer loses every binding
		const decommissionSimulation = await simulateSafeActions(ethers, safe.address, result.decommissionActions)
		expect(decommissionSimulation.every(s => s.ok)).to.be.true
		await executeAsSafe(result.decommissionActions)
		const oldGone = await checkInstantLayerWiring(ethers, wiringTargets(oldInstantLayer))
		expect(oldGone.bindings.every(b => !b.ok)).to.be.true
		expect((await checkInstantLayerWiring(ethers, wiringTargets(newAddr))).ok).to.be.true
	})
})
