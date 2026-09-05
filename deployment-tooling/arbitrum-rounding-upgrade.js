import { getAddress, Interface, ZeroAddress } from "ethers";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_TAG = "version_0.8.6.2";
export const RECIPE_PATH = "deployment-recipes/arbitrum-vibe-stage.json";
export const TARGET_PATH = "tasks/config/arbitrum-rounding-upgrade-42161.json";
export const LIBRARIES = Object.freeze([
	"LibPartyALiquidationLegacySetup",
	"LibPartyALiquidationSnapshotSetup",
	"LibPartyALiquidationProcess",
	"ClearingHouseFacetImpl",
]);
export const FACETS = Object.freeze(["PartyALiquidationFacet", "PartyALiquidationSnapshotFacet", "ClearingHouseFacet", "ViewFacet"]);
export const DEPLOYMENTS = Object.freeze(["Create2Factory", ...LIBRARIES, ...FACETS]);
export const GETTER = new Interface(["function liquidationStartPositionCount(address) view returns (uint256)"]).getFunction(
	"liquidationStartPositionCount",
).selector;
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const fileDigest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function assertReleaseSource(root, input) {
	const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("Release requires a clean tracked worktree");
	const commit = git(["rev-parse", "HEAD"]);
	if (git(["rev-parse", `${RELEASE_TAG}^{commit}`]) !== commit) throw new Error(`Run ./symmio from the checkout tagged ${RELEASE_TAG}`);
	const target = JSON.parse(fs.readFileSync(path.join(root, TARGET_PATH), "utf8"));
	if (git(["rev-parse", "HEAD:contracts"]) !== target.contractsTree) throw new Error("Contracts differ from the reviewed rounding-only release");
	if (
		input &&
		(input.sourceCommit !== commit ||
			input.targetDigest !== fileDigest(path.join(root, TARGET_PATH)) ||
			input.recipeDigest !== fileDigest(path.join(root, RECIPE_PATH)))
	) {
		throw new Error("Release source, target, or recipe changed since preparation");
	}
	if (
		input &&
		(input.release !== RELEASE_TAG ||
			digest(input.target) !== digest(target) ||
			digest(input.create2) !== digest(JSON.parse(fs.readFileSync(path.join(root, RECIPE_PATH), "utf8")).create2))
	)
		throw new Error("Input differs from the tagged release target or CREATE2 configuration");
	return commit;
}

export function assertRoundingFactoryIntent(create2) {
	if (JSON.stringify(create2?.factory) !== JSON.stringify({ mode: "deploy" }))
		throw new Error("Release requires a new temporary CREATE2 factory administered by the deployment signer");
}

export function buildRoundingInput(root) {
	const sourceCommit = assertReleaseSource(root);
	const target = JSON.parse(fs.readFileSync(path.join(root, TARGET_PATH), "utf8"));
	const recipe = JSON.parse(fs.readFileSync(path.join(root, RECIPE_PATH), "utf8"));
	const create2 = recipe.create2;
	if (recipe.name !== "arbitrum-vibe-stage" || getAddress(recipe.governance.admin) !== getAddress(target.safe))
		throw new Error("Stage recipe must assign governance.admin to the reviewed Core multisig");
	assertRoundingFactoryIntent(create2);
	if (JSON.stringify(create2.groups?.facets) !== JSON.stringify({ suffix: "862" })) throw new Error("Release facets must use exactly suffix 862");
	return {
		apiVersion: "operations.symm.io/arbitrum-rounding-upgrade-v2",
		release: RELEASE_TAG,
		sourceCommit,
		targetDigest: fileDigest(path.join(root, TARGET_PATH)),
		recipeDigest: fileDigest(path.join(root, RECIPE_PATH)),
		target,
		create2,
	};
}

export function selectorMap(facets) {
	const result = {};
	for (const facet of facets)
		for (const selector of facet.functionSelectors || facet.selectors) {
			if (result[selector]) throw new Error(`Duplicate live selector ${selector}`);
			result[selector] = getAddress(facet.facetAddress || facet.address);
		}
	return result;
}

export function planRoundingCut(baseline, current, facets, oldFacets) {
	if (Object.keys(facets).sort().join() !== [...FACETS].sort().join()) throw new Error("Exactly four rounding facets are required");
	if (!facets.ViewFacet.selectors.includes(GETTER)) throw new Error("ViewFacet must expose the new rounding getter");
	const desired = { ...baseline };
	for (const name of FACETS) {
		const facet = facets[name];
		if (!facet.address.toLowerCase().endsWith("862")) throw new Error(`${name} does not end in 862`);
		for (const selector of facet.selectors) {
			if (selector === GETTER && name === "ViewFacet") {
				if (baseline[selector]) throw new Error("Rounding getter already exists in baseline");
			} else if (baseline[selector]?.toLowerCase() !== oldFacets[name].address.toLowerCase()) {
				throw new Error(`${name}: selector ${selector} is outside the reviewed baseline facet`);
			}
			desired[selector] = getAddress(facet.address);
		}
		for (const [selector, address] of Object.entries(baseline)) {
			if (address.toLowerCase() === oldFacets[name].address.toLowerCase() && !facet.selectors.includes(selector))
				throw new Error(`${name} would omit baseline selector ${selector}`);
		}
	}
	const identical = (a, b) =>
		Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([s, address]) => address.toLowerCase() === b[s]?.toLowerCase());
	if (!identical(current, baseline) && !identical(current, desired))
		throw new Error("Core selectors changed outside this release; inspect before rebuilding the cut");
	const groups = new Map();
	for (const [selector, address] of Object.entries(desired)) {
		if (current[selector]?.toLowerCase() === address.toLowerCase()) continue;
		const action = current[selector] ? 1 : 0;
		const key = `${address}:${action}`;
		if (!groups.has(key)) groups.set(key, { facetAddress: address, action, functionSelectors: [] });
		groups.get(key).functionSelectors.push(selector);
	}
	const cut = [...groups.values()];
	const iface = new Interface([
		"function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes data)",
	]);
	return { desired, cut, calldata: cut.length ? iface.encodeFunctionData("diamondCut", [cut, ZeroAddress, "0x"]) : null };
}
