import { MUON_UPGRADE_ABI } from "../../../deployment-tooling/operations/muon-upgrade.js";
import { Interface, id, keccak256, toBeHex, ZeroHash } from "ethers";

export function muonUpgradeFixture() {
	const core = toBeHex(1, 20),
		verifier = toBeHex(2, 20),
		gateway = toBeHex(3, 20),
		admin = toBeHex(4, 20),
		instant = toBeHex(5, 20);
	const checkpoint = { blockNumber: 12, blockHash: toBeHex(12, 32) },
		code = "0x60006000";
	const policy = { requiredFunctions: ["Trading"], maxRoleMembers: 5, maxSigners: 5 };
	const profile = {
		schemaVersion: 1,
		kind: "symmio.muon-upgrade-profile",
		chainId: 31337,
		core: { address: core, codeHash: keccak256(code) },
		verifier: { address: verifier, codeHash: keccak256(code) },
		policy,
	};
	const iface = new Interface(MUON_UPGRADE_ABI),
		calls = [],
		roles = new Map([
			[ZeroHash, [admin]],
			[id("SETTER_ROLE"), [admin]],
		]);
	const state = {
		appId: 7n,
		upnl: 60n,
		price: 30n,
		keyAllowed: true,
		gatewayAllowed: true,
		override: false,
		supported: true,
		code,
		keys: [{ x: 123n, parity: 0 }],
		gateways: [gateway],
		hash: checkpoint.blockHash,
		timestamp: 1000,
		fail: null,
	};
	const provider = {
		send: async (method, args) => {
			calls.push({ method, args });
			if (method === "eth_chainId") return toBeHex(profile.chainId);
			if (method === "eth_getBlockByNumber") return { number: toBeHex(12), hash: state.hash, timestamp: toBeHex(state.timestamp) };
			if (method === "eth_getCode") return state.code;
			if (method !== "eth_call") throw new Error(`Unexpected RPC ${method}`);
			const parsed = iface.parseTransaction({ data: args[0].data }),
				name = parsed.name,
				input = Array.from(parsed.args);
			if (state.fail === name) throw new Error("Getter unavailable");
			const values = {
				getSignatureVerifier: [verifier],
				getMuonIds: [state.appId],
				getMuonConfig: [state.upnl, state.price],
				getMuonFunctionUpnlValidTime: [state.upnl, state.override],
				getAllPublicKeys: [state.keys],
				getAllGatewaySigners: [state.gateways],
				supportsMuonFunction: [state.supported],
				isPublicKeyAuthorized: [state.keyAllowed && input[1] === 0n],
				isGatewaySignerAuthorized: [state.gatewayAllowed && input[1] === 0n],
				getRoleAdmin: [ZeroHash],
				getRoleMemberCount: [roles.get(input[0])?.length || 0],
				getRoleMember: [roles.get(input[0])?.[Number(input[1])]],
				hasRole: [roles.get(input[0])?.includes(input[1]) || false],
			};
			return iface.encodeFunctionResult(name, values[name]);
		},
	};
	return { provider, profile, checkpoint, state, roles, calls, core, verifier, gateway, admin, instant };
}
