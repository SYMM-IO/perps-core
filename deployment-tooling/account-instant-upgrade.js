import { getAddress, Interface, ZeroAddress } from "ethers";
import { createHash } from "node:crypto";

export const ACCOUNT_FACETS = Object.freeze(["CoreFacet", "MarginFacet", "ControlFacet", "ViewFacet", "TimelockFacet"]);
export const UPGRADE_DEPLOYMENTS = Object.freeze(["LibQuoteParams", ...ACCOUNT_FACETS, "InstantLayer", "GaslessLayer"]);
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
			"Upgrade policy must preserve configuration and GaslessLayer proxy, excluding InstantLayer user state, template repairs and global timelock setters",
		);
	const fields = ["core", "collateral", "accountLayer", "instantLayer", "gaslessLayer", "safe"];
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
	}
	if (!/^[a-f0-9]{40}$/.test(value.gaslessBaselineCommit)) throw new Error("gaslessBaselineCommit must be an exact Git commit");
	keys(value.discovery, ["gaslessRoles", "gaslessSelectors", "instantTargets", "instantPartyBs", "instantRoles"], "discovery");
	for (const [name, entries] of Object.entries(value.discovery)) {
		if (!Array.isArray(entries)) throw new Error(`discovery.${name} must be an explicitly reviewed complete array`);
		const pattern = name === "gaslessSelectors" ? /^0x[0-9a-fA-F]{8}$/ : name.endsWith("Roles") ? /^0x[0-9a-fA-F]{64}$/ : /^0x[0-9a-fA-F]{40}$/;
		for (const entry of entries) if (!pattern.test(entry)) throw new Error(`Invalid discovery.${name} entry`);
	}
	return structuredClone(value);
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
