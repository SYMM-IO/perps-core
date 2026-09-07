import { getAddress, Interface, ZeroAddress } from "ethers";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_TAG = "version_0.8.6.2";
export const PRODUCTION_RELEASE_TAG = "version_0.8.6.2-funding";
export const RECIPE_PATH = "deployment-recipes/arbitrum-vibe-stage.json";
export const TARGET_PATH = "tasks/config/arbitrum-rounding-upgrade-42161.json";
export const ROUNDING_PROFILES = Object.freeze({
	stage: Object.freeze({ recipePath: RECIPE_PATH, targetPath: TARGET_PATH, recipeName: "arbitrum-vibe-stage", releaseTag: RELEASE_TAG }),
	production: Object.freeze({
		recipePath: "deployment-recipes/arbitrum-vibe-production-862.json",
		targetPath: "tasks/config/arbitrum-rounding-upgrade-vibe-production-42161.json",
		recipeName: "arbitrum-vibe-production-862",
		releaseTag: PRODUCTION_RELEASE_TAG,
	}),
	"stage-funding": Object.freeze({
		recipePath: RECIPE_PATH,
		targetPath: "tasks/config/arbitrum-funding-upgrade-vibe-stage-42161.json",
		recipeName: "arbitrum-vibe-stage",
		releaseTag: PRODUCTION_RELEASE_TAG,
	}),
});
export function roundingProfile(profile = "stage") {
	if (!Object.hasOwn(ROUNDING_PROFILES, profile)) throw new Error(`Unknown rounding upgrade profile: ${profile}`);
	return ROUNDING_PROFILES[profile];
}
export const requiresRoundingPause = input => ["production", "stage-funding"].includes(input?.profile);
export const isStageFunding = input => input?.profile === "stage-funding";
export const roundingSuffix = (profile = "stage") => {
	roundingProfile(profile);
	return profile === "stage-funding" ? "863" : "862";
};
export const roundingOwner = input => getAddress(input.target.owner || input.target.safe);
export const LIBRARIES = Object.freeze([
	"LibPartyALiquidationLegacySetup",
	"LibPartyALiquidationSnapshotSetup",
	"LibPartyALiquidationProcess",
	"ClearingHouseFacetImpl",
]);
export const FACETS = Object.freeze(["PartyALiquidationFacet", "PartyALiquidationSnapshotFacet", "ClearingHouseFacet", "ViewFacet"]);
export const DEPLOYMENTS = Object.freeze(["Create2Factory", ...LIBRARIES, ...FACETS]);
export const PRODUCTION_FACETS = Object.freeze([...FACETS, "FundingRateFacet"]);
const FUNDING_FACETS = Object.freeze(["FundingRateFacet"]);
export const roundingLibraries = (profile = "stage") => {
	roundingProfile(profile);
	return profile === "stage-funding" ? [] : LIBRARIES;
};
export function roundingFacets(profile = "stage") {
	roundingProfile(profile);
	if (profile === "stage-funding") return FUNDING_FACETS;
	return profile === "production" ? PRODUCTION_FACETS : FACETS;
}
export const roundingDeployments = (profile = "stage") => ["Create2Factory", ...roundingLibraries(profile), ...roundingFacets(profile)];
export const GETTER = new Interface(["function liquidationStartPositionCount(address) view returns (uint256)"]).getFunction(
	"liquidationStartPositionCount",
).selector;
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const selectorDigest = selectors =>
	digest(
		Object.fromEntries(
			Object.entries(selectors)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([s, a]) => [s.toLowerCase(), a.toLowerCase()]),
		),
	);
