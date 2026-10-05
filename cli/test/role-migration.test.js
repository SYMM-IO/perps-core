import { buildRoleMigration, captureRoleMigration, verifyRoleMigration } from "../../deployment-tooling/operations/role-migration.js";
import { Interface, id, keccak256, toBeHex, ZeroHash } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const address = n => toBeHex(n, 20),
	old = address(1),
	replacement = address(2),
	admin = address(3),
	member = address(4),
	code = "0x6000";
const sourceRole = id("OLD_CAPABILITY"),
	targetRole = id("NEW_CAPABILITY"),
	block = { blockNumber: 12, blockHash: toBeHex(12, 32) };
const profile = {
	schemaVersion: 1,
	chainId: 31337,
	source: { address: old, codeHash: keccak256(code) },
	target: { address: replacement, codeHash: keccak256(code) },
	transitions: [{ id: "template-management", sourceRole, targetRole, adminRole: ZeroHash, authority: admin, policy: "exact-source-members" }],
};
const roles = [{ role: sourceRole, members: [member] }];
function rpc(after = false, extras = {}) {
	const iface = new Interface([
		"function hasRole(bytes32,address) view returns(bool)",
		"function getRoleAdmin(bytes32) view returns(bytes32)",
		"function getRoleMemberCount(bytes32) view returns(uint256)",
	]);
	return {
		send: async (method, args) => {
			if (method === "eth_chainId") return toBeHex(profile.chainId);
			if (method === "eth_getBlockByNumber") return { hash: block.blockHash };
			if (method === "eth_getCode") return code;
			const parsed = iface.parseTransaction(args[0]),
				source = args[0].to === old;
			const value =
				parsed.name === "getRoleAdmin"
					? ZeroHash
					: parsed.name === "getRoleMemberCount"
						? source
							? (extras.sourceCount ?? 1)
							: (extras.targetCount ?? (after ? 1 : 0))
						: parsed.args[0] === ZeroHash
							? parsed.args[1].toLowerCase() === admin && !extras.noAdmin
							: parsed.args[1].toLowerCase() === member && (source || after);
			return iface.encodeFunctionResult(parsed.fragment, [value]);
		},
	};
}

test("explicit capability changes preserve exactly observed members under the configured admin", async () => {
	const snapshot = await captureRoleMigration(rpc(), profile, roles, { source: block, target: block }),
		plan = buildRoleMigration(profile, snapshot);
	assert.equal(plan.actions.length, 1);
	assert.equal(plan.actions[0].authority, admin);
	assert.equal((await verifyRoleMigration(rpc(true), plan, block)).transitions, 1);
	const already = await captureRoleMigration(rpc(true), profile, roles, { source: block, target: block });
	assert.equal(buildRoleMigration(profile, already).actions.length, 0);
});

test("capability migration rejects incomplete roles, extra privileges, missing admin and drift", async () => {
	const checkpoints = { source: block, target: block };
	await assert.rejects(captureRoleMigration(rpc(), profile, [{ role: sourceRole, members: [] }], checkpoints), /incomplete/);
	await assert.rejects(captureRoleMigration(rpc(false, { targetCount: 1 }), profile, roles, checkpoints), /unexpected/);
	await assert.rejects(captureRoleMigration(rpc(false, { noAdmin: true }), profile, roles, checkpoints), /authority/);
	const plan = buildRoleMigration(profile, await captureRoleMigration(rpc(), profile, roles, checkpoints));
	await assert.rejects(verifyRoleMigration(rpc(true, { targetCount: 2 }), plan, block), /count/);
	await assert.rejects(verifyRoleMigration(rpc(), plan, block), /count/);
	assert.throws(() => buildRoleMigration({ ...profile, transitions: [{ ...profile.transitions[0], policy: "automatic-admin" }] }, {}), /policy/);
	await assert.rejects(verifyRoleMigration(rpc(true), { ...plan, actions: [] }, block), /changed/);
});
