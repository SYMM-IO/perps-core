import { expect } from "chai"

import {
	buildConfigurationMigration,
	captureConfigurationSnapshot,
	verifyConfigurationMigration,
} from "../../deployment-tooling/operations/configuration-migration.js"
import { buildRoleMigration, captureRoleMigration, verifyRoleMigration } from "../../deployment-tooling/operations/role-migration.js"
import { ethers } from "../helpers/hardhat-connection.js"

describe("Configuration-only replacement", function () {
	async function fixture() {
		const [admin, core, account, solver, extraSetter] = await ethers.getSigners()
		const factory = await ethers.getContractFactory("InstantLayer")
		const source = await factory.deploy(core.address, admin.address)
		const target = await factory.deploy(core.address, admin.address)
		await source.setAccountLayer(account.address)
		await source.setRevocationCooldown(900)
		await source.setTransientContextEnabled(false)
		await source.registerPartyBs([solver.address])
		await source.addTemplate("preserved", [{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [32] }])
		await source.setTemplateActive(0, false)
		await source.setTemplateInstantOpenMode(0, true)
		await source.grantRole(await source.SETTER_ROLE(), extraSetter.address)
		const codeHash = ethers.keccak256(await ethers.provider.getCode(source.target))
		const checkpoint = async () => {
			const block = (await ethers.provider.getBlock("latest"))!
			return { blockNumber: block.number, blockHash: block.hash! }
		}
		const call = (signature: string, args: any[] = []) => ({ signature, args })
		const auth = (role: string) => ({
			address: admin.address,
			read: call("function hasRole(bytes32,address) view returns(bool)", [role, admin.address]),
		})
		const setter = auth(await source.SETTER_ROLE()),
			templateManager = auth(await source.TEMPLATE_MANAGER_ROLE())
		const fields: any[] = [
			{ id: "core", mode: "immutable", read: call("function symmio() view returns(address)") },
			{
				id: "account",
				mode: "copy",
				authority: setter,
				read: call("function accountLayer() view returns(address)"),
				write: call("function setAccountLayer(address)", [{ ref: "observed" }]),
			},
			{
				id: "cooldown",
				mode: "copy",
				authority: setter,
				read: call("function revocationCooldown() view returns(uint256)"),
				write: call("function setRevocationCooldown(uint256)", [{ ref: "observed" }]),
			},
			{
				id: "transient",
				mode: "copy",
				authority: setter,
				read: call("function transientContextEnabled() view returns(bool)"),
				write: call("function setTransientContextEnabled(bool)", [{ ref: "observed" }]),
			},
			{
				id: "solver",
				mode: "flag",
				authority: setter,
				read: call("function registeredPartyBs(address) view returns(bool)", [solver.address]),
				write: {
					whenTrue: call("function registerPartyBs(address[])", [[solver.address]]),
					whenFalse: call("function unregisterPartyB(address)", [solver.address]),
				},
			},
			{
				id: "template",
				mode: "append",
				authority: templateManager,
				read: call(
					"function getTemplate(uint256) view returns(tuple(string name,tuple(uint256[] insertionPoints,uint256[] sourceIndices,uint256[] sourceOffsets)[] operations,bool active))",
					[0],
				),
				cursor: { read: call("function nextTemplateId() view returns(uint256)"), index: "0" },
				write: call("function addTemplate(string,tuple(uint256[] insertionPoints,uint256[] sourceIndices,uint256[] sourceOffsets)[])", [
					{ ref: "observed", path: ["name"] },
					{ ref: "observed", path: ["operations"] },
				]),
				afterWrite: [call("function setTemplateActive(uint256,bool)", [0, { ref: "observed", path: ["active"] }])],
			},
			{
				id: "open-mode",
				mode: "copy",
				authority: setter,
				read: call("function templateInstantOpenMode(uint256) view returns(bool)", [0]),
				write: call("function setTemplateInstantOpenMode(uint256,bool)", [0, { ref: "observed" }]),
			},
			{ id: "template-count", mode: "derived", read: call("function nextTemplateId() view returns(uint256)") },
		]
		const profile = {
			schemaVersion: 1,
			kind: "symmio.configuration-profile",
			chainId: Number((await ethers.provider.getNetwork()).chainId),
			source: { address: String(source.target), codeHash },
			fields,
		}
		const targetBinding = { address: String(target.target), codeHash: ethers.keccak256(await ethers.provider.getCode(target.target)) }
		return { admin, source, target, checkpoint, profile, targetBinding }
	}
	it("copies settings and templates through standard setters without reading or importing user state", async function () {
		const f = await fixture(),
			before = await f.checkpoint(),
			calls: string[] = []
		const provider = {
			send: async (method: string, args: any[]) => {
				if (method === "eth_call") calls.push(args[0].data.slice(0, 10))
				return ethers.provider.send(method, args)
			},
		}
		const snapshot = await captureConfigurationSnapshot(provider, f.profile, before)
		const plan = await buildConfigurationMigration(provider, f.profile, snapshot, f.targetBinding, before)
		for (const action of plan.actions) await (await f.admin.sendTransaction({ to: action.to, data: action.data })).wait()
		expect((await verifyConfigurationMigration(provider, plan, await f.checkpoint())).fields).to.equal(f.profile.fields.length)
		expect((await buildConfigurationMigration(provider, f.profile, snapshot, f.targetBinding, await f.checkpoint())).actions).to.deep.equal([])
		const forbidden = [
			"nonces(address)",
			"delegationNonces(address)",
			"delegations(address,address,bytes4)",
			"pendingRevocationEta(address,address,bytes4)",
			"operationUsageCount(bytes32)",
			"usedDelegationHashes(bytes32)",
		].map(signature => ethers.id(signature).slice(0, 10))
		expect(calls.some(selector => forbidden.includes(selector))).to.equal(false)
		expect(await f.target.hasRole(await f.target.OPERATOR_ROLE(), (await ethers.getSigners())[3].address)).to.equal(true)
		const role = await f.source.SETTER_ROLE(),
			manager = await f.target.TEMPLATE_MANAGER_ROLE()
		const roleProfile = {
			schemaVersion: 1,
			chainId: f.profile.chainId,
			source: f.profile.source,
			target: f.targetBinding,
			transitions: [
				{
					id: "template-management",
					sourceRole: role,
					targetRole: manager,
					adminRole: ethers.ZeroHash,
					authority: f.admin.address,
					policy: "exact-source-members",
				},
			],
		}
		const roles = [{ role, members: [...(await f.source.getRoleMembers(role))] }]
		const roleSnapshot = await captureRoleMigration(provider, roleProfile, roles, { source: before, target: await f.checkpoint() })
		const rolePlan = buildRoleMigration(roleProfile, roleSnapshot)
		for (const action of rolePlan.actions) await (await f.admin.sendTransaction({ to: action.to, data: action.data })).wait()
		expect((await verifyRoleMigration(provider, rolePlan, await f.checkpoint())).transitions).to.equal(1)
	})
	it("rejects changed inputs, missing authority, immutable drift and unexpected existing templates", async function () {
		const f = await fixture(),
			before = await f.checkpoint(),
			snapshot = await captureConfigurationSnapshot(ethers.provider, f.profile, before)
		try {
			await buildConfigurationMigration(ethers.provider, { ...f.profile, fields: f.profile.fields.slice(1) }, snapshot, f.targetBinding, before)
			expect.fail("Changed profile accepted")
		} catch (e: any) {
			expect(e.message).to.include("binding changed")
		}
		const wrongCore = await (await ethers.getContractFactory("InstantLayer")).deploy((await ethers.getSigners())[4].address, f.admin.address)
		try {
			await buildConfigurationMigration(
				ethers.provider,
				f.profile,
				snapshot,
				{ address: String(wrongCore.target), codeHash: ethers.keccak256(await ethers.provider.getCode(wrongCore.target)) },
				await f.checkpoint(),
			)
			expect.fail("Wrong Core accepted")
		} catch (e: any) {
			expect(e.message).to.include("immutable differs")
		}
		await f.target.revokeRole(await f.target.SETTER_ROLE(), f.admin.address)
		try {
			await buildConfigurationMigration(ethers.provider, f.profile, snapshot, f.targetBinding, await f.checkpoint())
			expect.fail("Missing authority accepted")
		} catch (e: any) {
			expect(e.message).to.include("authority differs")
		}
		await f.target.grantRole(await f.target.SETTER_ROLE(), f.admin.address)
		await f.target.addTemplate("unexpected", [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }])
		try {
			await buildConfigurationMigration(ethers.provider, f.profile, snapshot, f.targetBinding, await f.checkpoint())
			expect.fail("Wrong template accepted")
		} catch (e: any) {
			expect(e.message).to.include("append configuration differs")
		}
	})
})
