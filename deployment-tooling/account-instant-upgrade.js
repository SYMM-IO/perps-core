import { getAddress, Interface, ZeroAddress } from "ethers";
import { createHash } from "node:crypto";

export const ACCOUNT_FACETS = Object.freeze(["CoreFacet", "MarginFacet", "ControlFacet", "ViewFacet", "TimelockFacet"]);
export const NEW_GASLESS_LIBRARIES = Object.freeze(["GaslessWalletDeployerLib", "GaslessWalletExecutionLib"]);
export const UPGRADE_DEPLOYMENTS = Object.freeze(["LibQuoteParams", ...ACCOUNT_FACETS, "InstantLayer", ...NEW_GASLESS_LIBRARIES, "GaslessLayer"]);
export const GASLESS_LIBRARIES = Object.freeze([
	"GaslessNativeGasTopUpLib",
	"GaslessOperationalFeeLib",
	"GaslessWalletDeployerLib",
	"GaslessWalletExecutionLib",
]);
export const POLICY = Object.freeze({
	preserveConfiguration: true,
	preserveGaslessProxy: true,
	migrateInstantUserState: false,
	setGlobalTimelocks: false,
	repairTemplates: false,
	roleScope: "required-flow",
	partyBExecution: "safe",
});
export const CONFIG_PATH = "tasks/config/arbitrum-account-instant-upgrade-42161.json";
export const RECIPE_PATH = "deployment-recipes/arbitrum-vibe-production.json";
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const GASLESS_UINTS = Object.freeze([
	"depositFee",
	"minimumDeposit",
	"defaultSelectorFee",
	"dailyFreeOpsLimit",
	"dailySponsoredNativeLimit",
	"maxNativeGasTopUpAmount",
	"nativeGasTopUpFeeBps",
]);
export const GASLESS_BOOLS = Object.freeze(["revertWhenFreeQuotaExhausted", "revertWhenNativeSponsorLimitExhausted"]);

function stable(value) {
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map(key => [key, stable(value[key])]),
		);
	return value;
}
export const digest = value =>
	createHash("sha256")
		.update(JSON.stringify(stable(value)))
		.digest("hex");
export function assertConfigurationParity(expected, actual) {
	if (digest(expected) !== digest(actual))
		throw new Error(
			"Configuration drift: on-chain settings differ from configuration-input.json; inspect the recorded expected and observed values before continuing",
		);
}

