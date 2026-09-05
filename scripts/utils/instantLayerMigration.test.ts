import { Interface, ZeroHash, keccak256, toUtf8Bytes } from "ethers"
import assert from "node:assert/strict"
import test from "node:test"

import {
	buildCutoverSafeActions,
	buildDecommissionSafeActions,
	buildInstantLayerReplayPlan,
	buildSafeTransactionBuilderBatch,
	compareInstantLayerConfiguration,
	mergePartyBCandidates,
	planAdditionalTemplates,
	type InstantLayerSnapshot,
} from "./instantLayerMigration.js"

const CORE = "0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A"
const ACCOUNT_LAYER = "0x573310d1D6ec18cB21E1aB949414470D9bf5c24E"
const OLD_IL = "0xCB8F789d6f7e59B3D266490e1Aa8e35cFb755132"
const NEW_IL = "0x1111111111111111111111111111111111111111"
const NEW_IMPL = "0x2222222222222222222222222222222222222222"
const GASLESS = "0x8347953D80037b8d82827246f37EC7442AD188B4"
const PARTY_B = "0x0420b24359d2DCccA53904042aa36A641162445c"
const SAFE = "0x77A955776Ee1dd3E9C800c3214ed489441d74b94"
const DEPLOYER = "0xf12239317e985f6772F86407608B166EfA3E2f05"
const role = (name: string) => keccak256(toUtf8Bytes(name))

const emptyOp = { insertionPoints: [], sourceIndices: [], sourceOffsets: [] }

function snapshot(overrides: Partial<InstantLayerSnapshot> = {}): InstantLayerSnapshot {
	return {
		address: OLD_IL,
		symmio: CORE,
		accountLayer: ACCOUNT_LAYER,
		revocationCooldown: 600n,
		transientContextEnabled: true,
		whitelistedTargets: [CORE, ACCOUNT_LAYER],
		registeredPartyBs: [PARTY_B],
		templates: [
			{ id: 0n, name: "InstantOpen", active: true, instantOpenMode: true, operations: [emptyOp, emptyOp] },
			{ id: 1n, name: "InstantClose", active: true, instantOpenMode: false, operations: [emptyOp] },
		],
		roles: { DEFAULT_ADMIN_ROLE: [SAFE], SETTER_ROLE: [SAFE], OPERATOR_ROLE: [GASLESS, SAFE, PARTY_B], REVOKER_ROLE: [SAFE] },
		...overrides,
	}
}

test("replay plan reproduces the old InstantLayer configuration in template-id order", () => {
	const plan = buildInstantLayerReplayPlan(snapshot(), { deployer: DEPLOYER, safe: SAFE })
	const kinds = plan.map(a => a.kind)
	assert.deepEqual(kinds, [
		"setAccountLayer",
		"setTargetWhitelist",
		"registerPartyBs",
		"addTemplate",
		"setTemplateInstantOpenMode",
		"addTemplate",
		"grantRole",
	])
	// Core is whitelisted by the constructor, so only the AccountLayer needs an explicit whitelist entry
	const whitelist = plan.find(a => a.kind === "setTargetWhitelist")!
	assert.equal(whitelist.args[0], ACCOUNT_LAYER)
	// PartyBs come through registerPartyBs (which grants OPERATOR_ROLE); the Safe comes through the handover.
	const grants = plan.filter(a => a.kind === "grantRole")
	assert.deepEqual(
		grants.map(a => a.args),
		[[role("OPERATOR_ROLE"), GASLESS]],
	)
	assert.equal(plan.find(a => a.kind === "setTemplateInstantOpenMode")!.args[0], 0n)
})

test("replay plan carries non-default cooldown, disabled transient context, and inactive templates", () => {
	const plan = buildInstantLayerReplayPlan(
		snapshot({
			revocationCooldown: 1200n,
			transientContextEnabled: false,
			templates: [{ id: 0n, name: "Retired", active: false, instantOpenMode: false, operations: [emptyOp] }],
		}),
		{ deployer: DEPLOYER, safe: SAFE },
	)
	assert.deepEqual(
		plan.map(a => a.kind),
		[
			"setAccountLayer",
			"setTargetWhitelist",
			"registerPartyBs",
			"addTemplate",
			"setTemplateActive",
			"setRevocationCooldown",
			"setTransientContextEnabled",
			"grantRole",
		],
	)
	assert.deepEqual(plan.find(a => a.kind === "setTemplateActive")!.args, [0n, false])
	assert.deepEqual(plan.find(a => a.kind === "setRevocationCooldown")!.args, [1200n])
	assert.deepEqual(plan.find(a => a.kind === "setTransientContextEnabled")!.args, [false])
})