export const fileDigest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const gitAt = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function assertReleaseSource(root, input, profile = input?.profile || "stage") {
	const { targetPath, recipePath, releaseTag } = roundingProfile(profile);
	const git = args => gitAt(root, args);
	if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("Release requires a clean tracked worktree");
	const commit = git(["rev-parse", "HEAD"]);
	const releaseCommit = git(["rev-parse", `${releaseTag}^{commit}`]);
	const target = JSON.parse(fs.readFileSync(path.join(root, targetPath), "utf8"));
	if (git(["rev-parse", "HEAD:contracts"]) !== target.contractsTree || git(["rev-parse", `${releaseCommit}:contracts`]) !== target.contractsTree)
		throw new Error(
			`Contracts differ from the reviewed ${releaseTag} release; run ./symmio from .releases/version_0.8.6.2 or a clean descendant with the profile's tagged contracts`,
		);
	if (git(["log", "-1", "--format=%H", releaseCommit, "--", "contracts"]) !== releaseCommit)
		throw new Error(`${releaseTag} must point to the contract source change, not a later tooling commit`);
	try {
		git(["merge-base", "--is-ancestor", releaseCommit, commit]);
	} catch {
		throw new Error(`Run ./symmio from a descendant of ${releaseTag} with the same contracts`);
	}
	if (
		input &&
		(input.sourceCommit !== commit ||
			input.releaseCommit !== releaseCommit ||
			input.targetDigest !== fileDigest(path.join(root, targetPath)) ||
			input.recipeDigest !== fileDigest(path.join(root, recipePath)))
	) {
		throw new Error("Release tag, tooling source, target, or recipe changed since preparation");
	}
	if (
		input &&
		(input.release !== releaseTag ||
			digest(input.target) !== digest(target) ||
			digest(input.create2) !== digest(JSON.parse(fs.readFileSync(path.join(root, recipePath), "utf8")).create2) ||
			(profile === "production" && input.apiVersion !== "operations.symm.io/arbitrum-rounding-upgrade-v5") ||
			(profile === "stage-funding" && input.apiVersion !== "operations.symm.io/arbitrum-funding-upgrade-v1"))
	)
		throw new Error("Input differs from the release target or CREATE2 configuration");
	return commit;
}

export function assertRoundingFactoryIntent(create2) {
	if (JSON.stringify(create2?.factory) !== JSON.stringify({ mode: "deploy" }))
		throw new Error("Release requires a new temporary CREATE2 factory administered by the deployment signer");
}

export function buildRoundingInput(root, profile = "stage") {
	const { targetPath, recipePath, recipeName, releaseTag } = roundingProfile(profile);
	const sourceCommit = assertReleaseSource(root, undefined, profile);
	const target = JSON.parse(fs.readFileSync(path.join(root, targetPath), "utf8"));
	const recipe = JSON.parse(fs.readFileSync(path.join(root, recipePath), "utf8"));
	if (profile === "production" && (target.governanceMode !== "ledger" || !target.owner))
		throw new Error("Production target must bind its Ledger owner");
	if (profile === "stage-funding" && (target.governanceMode !== "safe-file" || !target.safe || !target.baselineSelectorDigest))
		throw new Error("Stage funding target must bind its Safe and installed selector baseline");
	const create2 = recipe.create2;
	if (recipe.name !== recipeName || getAddress(recipe.governance.admin) !== roundingOwner({ target }))
		throw new Error(`${profile} recipe must assign governance.admin to the reviewed Core owner`);
	assertRoundingFactoryIntent(create2);
	const suffix = roundingSuffix(profile);
	if (JSON.stringify(create2.groups?.facets) !== JSON.stringify({ suffix })) throw new Error(`Release facets must use exactly suffix ${suffix}`);
	return {
		apiVersion:
			profile === "stage-funding"
				? "operations.symm.io/arbitrum-funding-upgrade-v1"
				: `operations.symm.io/arbitrum-rounding-upgrade-v${profile === "production" ? 5 : 3}`,
		...(profile !== "stage" ? { profile } : {}),
		release: releaseTag,
		releaseCommit: gitAt(root, ["rev-parse", `${releaseTag}^{commit}`]),
		sourceCommit,
		targetDigest: fileDigest(path.join(root, targetPath)),
		recipeDigest: fileDigest(path.join(root, recipePath)),
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

export function planRoundingCut(baseline, current, facets, oldFacets, profile = "stage") {
	const selected = roundingFacets(profile);
	if (Object.keys(facets).sort().join() !== [...selected].sort().join())
		throw new Error(
			profile === "stage-funding"
				? "Exactly FundingRateFacet is required for the stage funding upgrade"
				: profile === "production"
					? "Exactly five production facets including FundingRateFacet are required"
					: "Exactly four rounding facets are required",
		);
	if (profile === "stage-funding") {
		if (!baseline[GETTER]) throw new Error("Stage funding upgrade requires the installed rounding getter");
	} else if (!facets.ViewFacet.selectors.includes(GETTER)) throw new Error("ViewFacet must expose the new rounding getter");
	const desired = { ...baseline };
	for (const name of selected) {
		const facet = facets[name];
		if (!facet.address.toLowerCase().endsWith(roundingSuffix(profile))) throw new Error(`${name} does not end in ${roundingSuffix(profile)}`);
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
