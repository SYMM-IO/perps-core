import { expect } from "chai"

import {
	assertConfigurationParity,
	flowDiscovery,
	IMPLEMENTATION_SLOT,
	BASELINE_GASLESS_LIBRARIES,
	WALLET_CREATION_FEE_SLOT,
	FEE_QUOTE_STORAGE_NAMESPACE,
	verifyGaslessStorageLayout,
} from "../../deployment-tooling/account-instant-upgrade.js"
import { quoteGaslessFee } from "../../scripts/gaslessLayer/fee-quote.js"
import {
	compileGaslessCompatibility,
	readGaslessConfiguration,
	readGaslessUpgradeStorage,
	readInstantConfiguration,
	diamondABI,
	verifyGaslessCompatibility,
} from "../../tasks/deploy/accountInstantSnapshot.js"
import {
	assertUpgradeDeployments,
	buildUpgradeClientHandoff,
	configureReplacementInstant,
	deployAccountInstantSelection,
	planInstantConfiguration,
	planPartyBUpgrade,
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

	it("permits only the approved nonce rename and two-slot gap use, rejecting other layout changes", () => {
		const { baseline: old, current } = baseline.layouts
		expect(verifyGaslessStorageLayout(old, current).layoutDigest).to.equal(baseline.layoutDigest)
		for (const mutate of [
			(layout: any) => {
				layout.storage[0].slot = "1"
			},
			(layout: any) => {
				layout.storage.at(-4).label = "anotherMapping"
			},
			(layout: any) => {
				layout.storage.at(-3).slot = "20"
			},
			(layout: any) => {
				layout.storage.at(-1).slot = "20"
			},
			(layout: any) => {
				layout.types[layout.storage.at(-3).type].value = layout.types[layout.storage.at(-3).type].key
			},
			(layout: any) => {
				layout.types[layout.storage.at(-1).type].numberOfBytes = "1056"
			},
		]) {
			const wrong = structuredClone(current)
			mutate(wrong)
			expect(() => verifyGaslessStorageLayout(old, wrong)).to.throw(/storage layout differs/)
		}
	})

	it("plans only needed PartyB grants for a contract admin without SETTER_ROLE and resumes wiring and retirement", async () => {
		const [originalAdmin, oldInstant, newInstant, unrelated] = await ethers.getSigners()
		const safeContract = await (await ethers.getContractFactory("MockAccountLayer")).deploy()
		const authority = String(safeContract.target).toLowerCase()
		await ethers.provider.send("hardhat_impersonateAccount", [authority])
		await ethers.provider.send("hardhat_setBalance", [authority, "0x3635c9adc5dea00000"])
		try {
			const safe = await ethers.getSigner(authority)
			const impl = await (await ethers.getContractFactory("SymmioPartyB")).deploy()
			const proxy = await (
				await ethers.getContractFactory("LocalERC1967Proxy")
			).deploy(impl.target, impl.interface.encodeFunctionData("initialize", [originalAdmin.address, unrelated.address]))
			const party = await ethers.getContractAt("SymmioPartyB", proxy.target)
			const manager = ethers.id("MANAGER_ROLE"),
				trusted = ethers.id("TRUSTED_ROLE")
			await party.grantRole(ethers.ZeroHash, authority)
			await party.grantRole(trusted, oldInstant.address)
			await party.setMulticastWhitelist(oldInstant.address, true)
			const snapshot = { partyBAdmins: { [String(party.target)]: authority }, gasless: { instantLayer: oldInstant.address } }
			const report = { deployments: { InstantLayer: { address: newInstant.address } } }
			const nonce = await ethers.provider.getTransactionCount(authority)
			let actions = await planPartyBUpgrade(ethers, snapshot, report)
			expect(await ethers.provider.getTransactionCount(authority)).to.equal(nonce)
			expect(actions.map(a => party.interface.parseTransaction({ data: a.data })!.name)).to.deep.equal([
				"grantRole",
				"grantRole",
				"setMulticastWhitelist",
			])
			const first = party.interface.decodeFunctionData("grantRole", actions[0].data)
			expect(first[0]).to.equal(manager)
			expect(first[1].toLowerCase()).to.equal(authority)
			for (const action of actions) {
				expect(action.authority).to.equal(authority)
				expect(action.to).to.equal(String(party.target))
				expect(action.value).to.equal("0")
			}
			for (const remaining of [2, 1, 0]) {
				await (await safe.sendTransaction({ to: actions[0].to, data: actions[0].data })).wait()
				actions = await planPartyBUpgrade(ethers, snapshot, report)
				expect(actions).to.have.length(remaining)
			}
			expect(await party.hasRole(trusted, newInstant.address)).to.equal(true)
			expect(await party.multicastWhitelist(newInstant.address)).to.equal(true)
			expect(await party.hasRole(ethers.id("SETTER_ROLE"), authority)).to.equal(false)
			expect(await party.hasRole(trusted, authority)).to.equal(false)
			await party.revokeRole(manager, authority)
			actions = await planPartyBUpgrade(ethers, snapshot, report, true)
			expect(actions.map(a => party.interface.parseTransaction({ data: a.data })!.name)).to.deep.equal([
				"grantRole",
				"revokeRole",
				"setMulticastWhitelist",
			])
			for (const action of actions) await (await safe.sendTransaction({ to: action.to, data: action.data })).wait()
			expect(await planPartyBUpgrade(ethers, snapshot, report, true)).to.deep.equal([])
			expect(await party.hasRole(trusted, oldInstant.address)).to.equal(false)
			expect(await party.multicastWhitelist(oldInstant.address)).to.equal(false)
			expect(await party.hasRole(trusted, newInstant.address)).to.equal(true)
			expect(await party.multicastWhitelist(newInstant.address)).to.equal(true)
			for (const role of [ethers.ZeroHash, manager, trusted]) expect(await party.hasRole(role, originalAdmin.address)).to.equal(true)
			await party.revokeRole(ethers.ZeroHash, authority)
			await expectFailure(() => planPartyBUpgrade(ethers, snapshot, report), /DEFAULT_ADMIN_ROLE/)
		} finally {
			await ethers.provider.send("hardhat_stopImpersonatingAccount", [authority])
		}
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
		const libraries: Record<string, string> = {}
		for (const name of BASELINE_GASLESS_LIBRARIES) {
			const artifact = baseline.libraryArtifacts[name]
			const linked = name === "GaslessWalletExecutionLib" ? { GaslessWalletDeployerLib: libraries.GaslessWalletDeployerLib } : {}
			const lib = await (await ethers.getContractFactoryFromArtifact(artifact, { libraries: linked })).deploy()
			libraries[name] = String(lib.target)
		}
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
		const legacy = new ethers.Contract(proxy.target, baseline.artifact.abi, admin)
		const legacyWallet = await legacy.getGaslessWalletAddress(admin.address)
		const abi = ethers.AbiCoder.defaultAbiCoder()
		const nonceSlot = ethers.keccak256(abi.encode(["address", "uint256"], [relayer.address, 18]))
		await ethers.provider.send("hardhat_setStorageAt", [String(proxy.target), nonceSlot, ethers.toBeHex(37, 32)])
		expect(await legacy.walletOperationNonces(relayer.address)).to.equal(37)
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
				getStorage: ethers.provider.getStorage.bind(ethers.provider),
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
			token,
			account,
			legacyWallet,
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

	it("refuses nonzero new fee/quote slots and unreadable storage instead of assuming a disabled fee", async () => {
		const f = await fixture()
		const slots = [BigInt(WALLET_CREATION_FEE_SLOT), ...[0n, 1n, 2n, 3n].map(i => BigInt(ethers.id(FEE_QUOTE_STORAGE_NAMESPACE)) + i)]
		for (const slot of slots) {
			await ethers.provider.send("hardhat_setStorageAt", [String(f.gasless.target), ethers.toQuantity(slot), ethers.toBeHex(123, 32)])
			await expectFailure(
				async () => readGaslessUpgradeStorage(ethers, String(f.gasless.target), await ethers.provider.getBlockNumber()),
				/slot 20 must be zero|namespace is not empty/,
			)
			await ethers.provider.send("hardhat_setStorageAt", [String(f.gasless.target), ethers.toQuantity(slot), ethers.ZeroHash])
		}
		const unavailable = {
			...ethers,
			provider: {
				getStorage: async () => {
					throw new Error("storage RPC unavailable")
				},
			},
		}
		await expectFailure(() => readGaslessUpgradeStorage(unavailable, String(f.gasless.target), 1), /storage RPC unavailable/)
	})

	it("proves the old runtime/layout, deploys exactly thirteen contracts and recovers missing report entries without another broadcast", async () => {
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
		expect(await ethers.provider.getTransactionCount(f.deployer.address)).to.equal(before + 13)
		await assertUpgradeDeployments(hre, ethers, f.input, report)
		for (const entry of Object.values(report.deployments) as any[]) {
			const receipt = await ethers.provider.getTransactionReceipt(entry.deploymentTransaction)
			expect(receipt?.contractAddress?.toLowerCase()).to.equal(entry.address)
		}
		await deployAccountInstantSelection(hre, ethers, f.input, f.snapshot, report, checkpoint, () => {})
		expect(await ethers.provider.getTransactionCount(f.deployer.address)).to.equal(before + 13)
		const handoff = await buildUpgradeClientHandoff(hre, f.input, report)
		const clientInterface = new ethers.Interface(handoff.gaslessABI)
		expect(clientInterface.getFunction("relayInstantBatch")!.inputs.at(-1)!.type).to.equal("uint256[]")
		expect(clientInterface.getFunction("getGaslessWalletAddress")!.inputs.map(i => i.type)).to.deep.equal(["address", "uint256"])
		expect(clientInterface.getFunction("walletOperationNonces")!.inputs.map(i => i.type)).to.deep.equal(["address", "uint256", "address"])
		expect(handoff.walletCreationFeePolicy).to.deep.equal({ requiredValue: "0", unit: "collateral token decimals", setDuringUpgrade: false })
		for (const name of ["previewFeeQuote", "simulateFeeQuote", "executeWithFeeLimit", "walletCreationFee", "getWalletCreationFee"])
			expect(clientInterface.getFunction(name)).not.to.equal(null)
		expect(clientInterface.getError("FeeQuoteResult")).not.to.equal(null)
		expect(clientInterface.getEvent("WalletCreationFeeCollected")).not.to.equal(null)
		expect(clientInterface.getEvent("WalletDepositSettled")).not.to.equal(null)
		expect(clientInterface.getEvent("WalletNonCollateralTokenRecovered")).not.to.equal(null)
		expect(clientInterface.getEvent("DepositSettledToNewAccount")).to.equal(null)
		expect(handoff.gaslessLayer).to.equal(f.input.config.target.gaslessLayer)
		expect(handoff.instantSigningDomain.verifyingContract).to.equal(report.deployments.InstantLayer.address)
		const domain = await (await ethers.getContractAt("InstantLayer", report.deployments.InstantLayer.address)).eip712Domain()
		expect(handoff.instantSigningDomain.name).to.equal(domain.name)
		expect(handoff.instantSigningDomain.version).to.equal(domain.version)
		expect(report.compatibility.reusedLibraries).to.deep.equal({})
		for (const entry of Object.values(report.deployments) as any[])
			for (const address of Object.values(entry.libraries)) expect(Object.values(f.compatibility.libraries)).not.to.include(address)
		const wrongLinks = structuredClone(report)
		wrongLinks.deployments.GaslessLayer.libraries = f.compatibility.libraries
		await expectFailure(() => assertUpgradeDeployments(hre, ethers, f.input, wrongLinks), /Configuration drift/)
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
		expect(await f.gasless.walletCreationFee()).to.equal(0)
		expect(await f.gasless.getWalletCreationFee(f.admin.address, 0)).to.equal(0)
		expect(await f.gasless.getGaslessWalletAddress(f.admin.address, 0)).to.equal(f.legacyWallet)
		const indexedWallet = await f.gasless.getGaslessWalletAddress(f.admin.address, 1)
		expect(indexedWallet).not.to.equal(f.legacyWallet)
		expect(await f.gasless.walletOperationNonces(f.admin.address, 0, f.relayer.address)).to.equal(37)
		expect(await f.gasless.walletOperationNonces(f.admin.address, 1, f.relayer.address)).to.equal(0)
		const coder = ethers.AbiCoder.defaultAbiCoder()
		const indexedNonceSlot = ethers.keccak256(
			coder.encode(["address", "bytes32"], [f.relayer.address, ethers.keccak256(coder.encode(["address", "uint256"], [indexedWallet, 19]))]),
		)
		await ethers.provider.send("hardhat_setStorageAt", [String(f.gasless.target), indexedNonceSlot, ethers.toBeHex(9, 32)])
		expect(await f.gasless.walletNonces(indexedWallet, f.relayer.address)).to.equal(9)
		expect(await f.gasless.walletOperationNonces(f.admin.address, 1, f.relayer.address)).to.equal(9)
		expect(await f.gasless.walletOperationNonces(f.admin.address, 0, f.relayer.address)).to.equal(37)
		const after = await readGaslessConfiguration(ethers, String(f.gasless.target), await ethers.provider.getBlockNumber())
		assertConfigurationParity({ ...f.snapshot.gasless, instantLayer: String(replacement.target).toLowerCase() }, after)
		expect(after.selectorFees).to.deep.equal([
			{ selector: "0x11111111", configured: true, amount: "0" },
			{ selector: "0x22222222", configured: false, amount: "999" },
		])
		expect(after.roles.find((r: any) => r.role === ethers.id("RELAYER_ROLE"))?.members).to.deep.equal(
			[f.admin.address.toLowerCase(), f.relayer.address.toLowerCase()].sort(),
		)
		// Exercise the newly linked quote and accounting paths through a real baseline -> new proxy upgrade.
		await f.account.setAccountOwner(f.relayer.address, f.admin.address)
		await f.token.mint(f.legacyWallet, 100000)
		const callData = f.gasless.interface.encodeFunctionData("settleDepositToExistingAccount", [f.admin.address, 0, f.relayer.address])
		const preview = await f.gasless.previewFeeQuote(callData, 0)
		expect(preview.exact).to.equal(false)
		expect(preview.totalFee).to.equal(30000n * 10n ** 12n)
		expect(preview.payments[0].walletCreationFee).to.equal(0)
		const exact = await quoteGaslessFee({ gateway: f.gasless as any, callData, mode: "exact", from: f.admin.address })
		expect(exact.status).to.equal("quoted")
		if (exact.status !== "quoted") throw new Error("Expected exact quote")
		expect(exact.quote.totalDebit).to.equal(preview.totalDebit)
		expect(exact.quote.exact).to.equal(true)
		expect(await f.token.balanceOf(f.legacyWallet)).to.equal(100000)
		expect(await ethers.provider.getCode(f.legacyWallet)).to.equal("0x")
		await expect(f.gasless.executeWithFeeLimit(callData, preview.totalDebit - 1n)).to.be.revertedWithCustomError(f.gasless, "FeeLimitExceeded")
		expect(await f.token.balanceOf(f.legacyWallet)).to.equal(100000)
		await f.gasless.executeWithFeeLimit(callData, preview.totalDebit)
		expect(await f.token.balanceOf(f.legacyWallet)).to.equal(0)
		expect(await f.gasless.walletCreationFee()).to.equal(0)
		assertConfigurationParity(after, await readGaslessConfiguration(ethers, String(f.gasless.target), await ethers.provider.getBlockNumber()))
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
