import { contractAbi, nodeAbi, ensureNode } from "./discovery.js";
import { ZeroAddress } from "ethers";

export async function inspectSetup({ nodes, edges, read, profile = {}, onProgress = () => {} }) {
	const core = nodes.find(n => n.id === "core"),
		al = nodes.find(n => n.id === "accountLayer"),
		il = nodes.find(n => n.id === "instantLayer");
	const candidates = [...nodes].filter(n => !["facet", "implementation", "library"].includes(n.kind));
	const relation = async (from, to, label, signature, args, expected = false, kind = "membership") => {
		if (!from || !to) return;
		try {
			const value = await read(from.address, signature, args);
			if (value || expected)
				edges.push({
					from: from.id,
					to: to.id,
					label,
					kind,
					actual: value,
					expected: expected || null,
					status: value ? "verified" : "missing",
					basis: signature,
				});
		} catch {
			if (expected) edges.push({ from: from.id, to: to.id, label, kind, actual: null, expected: true, status: "unknown", basis: signature });
			else from.setupReadFailures = (from.setupReadFailures || 0) + 1;
		}
	};
	if (il)
		for (const n of candidates)
			await relation(
				il,
				n,
				"Whitelisted target",
				"function whitelistedTargets(address) view returns(bool)",
				[n.address],
				n.id === "core" || n.id === "accountLayer",
			);
	if (core && al) {
		try {
			const hook = await read(core.address, "function getAffiliateHook(address) view returns(address)", [ZeroAddress]);
			edges.push({
				from: core.id,
				to: al.id,
				label: "System hook",
				kind: "hook",
				actual: hook,
				expected: al.address,
				status: hook.toLowerCase() === al.address.toLowerCase() ? "verified" : "missing",
				basis: "getAffiliateHook(address(0))",
			});
			if (hook !== ZeroAddress && hook.toLowerCase() !== al.address.toLowerCase())
				edges.push({
					from: core.id,
					to: ensureNode(nodes, hook).id,
					label: "Actual system hook",
					kind: "hook",
					actual: hook,
					status: "verified",
				});
		} catch {
			edges.push({ from: core.id, to: al.id, label: "System hook", kind: "hook", status: "unknown", actual: null, expected: al.address });
		}
	}
	for (const n of candidates) {
		if (n.kind === "express")
			await relation(
				core,
				n,
				"Registered express provider",
				"function isExpressProviderRegistered(address) view returns(bool)",
				[n.address],
				true,
			);
		if (n.kind === "affiliate")
			await relation(
				core,
				n,
				"Registered affiliate",
				"function isAffiliate(address) view returns(bool)",
				[n.address],
				(profile.nodes || []).some(p => p.id === n.id),
			);
		if (n.kind === "multiAccount")
			await relation(al, n, "Legacy MultiAccount", "function isLegacyMultiAccount(address) view returns(bool)", [n.address]);
		if (n.kind === "partyB")
			for (const peer of candidates)
				await relation(n, peer, "Multicast allowlist", "function multicastWhitelist(address) view returns(bool)", [peer.address]);
	}
	if (al) {
		const selectors = [
			...new Set([
				...Object.keys(al.diamond?.map || {}),
				...Object.keys(core?.diamond?.map || {}),
				...(al.setupHistory || []).flatMap(e =>
					["HookSet", "HookRemoved", "OperatorSet"].includes(e.name)
						? [e.args[1]]
						: ["HookAllowedSelectorsSet", "CallAllowedSelectorsSet"].includes(e.name)
							? e.args[1]
							: [],
				),
			]),
		];
		const iface = nodeAbi(al);
		for (const e of al.setupHistory || [])
			if (e.name === "OperatorSet") {
				const [affiliate, selector, operator] = e.args;
				const holder = ensureNode(nodes, operator, "authority", "Affiliate operator");
				const label = `Affiliate operator · ${affiliate.slice(0, 10)} · ${selector}`;
				if (edges.some(e => e.from === holder.id && e.to === al.id && e.label === label)) continue;
				try {
					const active = await read(al.address, "function isOperator(address,bytes4,address) view returns(bool)", [
						affiliate,
						selector,
						operator,
					]);
					if (active)
						edges.push({
							from: holder.id,
							to: al.id,
							label,
							kind: "permission",
							status: "verified",
							actual: true,
							basis: `Affiliate ${affiliate}; isOperator read at snapshot block`,
						});
				} catch {
					edges.push({ from: holder.id, to: al.id, label, kind: "permission", status: "unknown", actual: null });
				}
			}
		for (const affiliate of candidates.filter(n => n.kind === "affiliate")) {
			onProgress(`Reading affiliate hooks and selector permissions · ${affiliate.name}`);
			try {
				const values = await read(al.address, iface.getFunction("getAffiliateSelectorConfigs").format("full"), [
					affiliate.address,
					selectors,
				]);
				affiliate.state.selectorConfig = values;
				for (const [selector, hook, hookAllowed, callAllowed] of values) {
					if (hook !== ZeroAddress) {
						const target = ensureNode(nodes, hook, "external", "Affiliate hook");
						edges.push({
							from: affiliate.id,
							to: target.id,
							label: `Hook · ${selector}`,
							kind: "hook",
							status: "verified",
							actual: hook,
							basis: `AccountLayer getAffiliateSelectorConfigs(${affiliate.address})`,
						});
						edges.push({
							from: target.id,
							to: al.id,
							label: `Hook execution · ${selector}`,
							kind: "permission",
							status: hookAllowed ? "verified" : "unset",
							actual: hookAllowed,
							basis: "Optional selector permission; absence is not a missing setup requirement",
						});
					}
					if (callAllowed && core)
						edges.push({
							from: affiliate.id,
							to: core.id,
							label: `callAsAffiliate · ${selector}`,
							kind: "permission",
							status: "verified",
							actual: true,
							basis: "AccountLayer selector allowlist",
						});
				}
			} catch {
				affiliate.errors.push("Affiliate selector configuration unavailable");
			}
		}
	}
	const jobs = [];
	for (const n of candidates.filter(n => n.status === "observed")) {
		const iface = nodeAbi(n);
		for (const f of iface.fragments) {
			if (f.type !== "function" || f.stateMutability !== "view") continue;
			if (
				f.inputs.length === 1 &&
				f.inputs[0].type === "address" &&
				f.outputs.length === 1 &&
				f.outputs[0].type === "bool" &&
				![
					"isAffiliate",
					"isPartyB",
					"isPartyBRegistered",
					"registeredPartyBs",
					"whitelistedTargets",
					"multicastWhitelist",
					"isLegacyMultiAccount",
					"isWhitelistedSymmioCore",
				].includes(f.name)
			) {
				for (const peer of candidates) jobs.push(() => relation(n, peer, f.name, f.format("full"), [peer.address], false, "permission"));
			}
			if (n.kind === "express" && f.inputs.length === 1 && f.inputs[0].type === "address" && /affiliate|creditLine|Validator/.test(f.name)) {
				for (const affiliate of candidates.filter(a => a.kind === "affiliate"))
					jobs.push(async () => {
						try {
							n.state.setup ||= {};
							n.state.setup[`${f.name} · ${affiliate.name}`] = await read(n.address, f.format("full"), [affiliate.address]);
						} catch {
							n.setupReadFailures = (n.setupReadFailures || 0) + 1;
						}
					});
			}
		}
		if (n.kind === "instantLayer") {
			const count = Number(n.state.templates || 0);
			n.state.templateConfiguration = [];
			for (let i = 0; i < Math.min(count, 1000); i++)
				jobs.push(async () => {
					try {
						const template = await read(n.address, iface.getFunction("getTemplate").format("full"), [i]);
						const instantOpen = await read(n.address, "function templateInstantOpenMode(uint256) view returns(bool)", [i]);
						n.state.templateConfiguration.push({ id: i, template, instantOpen });
					} catch {
						n.errors.push(`Template ${i}: unavailable`);
					}
				});
			if (count > 1000) n.errors.push("Template inventory truncated at 1000 entries");
		}
		if (n.kind === "express")
			for (const affiliate of candidates.filter(a => a.kind === "affiliate"))
				for (const validator of candidates)
					jobs.push(async () => {
						try {
							const yes = await read(n.address, "function isValidator(address,address) view returns(bool)", [
								affiliate.address,
								validator.address,
							]);
							if (yes)
								edges.push({
									from: validator.id,
									to: n.id,
									label: `Validator · ${affiliate.name}`,
									kind: "permission",
									status: "verified",
									actual: true,
								});
						} catch {
							n.setupReadFailures = (n.setupReadFailures || 0) + 1;
						}
					});
	}
	for (let i = 0; i < jobs.length; i += 32) {
		onProgress(`Reading setup permissions ${i + 1}–${Math.min(i + 32, jobs.length)} of ${jobs.length}`);
		await Promise.all(jobs.slice(i, i + 32).map(run => run()));
	}
	for (const n of candidates) n.state.templateConfiguration?.sort((a, b) => a.id - b.id);

	// All scalar setup values are retained for current-state and before/after inspection.
	for (const n of candidates.filter(n => n.status === "observed")) {
		const iface = nodeAbi(n);
		const getters = iface.fragments.filter(
			f =>
				f.type === "function" &&
				f.stateMutability === "view" &&
				!f.inputs.length &&
				f.outputs.every(p => /^u?int|^bool$|^string$|^bytes32$/.test(p.type)) &&
				!f.name.endsWith("_ROLE"),
		);
		for (let offset = 0; offset < getters.length; offset += 16)
			await Promise.all(
				getters.slice(offset, offset + 16).map(async f => {
					try {
						n.state[f.name] = await read(n.address, f.format("full"));
					} catch {
						n.errors.push(`${f.name}: unavailable`);
					}
				}),
			);
	}
}
