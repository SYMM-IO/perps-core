import { loadBuild, ROOT } from "./build.js";
import { canonical, codeHash, deploymentIdentity, digest } from "./model.js";
import { COMPONENTS, IMPLEMENTATION_SLOT, serial } from "./system.js";
import { ContractFactory, Interface, ZeroAddress, ZeroHash, getAddress, getCreateAddress, id } from "ethers";

// Bytecode comparison for the UI only. Rehearsal obtains the exact runtime from
// the reviewed creation transaction; masked comparison never authorizes a send.
export function compareRuntime(artifact, code) {
	if (!code || code.length !== artifact.deployedBytecode.length) return false;
	let expected = artifact.deployedBytecode.toLowerCase(),
		actual = code.toLowerCase();
	for (const positions of Object.values(artifact.immutableReferences || {}))
		for (const { start, length } of positions) {
			const a = 2 + start * 2,
				b = a + length * 2;
			expected = expected.slice(0, a) + "0".repeat(length * 2) + expected.slice(b);
			actual = actual.slice(0, a) + "0".repeat(length * 2) + actual.slice(b);
		}
	return expected === actual;
}
export async function preparePeripheral({
	provider,
	system,
	nodeId,
	deployer,
	authority,
	baseline,
	root = ROOT,
	buildFor = scope => loadBuild(root, scope),
}) {
	const node = system.nodes.find(n => n.id === nodeId);
	if (!["partyB", "verifier"].includes(node?.kind)) throw new Error("Choose PartyB or the signature verifier");
	if (node.status !== "observed") throw new Error("Inspect the selected contract successfully first");
	deployer = getAddress(deployer);
	authority = getAddress(authority);
	if (deployer === ZeroAddress || authority === ZeroAddress) throw new Error("Signer addresses cannot be zero");
	if ((await provider.getCode(deployer)) !== "0x") throw new Error("The deployment signer must be an EOA (wallet or Ledger)");
	const build = await buildFor(node.kind),
		artifact = Object.values(build.catalog)[0],
		iface = new Interface(artifact.abi);
	const block = system.blockNumber,
		reads = [],
		actions = [],
		changes = [],
		warnings = [],
		blockers = [];
	const codePins = {};
	const pinCode = async target => {
		const code = await provider.getCode(target, block);
		if (!codePins[target]) {
			const known = system.nodes.find(n => n.address.toLowerCase() === target.toLowerCase());
			if (known?.diamond) {
				await read(target, "function facets() view returns ((address facetAddress,bytes4[] functionSelectors)[])");
				for (const facet of known.diamond.facets) codePins[facet.address] = facet.codeHash;
			}
		}
		codePins[target] = codeHash(code);
		return code;
	};
	const read = async (target, signature, args = []) => {
		const i = typeof signature === "string" ? new Interface([signature]) : signature;
		const f = typeof signature === "string" ? i.fragments[0] : args.shift();
		const data = i.encodeFunctionData(f, args),
			result = await provider.call({ to: target, data, blockTag: block });
		reads.push({ to: target, data, result });
		const out = i.decodeFunctionResult(f, result);
		return out.length === 1 ? out[0] : out;
	};
	const source = async (name, args = []) => read(node.address, iface, [name, ...args]);
	const add = (label, to, i, method, args, phase = "configure", sender = authority) => {
		actions.push({
			id: `action-${actions.length}`,
			label,
			phase,
			sender,
			to,
			data: i.encodeFunctionData(method, args),
			value: "0",
			method,
			args: serial(args),
		});
	};
	const standard = new Interface(["function grantRole(bytes32,address)", "function revokeRole(bytes32,address)"]);
	const coreI = new Interface(["function setSignatureVerifierAddress(address)"]);
	const byId = Object.fromEntries(system.nodes.map(n => [n.id, n]));
	const authorityCode = await pinCode(authority);
	if (authorityCode !== "0x") {
		const owners = await read(authority, "function getOwners() view returns(address[])");
		const threshold = await read(authority, "function getThreshold() view returns(uint256)");
		await read(authority, "function nonce() view returns(uint256)");
		if (threshold < 1n || threshold > BigInt(owners.length)) throw new Error("Unsupported contract authority");
	}
	await pinCode(node.address);
	if (node.implementation) await pinCode(node.implementation);
	if (node.kind !== "partyB" && node.implementation)
		throw new Error("This replacement adapter requires a direct deployment, but an ERC1967 implementation was detected");
	const nonce = await provider.getTransactionCount(deployer, "pending"),
		replacement = getCreateAddress({ from: deployer, nonce });
	if ((await provider.getCode(replacement)) !== "0x") throw new Error("Predicted deployment address is occupied");
	const constructorArgs = node.kind === "partyB" ? [] : [authority];
	const creation = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...constructorArgs);
	actions.push({
		id: "deploy",
		phase: "deploy",
		label: `Deploy ${COMPONENTS[node.kind].title}${node.kind === "partyB" ? " implementation" : " replacement"}`,
		sender: deployer,
		data: creation.data,
		value: "0",
		nonce,
		creates: replacement,
	});
	changes.push({
		contract: node.name,
		field: node.kind === "partyB" ? "Implementation" : "Contract address",
		before: node.implementation || node.address,
		after: replacement,
	});
	const checkRole = async (target, role, reverse = false) => {
		await pinCode(target);
		const okay = await read(
			target,
			reverse ? "function hasRole(address,bytes32) view returns(bool)" : "function hasRole(bytes32,address) view returns(bool)",
			reverse ? [authority, role] : [role, authority],
		);
		if (!okay) blockers.push(`${authority} does not hold the required ${role === ZeroHash ? "admin" : role} role on ${target}`);
	};
	const roles = {};
	if (node.kind !== "partyB") {
		for (const name of ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE"]) {
			const role = name === "DEFAULT_ADMIN_ROLE" ? ZeroHash : id(name);
			if ((await source("getRoleAdmin", [role])) !== ZeroHash) throw new Error(`Custom role admin for ${name} requires a dedicated migration`);
			const count = Number(await source("getRoleMemberCount", [role]));
			if (count > 100) throw new Error("Role inventory too large");
			roles[name] = [];
			for (let i = 0; i < count; i++) roles[name].push(getAddress(await source("getRoleMember", [role, i])));
		}
		if (!roles.DEFAULT_ADMIN_ROLE.length || !roles.SETTER_ROLE.length) blockers.push("Source admin and setter membership must be non-empty");
	}
	if (node.kind === "partyB") {
		if (!node.implementation) throw new Error("PartyB must be an ERC1967/UUPS proxy");
		const oldCode = await provider.getCode(node.implementation, block);
		const compatible =
			compareRuntime(artifact, oldCode) ||
			(baseline?.scope === "partyB" &&
				compareRuntime(Object.values(baseline.catalog)[0], oldCode) &&
				canonical(baseline.storageSources) === canonical(build.storageSources));
		if (!compatible)
			blockers.push("Import the deployed PartyB build bundle. A recognized implementation and unchanged storage-related sources are required.");
		await checkRole(node.address, ZeroHash);
		const core = await source("symmioAddress"),
			signer = await source("signer"),
			paused = await source("paused");
		add("Upgrade PartyB implementation", node.address, iface, "upgradeToAndCall", [replacement, "0x"], "cutover");
		changes.push({
			contract: node.name,
			field: "Proxy / balances / signer / Core",
			before: [node.address, core, signer, paused],
			after: [node.address, core, signer, paused],
		});
	} else {
		await checkRole(byId.core.address, ZeroHash, true);
		const actual = await read(byId.core.address, "function getSignatureVerifier() view returns(address)");
		if (actual.toLowerCase() !== node.address.toLowerCase()) throw new Error("Core's active verifier differs from the selected source");
		const keys = await source("getAllPublicKeys"),
			gateways = await source("getAllGatewaySigners");
		if (!keys.length || !gateways.length) blockers.push("Source verifier must contain public keys and gateway signers");
		for (const key of keys) {
			const k = [key.x, key.parity];
			add("Copy TSS public key", replacement, iface, "addPublicKey", [k]);
			const permissions = [];
			for (let start = 0; start < 256; start += 16) {
				const flags = await Promise.all(Array.from({ length: 16 }, (_, i) => source("isPublicKeyAuthorized", [k, start + i])));
				flags.forEach((v, i) => {
					if (v) permissions.push(start + i);
				});
			}
			if (permissions.length)
				add(`Restore ${permissions.length} TSS permissions`, replacement, iface, "setPublicKeyPermissions", [k, permissions, true]);
		}
		for (const gateway of gateways) {
			add("Copy gateway signer", replacement, iface, "addGatewaySigner", [gateway]);
			const permissions = [];
			for (let start = 0; start < 256; start += 16) {
				const flags = await Promise.all(Array.from({ length: 16 }, (_, i) => source("isGatewaySignerAuthorized", [gateway, start + i])));
				flags.forEach((v, i) => {
					if (v) permissions.push(start + i);
				});
			}
			if (permissions.length)
				add(`Restore ${permissions.length} gateway permissions`, replacement, iface, "setGatewaySignerPermissions", [
					gateway,
					permissions,
					true,
				]);
		}
		changes.push({ contract: byId.core.name, field: "Signature verifier", before: node.address, after: replacement });
		changes.push({
			contract: node.name,
			field: "Oracle configuration",
			before: `${keys.length} keys / ${gateways.length} gateways / all 256 permission IDs`,
			after: "Preserved",
		});
	}
	if (node.kind !== "partyB") {
		const initial = ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE"];
		for (const [name, members] of Object.entries(roles))
			for (const member of members)
				if (!(initial.includes(name) && member === authority))
					add(`Restore ${name}`, replacement, standard, "grantRole", [name === "DEFAULT_ADMIN_ROLE" ? ZeroHash : id(name), member]);
		// Role cleanup is after all configuration; admin last. Never remove source roles.
		for (const name of [...initial.filter(n => n !== "DEFAULT_ADMIN_ROLE"), "DEFAULT_ADMIN_ROLE"])
			if (!roles[name].includes(authority))
				add(`Remove temporary ${name}`, replacement, standard, "revokeRole", [
					name === "DEFAULT_ADMIN_ROLE" ? ZeroHash : id(name),
					authority,
				]);
		add("Switch Core signature verifier", byId.core.address, coreI, "setSignatureVerifierAddress", [replacement], "cutover");
	}
	// Configuration must finish before wiring switches; retire obsolete authorization last.
	const order = { deploy: 0, configure: 1, cutover: 2, retire: 3 };
	actions.sort((a, b) => order[a.phase] - order[b.phase]);
	actions.forEach((a, i) => (a.id = `tx-${i}`));
	const body = {
		version: 1,
		kind: "peripheral",
		nodeId,
		scope: node.kind,
		source: build.source,
		buildDigest: build.digest,
		chainId: system.chainId,
		blockNumber: block,
		blockHash: system.blockHash,
		profile: system.profile,
		deployment: deploymentIdentity(system.profile, system.chainId),
		sourceAddress: node.address,
		replacement,
		deployer,
		authority,
		actions,
		changes,
		warnings,
		blockers,
		reads: serial(reads),
		codePins,
		roles,
		storagePins: node.implementation ? { [node.address]: node.implementation } : {},
	};
	return { ...body, id: digest(body), createdAt: new Date().toISOString() };
}
export async function assertPeripheralInputs(provider, plan, { nonce = true } = {}) {
	if (Number((await provider.getNetwork()).chainId) !== plan.chainId) throw new Error("RPC chain changed");
	for (const [target, expected] of Object.entries(plan.storagePins || {})) {
		if (getAddress(`0x${(await provider.getStorage(target, IMPLEMENTATION_SLOT)).slice(-40)}`) !== expected)
			throw new Error("Proxy implementation changed; prepare again");
	}
	for (const [target, hash] of Object.entries(plan.codePins))
		if (codeHash(await provider.getCode(target)) !== hash) throw new Error(`Source runtime changed: ${target}`);
	for (let start = 0; start < plan.reads.length; start += 16)
		await Promise.all(
			plan.reads.slice(start, start + 16).map(async r => {
				if ((await provider.call({ to: r.to, data: r.data })).toLowerCase() !== r.result.toLowerCase())
					throw new Error(`Source configuration changed at ${r.to}; prepare again`);
			}),
		);
	if (nonce && (await provider.getTransactionCount(plan.deployer, "pending")) !== plan.actions[0].nonce)
		throw new Error("Deployment signer nonce changed; prepare again to bind the new contract address");
}