test("replay plan refuses a snapshot whose old layer still counts the deployer as a role holder", () => {
	assert.throws(
		() =>
			buildInstantLayerReplayPlan(
				snapshot({ roles: { DEFAULT_ADMIN_ROLE: [SAFE, DEPLOYER], SETTER_ROLE: [SAFE], OPERATOR_ROLE: [SAFE], REVOKER_ROLE: [SAFE] } }),
				{
					deployer: DEPLOYER,
					safe: SAFE,
				},
			),
		/deployer/i,
	)
})

test("cutover Safe actions bind the new layer everywhere and upgrade the GaslessLayer with setInstantLayer as init data", () => {
	const actions = buildCutoverSafeActions({
		core: CORE,
		accountLayer: ACCOUNT_LAYER,
		partyBs: [PARTY_B],
		gaslessLayer: GASLESS,
		newGaslessImplementation: NEW_IMPL,
		newInstantLayer: NEW_IL,
	})
	const diamond = new Interface(["function grantRole(address user, bytes32 role)"])
	const partyB = new Interface(["function grantRole(bytes32 role, address account)", "function setMulticastWhitelist(address addr, bool state)"])
	const gasless = new Interface([
		"function upgradeToAndCall(address newImplementation, bytes data)",
		"function setInstantLayer(address instantLayer_)",
	])

	assert.deepEqual(
		actions.map(a => [a.to, a.data]),
		[
			[CORE, diamond.encodeFunctionData("grantRole", [NEW_IL, role("INSTANT_LAYER_ROLE")])],
			[ACCOUNT_LAYER, diamond.encodeFunctionData("grantRole", [NEW_IL, role("SIGNER_SETTER_ROLE")])],
			[PARTY_B, partyB.encodeFunctionData("grantRole", [role("TRUSTED_ROLE"), NEW_IL])],
			[PARTY_B, partyB.encodeFunctionData("setMulticastWhitelist", [NEW_IL, true])],
			[GASLESS, gasless.encodeFunctionData("upgradeToAndCall", [NEW_IMPL, gasless.encodeFunctionData("setInstantLayer", [NEW_IL])])],
		],
	)
	assert.ok(actions.every(a => a.value === "0" && a.description.length > 0))
})

test("decommission Safe actions strip the old layer without touching the GaslessLayer", () => {
	const actions = buildDecommissionSafeActions({ core: CORE, accountLayer: ACCOUNT_LAYER, partyBs: [PARTY_B], oldInstantLayer: OLD_IL })
	const diamond = new Interface(["function revokeRole(address user, bytes32 role)"])
	const partyB = new Interface(["function revokeRole(bytes32 role, address account)", "function setMulticastWhitelist(address addr, bool state)"])
	assert.deepEqual(
		actions.map(a => [a.to, a.data]),
		[
			[CORE, diamond.encodeFunctionData("revokeRole", [OLD_IL, role("INSTANT_LAYER_ROLE")])],
			[ACCOUNT_LAYER, diamond.encodeFunctionData("revokeRole", [OLD_IL, role("SIGNER_SETTER_ROLE")])],
			[PARTY_B, partyB.encodeFunctionData("revokeRole", [role("TRUSTED_ROLE"), OLD_IL])],
			[PARTY_B, partyB.encodeFunctionData("setMulticastWhitelist", [OLD_IL, false])],
		],
	)
	assert.ok(actions.every(a => a.to !== GASLESS))
})

test("Safe Transaction Builder batch wraps raw calldata actions for the given Safe and chain", () => {
	const batch = buildSafeTransactionBuilderBatch({
		chainId: 42161n,
		safe: SAFE,
		name: "cutover",
		description: "bind new InstantLayer",
		actions: [{ to: CORE, value: "0", data: "0x1234abcd", description: "x" }],
		createdAt: 1_700_000_000_000,
	})
	assert.equal(batch.version, "1.0")
	assert.equal(batch.chainId, "42161")
	assert.equal(batch.createdAt, 1_700_000_000_000)
	assert.equal(batch.meta.createdFromSafeAddress, SAFE)
	assert.equal(batch.meta.name, "cutover")
	assert.deepEqual(batch.transactions, [{ to: CORE, value: "0", data: "0x1234abcd", contractMethod: null, contractInputsValues: null }])
	assert.notEqual(ZeroHash, batch.meta.checksum)
})

