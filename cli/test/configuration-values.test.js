import {
	buildConfigurationMigration,
	captureConfigurationSnapshot,
	validateConfigurationProfile,
} from "../../deployment-tooling/operations/configuration-migration.js";
import { Interface, keccak256, toBeHex } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

test("named fee values encode exact selector settings and bind the proxy implementation", async () => {
	const address = n => toBeHex(n, 20),
		code = "0x6000",
		block = { blockNumber: 12, blockHash: toBeHex(12, 32) };
	const implementation = { address: address(4), slot: toBeHex(100, 32), codeHash: keccak256(code) };
	const profile = {
		schemaVersion: 1,
		kind: "symmio.configuration-profile",
		chainId: 31337,
		source: { address: address(1), codeHash: keccak256(code), implementation },
		fields: [
			{
				id: "fee",
				mode: "copy",
				read: { signature: "function selectorFeeConfigs(bytes4) view returns(bool configured,uint256 amount)", args: ["0x12345678"] },
				write: {
					signature: "function setSelectorFeeConfig(bytes4,bool,uint256)",
					args: ["0x12345678", { ref: "observed", path: ["configured"] }, { ref: "observed", path: ["amount"] }],
				},
				authority: { address: address(3), read: { signature: "function owner() view returns(address)", args: [] } },
			},
		],
	};
	const iface = new Interface([profile.fields[0].read.signature, profile.fields[0].write.signature, profile.fields[0].authority.read.signature]);
	const provider = {
		send: async (method, args) => {
			if (method === "eth_chainId") return "0x7a69";
			if (method === "eth_getBlockByNumber") return { hash: block.blockHash };
			if (method === "eth_getCode") return code;
			if (method === "eth_getStorageAt") return toBeHex(BigInt(implementation.address), 32);
			const fn = iface.parseTransaction(args[0]);
			return iface.encodeFunctionResult(
				fn.fragment,
				fn.name === "owner" ? [address(3)] : args[0].to === profile.source.address ? [true, 123456789012345678901234567890n] : [false, 0],
			);
		},
	};
	const snapshot = await captureConfigurationSnapshot(provider, profile, block),
		plan = await buildConfigurationMigration(provider, profile, snapshot, { address: address(2), codeHash: keccak256(code) }, block);
	assert.deepEqual(snapshot.fields[0].value, { configured: true, amount: "123456789012345678901234567890" });
	assert.deepEqual(
		[...iface.decodeFunctionData("setSelectorFeeConfig", plan.actions[0].data)],
		["0x12345678", true, 123456789012345678901234567890n],
	);
	await assert.rejects(
		captureConfigurationSnapshot(
			{ send: (method, args) => (method === "eth_getStorageAt" ? Promise.resolve(toBeHex(5, 32)) : provider.send(method, args)) },
			profile,
			block,
		),
		/implementation changed/,
	);
	const wrong = structuredClone(profile);
	wrong.fields[0].authority.read = { signature: "function hasRole(bytes32,address) view returns(bool)", args: [toBeHex(0, 32), address(9)] };
	assert.throws(() => validateConfigurationProfile(wrong), /configured authority/);
});
