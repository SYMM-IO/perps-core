import { expect } from "chai"

import { assertConfigurationParity, flowDiscovery, IMPLEMENTATION_SLOT } from "../../deployment-tooling/account-instant-upgrade.js"
import { deployGaslessLayerLibraries } from "../../scripts/gaslessLayer/layer-libraries.js"
import {
	compileGaslessCompatibility,
	readGaslessConfiguration,
	readInstantConfiguration,
	diamondABI,
	verifyGaslessCompatibility,
} from "../../tasks/deploy/accountInstantSnapshot.js"
import {
	assertUpgradeDeployments,
	configureReplacementInstant,
	deployAccountInstantSelection,
	planInstantConfiguration,
	planProtocolUpgrade,
	verifyReplacementInstant,
} from "../../tasks/deploy/accountInstantUpgrade.js"
import { createCheckpoint, setCheckpointSimulated } from "../../tasks/deploy/checkpoint.js"
import { resetDeploymentTransactionJournal } from "../../tasks/deploy/tx.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

describe("Configuration-preserving AccountLayer and InstantLayer upgrade", function () {
	this.timeout(180000)
	let baseline: any
	before(async () => {
		baseline = await compileGaslessCompatibility(hre, "95f44c983480084eb097eddd2ad3574de3ea12e3")
	})

	async function fixture() {
		const [deployer, admin, relayer, removedRelayer, treasury, partyB] = await ethers.getSigners()
		const token = await (await ethers.getContractFactory("contracts/gaslessLayer/mocks/MockERC20.sol:MockERC20")).deploy("USDC", "USDC", 6)
		const core = await (await ethers.getContractFactory("MockGaslessSymmioCore")).deploy(token.target)
		const account = await (await ethers.getContractFactory("MockAccountLayer")).deploy()
		const instant = await (await ethers.getContractFactory("InstantLayer")).deploy(core.target, admin.address)
		await instant.connect(admin).setAccountLayer(account.target)
		await instant.connect(admin).registerPartyBs([partyB.address])
		await instant.connect(admin).revokeRole(ethers.id("OPERATOR_ROLE"), partyB.address)
		await instant.connect(admin).setRevocationCooldown(1230)
		await instant.connect(admin).setTransientContextEnabled(false)
		await instant.connect(admin).setTargetWhitelist(core.target, false)
		await instant.connect(admin).setTargetWhitelist(treasury.address, true)
		await instant.connect(admin).addTemplate("inactive settlement", [{ insertionPoints: [480], sourceIndices: [0], sourceOffsets: [32] }])
		await instant.connect(admin).setTemplateActive(0, false)
		await instant.connect(admin).addTemplate("instant open", [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }])
		await instant.connect(admin).setTemplateInstantOpenMode(1, true)
		const libraries = await deployGaslessLayerLibraries(ethers)
		const factory = await ethers.getContractFactoryFromArtifact(baseline.artifact, { libraries })
		const impl = await factory.deploy()
		const proxy = await (
			await ethers.getContractFactory("LayerProxy")
		).deploy(
			impl.target,
			factory.interface.encodeFunctionData("initialize", [
				admin.address,
				core.target,
				account.target,
				instant.target,
				treasury.address,
				30000,
				50000,
			]),
		)
		const gasless = (await ethers.getContractAt("GaslessLayer", proxy.target)).connect(admin)
		await gasless.grantRole(ethers.id("RELAYER_ROLE"), relayer.address)
		await gasless.grantRole(ethers.id("RELAYER_ROLE"), removedRelayer.address)
		await gasless.revokeRole(ethers.id("RELAYER_ROLE"), removedRelayer.address)
		await gasless.setDefaultSelectorFee(123456789)
		await gasless.setDailyFreeOpsLimit(7)
		await gasless.setRevertWhenFreeQuotaExhausted(true)
		await gasless.setNativeGasTopUpConfig(987654321, false)
		await gasless.setMaxNativeGasTopUpAmount(456789)
		await gasless.setNativeGasTopUpFeeBps(125)
		await gasless.setSelectorFeeConfig("0x11111111", true, 0)
		await gasless.setSelectorFeeConfig("0x22222222", true, 123)
		await gasless.setSelectorFeeConfig("0x22222222", false, 999)
		await instant.connect(admin).grantRole(ethers.id("OPERATOR_ROLE"), proxy.target)
		const block = await ethers.provider.getBlockNumber()
		const input = {
			config: {
				target: { core: core.target, accountLayer: account.target, gaslessLayer: proxy.target, safe: admin.address, relayer: relayer.address },
				discovery: {
					mode: "flow",
					gaslessSelectors: ["0x11111111", "0x22222222"],
					instantTargets: [treasury.address],
					instantPartyBs: [partyB.address],
				},
			},
		}
		const discovery = flowDiscovery(input.config)
		const getterOnly = {
			...ethers,
			provider: {
				getLogs: () => {
					throw new Error("History scans are forbidden for flow discovery")
				},
			},
			getContractAt: async (...args: any[]) =>
				new Proxy(await (ethers.getContractAt as any)(...args), {
					get: (contract, key) => {
						if (["getRoleMemberCount", "getRoleMember"].includes(String(key))) throw new Error("Complete holder enumeration is forbidden")
						return Reflect.get(contract, key)
					},
				}),
		}
		const snapshot = {
			gaslessImplementation: String(impl.target).toLowerCase(),
			gasless: await readGaslessConfiguration(getterOnly, String(proxy.target), block, discovery),
			instant: await readInstantConfiguration(getterOnly, String(instant.target), block, discovery),
			discovery,
			flow: {
				safe: admin.address.toLowerCase(),
				relayer: relayer.address.toLowerCase(),
				gaslessLayer: String(proxy.target).toLowerCase(),
				partyBs: [partyB.address.toLowerCase()],
			},
		}
		const compatibility = await verifyGaslessCompatibility(hre, ethers, snapshot, baseline)
		return {
			deployer,
			admin,
			relayer,
			removedRelayer,
			gasless,
			instant,
			snapshot,
			compatibility,
			input,
		}
	}

	it("proves the old runtime/layout, deploys exactly eight contracts and recovers missing report entries without another broadcast", async () => {
		const f = await fixture()
		resetDeploymentTransactionJournal()
		setCheckpointSimulated(true)
		const checkpoint = createCheckpoint("hardhat", 31337, `account-instant-test-${Date.now()}`)
		const report: any = { compatibility: f.compatibility }
		const before = await ethers.provider.getTransactionCount(f.deployer.address)
		let interrupted = false
		try {
			await deployAccountInstantSelection(hre, ethers, f.input, f.snapshot, report, checkpoint, () => {
				if (Object.keys(report.deployments).length === 3) throw new Error("simulated process failure")
			})
		} catch (error) {
			interrupted = String(error).includes("simulated process failure")
		}
		expect(interrupted).to.equal(true)
		expect(await ethers.provider.getTransactionCount(f.deployer.address)).to.equal(before + 3)
		delete report.deployments.MarginFacet
		await deployAccountInstantSelection(hre, ethers, f.input, f.snapshot, report, checkpoint, () => {})
		expect(await ethers.provider.getTransactionCount(f.deployer.address)).to.equal(before + 8)
		await assertUpgradeDeployments(hre, ethers, f.input, report)
		for (const entry of Object.values(report.deployments) as any[]) {
			const receipt = await ethers.provider.getTransactionReceipt(entry.deploymentTransaction)
			expect(receipt?.contractAddress?.toLowerCase()).to.equal(entry.address)
		}
		await deployAccountInstantSelection(hre, ethers, f.input, f.snapshot, report, checkpoint, () => {})
		expect(await ethers.provider.getTransactionCount(f.deployer.address)).to.equal(before + 8)
		const wrong = structuredClone(report)
		wrong.deployments.InstantLayer.address = f.admin.address
		await expectFailure(() => deployAccountInstantSelection(hre, ethers, f.input, f.snapshot, wrong, checkpoint, () => {}), /receipt journal/)
	})

	it("replays exact administrative state, resumes after partial templates, hands over roles, and preserves Gasless storage through the atomic upgrade", async () => {
		const f = await fixture()
		resetDeploymentTransactionJournal()
		setCheckpointSimulated(true)
		const report: any = { compatibility: f.compatibility }
		await deployAccountInstantSelection(
			hre,
			ethers,
			f.input,
			f.snapshot,
			report,
			createCheckpoint("hardhat", 31337, `account-instant-state-${Date.now()}`),
			() => {},
		)
		const replacement = (await ethers.getContractAt("InstantLayer", report.deployments.InstantLayer.address)).connect(f.admin)
		const safeEthers = { ...ethers, getSigners: async () => [f.admin] }
		await expect(replacement.connect(f.deployer).setRevocationCooldown(999)).to.be.reverted
		const beforePlan = await ethers.provider.getTransactionCount(f.admin.address)
		const plan = await planInstantConfiguration(ethers, f.input, f.snapshot, report)
		expect(plan.length).to.be.greaterThan(0)
		expect(plan.every(action => action.authority === f.admin.address.toLowerCase() && action.value === "0")).to.equal(true)
		expect(await ethers.provider.getTransactionCount(f.admin.address)).to.equal(beforePlan)
		const first = f.snapshot.instant.templates[0]
		await replacement.addTemplate(first.name, first.operations)
		await configureReplacementInstant(safeEthers, f.input, f.snapshot, report)
		await verifyReplacementInstant(ethers, f.snapshot, report)
		const before = await ethers.provider.getTransactionCount(f.admin.address)
		await configureReplacementInstant(safeEthers, f.input, f.snapshot, report)
		expect(await ethers.provider.getTransactionCount(f.admin.address)).to.equal(before)
		for (const role of [ethers.ZeroHash, ethers.id("SETTER_ROLE"), ethers.id("OPERATOR_ROLE"), ethers.id("REVOKER_ROLE")])
			expect(await replacement.hasRole(role, f.deployer.address)).to.equal(false)
		expect(await replacement.hasRole(ethers.id("OPERATOR_ROLE"), f.relayer.address)).to.equal(false)
		expect(await replacement.hasRole(ethers.id("OPERATOR_ROLE"), f.input.config.discovery.instantPartyBs[0])).to.equal(true)
		await expectFailure(() => f.gasless.setInstantLayer(replacement.target), /revert/)
		await f.gasless.upgradeToAndCall(
			report.deployments.GaslessLayer.address,
			f.gasless.interface.encodeFunctionData("setInstantLayer", [replacement.target]),
		)
		expect((await ethers.provider.getStorage(String(f.gasless.target), IMPLEMENTATION_SLOT)).slice(-40)).to.equal(
			report.deployments.GaslessLayer.address.slice(2),
		)
		const after = await readGaslessConfiguration(ethers, String(f.gasless.target), await ethers.provider.getBlockNumber())
		assertConfigurationParity({ ...f.snapshot.gasless, instantLayer: String(replacement.target).toLowerCase() }, after)
		expect(after.selectorFees).to.deep.equal([
			{ selector: "0x11111111", configured: true, amount: "0" },
			{ selector: "0x22222222", configured: false, amount: "999" },
		])
		expect(after.roles.find((r: any) => r.role === ethers.id("RELAYER_ROLE"))?.members).to.deep.equal(
			[f.admin.address.toLowerCase(), f.relayer.address.toLowerCase()].sort(),
		)
		await replacement.connect(f.admin).setTemplateActive(0, true)
		await expectFailure(() => verifyReplacementInstant(ethers, f.snapshot, report), /Configuration drift/)
	})

	it("plans only missing flow grants for the Safe and skips them after execution", async () => {
		const f = await fixture()
		await f.gasless.revokeRole(ethers.id("CONFIG_ADMIN_ROLE"), f.admin.address)
		await f.gasless.revokeRole(ethers.id("RELAYER_ROLE"), f.relayer.address)
		const target = { ...f.input.config.target, instantLayer: String(f.instant.target) }
		const memberships = new Set<string>()
		const key = (address: string, role: string, member: string) => [address, role, member].map(s => s.toLowerCase()).join(":")
		for (const address of [String(target.core), String(target.accountLayer)])
			memberships.add(key(address, ethers.id("DEFAULT_ADMIN_ROLE"), f.admin.address))
		let charger = false
		const iface = new ethers.Interface([...diamondABI, "function registerOperationalFeeCharger(address)"])
		const fakeEthers = {
			...ethers,
			getContractAt: async (abi: any, address: string) => {
				if ([String(target.core), String(target.accountLayer)].includes(address))
					return {
						interface: iface,
						hasRole: async (member: string, role: string) => memberships.has(key(address, role, member)),
						isOperationalFeeCharger: async () => charger,
					}
				return ethers.getContractAt(abi, address)
			},
		}
		const report = { deployments: { InstantLayer: { address: target.instantLayer }, GaslessLayer: { address: f.snapshot.gaslessImplementation } } }
		const before = await ethers.provider.getTransactionCount(f.admin.address)
		const actions = await planProtocolUpgrade(fakeEthers, { config: { target } }, f.snapshot, report)
		expect(await ethers.provider.getTransactionCount(f.admin.address)).to.equal(before)
		expect(actions).to.have.length(8)
		for (const action of actions) {
			expect(action.authority).to.equal(f.admin.address.toLowerCase())
			expect(action.value).to.equal("0")
			if (action.to === String(f.gasless.target)) {
				const decoded = f.gasless.interface.parseTransaction({ data: action.data })!
				expect(decoded.name).to.equal("grantRole")
				expect([ethers.id("RELAYER_ROLE"), ethers.id("CONFIG_ADMIN_ROLE")]).to.include(decoded.args[0])
				expect(decoded.args[1]).to.equal(decoded.args[0] === ethers.id("RELAYER_ROLE") ? f.relayer.address : f.admin.address)
				await (await f.admin.sendTransaction({ to: action.to, data: action.data })).wait()
			} else {
				const decoded = iface.parseTransaction({ data: action.data })!
				if (decoded.name === "grantRole") {
					expect(decoded.args[0]).not.to.equal(f.relayer.address)
					memberships.add(key(action.to, decoded.args[1], decoded.args[0]))
				} else charger = true
			}
		}
		expect(await planProtocolUpgrade(fakeEthers, { config: { target } }, f.snapshot, report)).to.deep.equal([])
	})
})

async function expectFailure(fn: () => Promise<any>, pattern: RegExp) {
	let error: unknown
	try {
		await fn()
	} catch (e) {
		error = e
	}
	expect(String(error)).to.match(pattern)
}