test("configuration comparison is empty for a faithful replacement and names every drift otherwise", () => {
	const old = snapshot()
	const replacement = snapshot({ address: NEW_IL })
	assert.deepEqual(compareInstantLayerConfiguration(old, replacement), [])

	const drifted = snapshot({
		address: NEW_IL,
		accountLayer: DEPLOYER,
		revocationCooldown: 900n,
		transientContextEnabled: false,
		whitelistedTargets: [CORE],
		registeredPartyBs: [],
		templates: [{ id: 0n, name: "InstantOpen", active: false, instantOpenMode: true, operations: [emptyOp, emptyOp] }],
		roles: { DEFAULT_ADMIN_ROLE: [SAFE], SETTER_ROLE: [SAFE, DEPLOYER], OPERATOR_ROLE: [SAFE, PARTY_B], REVOKER_ROLE: [] },
	})
	const differences = compareInstantLayerConfiguration(old, drifted)
	for (const needle of [
		"accountLayer",
		"revocationCooldown",
		"transientContextEnabled",
		"whitelistedTargets",
		"registeredPartyBs",
		"template 0",
		"template 1",
		"SETTER_ROLE",
		"OPERATOR_ROLE",
		"REVOKER_ROLE",
	]) {
		assert.ok(
			differences.some(d => d.includes(needle)),
			`expected a difference mentioning ${needle}; got ${JSON.stringify(differences)}`,
		)
	}
	assert.ok(!differences.some(d => d.includes("DEFAULT_ADMIN_ROLE")))
})

test("PartyB candidates come from OPERATOR_ROLE members merged with extra sources, deduplicated and checksummed", () => {
	const merged = mergePartyBCandidates([GASLESS, SAFE, PARTY_B.toLowerCase()], [PARTY_B], ["0x0000000000000000000000000000000000000000", DEPLOYER])
	assert.deepEqual(merged, [GASLESS, SAFE, PARTY_B, DEPLOYER])
})

test("cast ledger send arguments carry target, calldata, sender, chain, confirmations, and the derivation path", async () => {
	const { castSendArguments } = await import("./castLedgerSigner.js")
	const args = castSendArguments(
		{ to: CORE.toLowerCase(), value: "0", data: "0xabcdef", description: "x" },
		{ admin: SAFE, chainId: 42161n, confirmations: 2 },
		"m/44'/60'/3'/0/0",
	)
	assert.deepEqual(args, [
		"send",
		CORE,
		"0xabcdef",
		"--from",
		SAFE,
		"--chain",
		"42161",
		"--confirmations",
		"2",
		"--timeout",
		"300",
		"--json",
		"--ledger",
		"--mnemonic-derivation-path",
		"m/44'/60'/3'/0/0",
	])
	assert.throws(
		() => castSendArguments({ to: CORE, value: "1" as "0", data: "0x", description: "x" }, { admin: SAFE, chainId: 1 }, "m/44'/60'/0'/0/0"),
		/zero-value/,
	)
})

test("additional templates come from the recipe entries past the deployed ones, with contiguous ids", () => {
	const deployed = snapshot().templates
	const recipe = [
		{ name: "InstantOpen", instantOpenMode: true, operations: [emptyOp, emptyOp] },
		{ name: "InstantClose", operations: [emptyOp] },
		{
			name: "InstantOpenAndSettleUpnl",
			instantOpenMode: true,
			operations: [
				emptyOp,
				emptyOp,
				{ insertionPoints: [0], sourceIndices: [1], sourceOffsets: [0] },
				{ insertionPoints: [448], sourceIndices: [1], sourceOffsets: [0] },
			],
		},
	]
	const additional = planAdditionalTemplates(deployed, recipe)
	assert.deepEqual(
		additional.map(t => [t.id, t.name, t.instantOpenMode, t.active, t.operations.at(-1)!.insertionPoints]),
		[[2n, "InstantOpenAndSettleUpnl", true, true, [448n]]],
	)
	assert.deepEqual(planAdditionalTemplates(deployed, recipe.slice(0, 2)), [])
})

test("additional templates refuse a recipe whose leading entries drift from the deployed ids", () => {
	const deployed = snapshot().templates
	assert.throws(
		() =>
			planAdditionalTemplates(deployed, [
				{ name: "InstantOpen", operations: [emptyOp, emptyOp] },
				{ name: "InstantClose", operations: [emptyOp] },
			]),
		/instantOpenMode/,
	)
	assert.throws(
		() => planAdditionalTemplates(deployed, [{ name: "InstantOpen", instantOpenMode: true, operations: [emptyOp, emptyOp] }]),
		/must include every deployed template/,
	)
	assert.throws(
		() =>
			planAdditionalTemplates(deployed, [
				{ name: "Renamed", instantOpenMode: true, operations: [emptyOp, emptyOp] },
				{ name: "InstantClose", operations: [emptyOp] },
			]),
		/name/,
	)
})