/** Accept only the reviewed indexed-wallet migration, not arbitrary gap consumption. */
export function verifyGaslessStorageLayout(baseline, current) {
	const type = (layout, id) => {
		const t = layout.types[id];
		return {
			encoding: t.encoding,
			label: t.label,
			numberOfBytes: t.numberOfBytes,
			...Object.fromEntries(["key", "value", "base"].filter(key => t[key]).map(key => [key, type(layout, t[key])])),
			...(t.members ? { members: t.members.map(m => field(layout, m)) } : {}),
		};
	};
	const field = (layout, s) => ({ label: s.label, slot: s.slot, offset: s.offset, type: type(layout, s.type) });
	const oldFields = baseline.storage.map(s => field(baseline, s));
	const newFields = current.storage.map(s => field(current, s));
	const uint = { encoding: "inplace", label: "uint256", numberOfBytes: "32" };
	const address = { encoding: "inplace", label: "address", numberOfBytes: "20" };
	const nonceMap = {
		encoding: "mapping",
		label: "mapping(address => mapping(address => uint256))",
		numberOfBytes: "32",
		key: address,
		value: { encoding: "mapping", label: "mapping(address => uint256)", numberOfBytes: "32", key: address, value: uint },
	};
	const gap = (slot, length) => ({
		label: "__gap",
		slot,
		offset: 0,
		type: { encoding: "inplace", label: `uint256[${length}]`, numberOfBytes: String(length * 32), base: uint },
	});
	const oldTail = [{ label: "walletOperationNonces", slot: "18", offset: 0, type: nonceMap.value }, gap("19", 33)];
	const newTail = [
		{ ...oldTail[0], label: "_legacyWalletOperationNonces" },
		{ label: "walletNonces", slot: "19", offset: 0, type: nonceMap },
		gap("20", 32),
	];
	if (
		digest(oldFields.slice(-2)) !== digest(oldTail) ||
		digest(newFields.slice(-3)) !== digest(newTail) ||
		digest(oldFields.slice(0, -2)) !== digest(newFields.slice(0, -3))
	)
		throw new Error("GaslessLayer storage layout differs from the reviewed indexed-wallet migration");
	return { layoutDigest: digest(newFields), baselineLayoutDigest: digest(oldFields) };
}
function keys(value, allowed, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label}.${key}`);
}
export function validateUpgradeConfig(value) {
	keys(value, ["apiVersion", "chainId", "target", "gaslessBaselineCommit", "policy", "discovery"], "config");
	if (value.apiVersion !== "operations.symm.io/account-instant-upgrade-v1" || value.chainId !== 42161)
		throw new Error("Expected the Arbitrum account/instant upgrade v1 config");
	if (digest(value.policy) !== digest(POLICY))
		throw new Error(
			"Upgrade policy must preserve configuration and GaslessLayer proxy, use Safe PartyB execution, and exclude InstantLayer user state, template repairs and global timelock setters",
		);
	const fields = ["core", "collateral", "accountLayer", "instantLayer", "gaslessLayer", "safe", "relayer"];
	keys(value.target, [...fields, "partyBAdmins"], "target");
	for (const name of fields) {
		try {
			if (getAddress(value.target[name]) === ZeroAddress) throw new Error();
		} catch {
			throw new Error(`Invalid target.${name}`);
		}
	}
	keys(value.target.partyBAdmins, Object.keys(value.target.partyBAdmins || {}), "partyBAdmins");
	for (const [partyB, admin] of Object.entries(value.target.partyBAdmins)) {
		if (getAddress(partyB) === ZeroAddress || getAddress(admin) === ZeroAddress) throw new Error("Invalid PartyB authority");
		if (getAddress(admin) !== getAddress(value.target.safe)) throw new Error(`target.partyBAdmins[${partyB}] must select target.safe`);
	}
	if (!/^[a-f0-9]{40}$/.test(value.gaslessBaselineCommit)) throw new Error("gaslessBaselineCommit must be an exact Git commit");
	keys(value.discovery, ["mode", "gaslessSelectors", "instantTargets", "instantPartyBs"], "discovery");
	if (value.discovery.mode !== "flow")
		throw new Error("discovery.mode must be flow; this upgrade uses direct reads for the supplied execution path");
	for (const name of ["gaslessSelectors", "instantTargets", "instantPartyBs"])
		if (!Array.isArray(value.discovery[name])) throw new Error(`Provide discovery.${name} as an explicit array of keys to verify`);
	for (const [name, entries] of Object.entries(value.discovery)) {
		if (name === "mode") continue;
		const pattern = name === "gaslessSelectors" ? /^0x[0-9a-fA-F]{8}$/ : /^0x[0-9a-fA-F]{40}$/;
		for (const entry of entries) if (!pattern.test(entry)) throw new Error(`Invalid discovery.${name} entry`);
	}
	for (const partyB of value.discovery.instantPartyBs)
		if (!Object.keys(value.target.partyBAdmins).some(address => address.toLowerCase() === partyB.toLowerCase()))
			throw new Error(`Missing target.partyBAdmins[${partyB}]`);
	return structuredClone(value);
}

/** Candidates to check, not a claim that unrelated role holders or mapping keys do not exist. */
export function flowDiscovery(config) {
	const unique = values => [...new Set(values.map(address => address.toLowerCase()))].sort();
	return {
		...config.discovery,
		gaslessRoleMembers: unique([config.target.safe, config.target.relayer]),
		instantRoleMembers: unique([config.target.safe, config.target.gaslessLayer, ...config.discovery.instantPartyBs]),
	};
}

/** A current selector may be baseline or desired (partial Safe execution); no third state is accepted. */
export function planAccountCut(baseline, current, facets) {
	if (digest(Object.keys(facets).sort()) !== digest([...ACCOUNT_FACETS].sort()))
		throw new Error("Exactly the five reviewed AccountLayer facets are required");
	const desired = { ...baseline },
		selected = new Map(),
		replacedAddresses = new Set();
	for (const name of ACCOUNT_FACETS) {
		const facet = facets[name];
		if (!facet.selectors?.length || getAddress(facet.address) === ZeroAddress) throw new Error(`Empty ${name}`);
		for (const selector of facet.selectors) {
			if (selected.has(selector)) throw new Error(`Selector collision ${selector}`);
			selected.set(selector, facet.address.toLowerCase());
			if (baseline[selector]) replacedAddresses.add(baseline[selector].toLowerCase());
			desired[selector] = facet.address.toLowerCase();
		}
	}
	for (const [selector, address] of Object.entries(baseline)) {
		if (replacedAddresses.has(address.toLowerCase()) && !selected.has(selector))
			throw new Error(`Replacement would omit existing selector ${selector}`);
	}
	for (const selector of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
		const value = current[selector]?.toLowerCase();
		if (value !== baseline[selector]?.toLowerCase() && value !== desired[selector]?.toLowerCase())
			throw new Error(`Selector drift at ${selector}`);
		if (!value && baseline[selector]) throw new Error(`Selector drift at ${selector}`);
	}
	const cut = [];
	for (const name of ACCOUNT_FACETS)
		for (const action of [1, 0]) {
			const facet = facets[name];
			const functionSelectors = facet.selectors
				.filter(s => current[s]?.toLowerCase() !== facet.address.toLowerCase() && Boolean(current[s]) === (action === 1))
				.sort();
			if (functionSelectors.length) cut.push({ facetAddress: facet.address, action, functionSelectors });
		}
	const iface = new Interface(["function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[],address,bytes)"]);
	return { desired, cut, calldata: cut.length ? iface.encodeFunctionData("diamondCut", [cut, ZeroAddress, "0x"]) : null };
}
