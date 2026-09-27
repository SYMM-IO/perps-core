import { digest } from "./account-instant-upgrade.js";
import { Interface, ZeroAddress, getAddress } from "ethers";

export { digest };

export const CORE_UPGRADE_CONFIG = "tasks/config/arbitrum-core-upgrade-42161.json";
export const CORE_UPGRADE_RECIPE = "deployment-recipes/arbitrum-vibe-production.json";
export const CORE_UPGRADE_API = "operations.symm.io/arbitrum-core-upgrade-v1";
export const CUT_SELECTOR = "0x1f931c1c";
const cutInterface = new Interface(["function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[],address,bytes)"]);

export function validateCoreUpgradeConfig(config) {
	if (config?.apiVersion !== "operations.symm.io/arbitrum-core-upgrade-config-v1" || config.chainId !== 42161)
		throw new Error("Core upgrade requires the Arbitrum 42161 profile");
	for (const key of Object.keys(config))
		if (!["apiVersion", "chainId", "target", "limits", "repairAggregateFunding", "pledgeTokens", "allowedRemovedSelectors"].includes(key))
			throw new Error(`Unknown Core upgrade option ${key}`);
	for (const name of [
		"core",
		"safe",
		"accountLayer",
		"instantLayer",
		"gaslessLayer",
		"collateral",
		"signatureVerifier",
		"symbolManager",
		"partyB",
		"liquidator",
		"gaslessReceiver",
	]) {
		if (!config.target?.[name] || getAddress(config.target[name]) === ZeroAddress) throw new Error(`Invalid target ${name}`);
	}
	if (
		config.target.core.toLowerCase() !== "0x573310db6d160b26026b8706ebe9831c7def1d09" ||
		config.target.safe.toLowerCase() !== "0x89be952790657297ac03f1954b22b668d819d3d9"
	)
		throw new Error("This workflow is bound to the reviewed Vibe Core and Dev Safe");
	for (const field of ["maxQuotes", "maxSymbols"])
		if (!Number.isSafeInteger(config.limits?.[field]) || config.limits[field] < 1) throw new Error(`Invalid scan limit ${field}`);
	if (config.repairAggregateFunding !== true) throw new Error("This release requires aggregate funding reconciliation");
	if (!Array.isArray(config.pledgeTokens)) throw new Error("An explicit pledge token list is required; an empty list disables new pledge deposits");
	const tokens = config.pledgeTokens.map(token => getAddress(token));
	if (tokens.includes(ZeroAddress) || new Set(tokens).size !== tokens.length) throw new Error("Invalid or duplicate pledge token");
	if (digest(config.allowedRemovedSelectors) !== digest(["0x9dcdbdda", "0xff363ccc"])) throw new Error("Unreviewed selector removal policy");
	return config;
}

export function planCoreCut(baseline, current, facets, allowedRemovedSelectors) {
	if (!baseline[CUT_SELECTOR]) throw new Error("Baseline diamondCut selector is missing");
	const desired = { [CUT_SELECTOR]: baseline[CUT_SELECTOR] };
	for (const facet of Object.values(facets)) {
		if (getAddress(facet.address) === ZeroAddress) throw new Error("Zero facet address");
		for (const selector of facet.selectors) {
			if (desired[selector]) throw new Error(`Duplicate or reserved selector ${selector}`);
			desired[selector] = facet.address.toLowerCase();
		}
	}
	if (Object.keys(desired).length < 2) throw new Error("Empty Core facet selection");
	const removed = Object.keys(baseline)
		.filter(s => !desired[s])
		.sort();
	if (removed.some(s => !allowedRemovedSelectors.includes(s))) throw new Error(`Unreviewed removed selectors: ${removed.join(", ")}`);
	const same = (a, b) => digest(a) === digest(b);
	if (same(current, desired)) return { desired, removed, cut: [], calldata: null };
	if (!same(current, baseline)) throw new Error("Installed selectors differ from both baseline and completed atomic cut");
	const groups = new Map();
	for (const selector of [...new Set([...Object.keys(baseline), ...Object.keys(desired)])].sort()) {
		if (baseline[selector] === desired[selector]) continue;
		const action = !desired[selector] ? 2 : baseline[selector] ? 1 : 0;
		const facetAddress = desired[selector] || ZeroAddress;
		const key = `${action}:${facetAddress}`;
		const group = groups.get(key) || { facetAddress, action, functionSelectors: [] };
		group.functionSelectors.push(selector);
		groups.set(key, group);
	}
	const cut = [...groups.values()];
	return { desired, removed, cut, calldata: cutInterface.encodeFunctionData("diamondCut", [cut, ZeroAddress, "0x"]) };
}

export function assertCoreEvidence(report, field, expectedDigest) {
	if (!expectedDigest || digest(report[field]) !== expectedDigest) throw new Error(`Core upgrade ${field} evidence changed`);
	return report[field];
}
