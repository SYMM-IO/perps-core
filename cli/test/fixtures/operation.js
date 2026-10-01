import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const operationAddress = n => `0x${n.toString(16).padStart(40, "0")}`;
export const operationHash = n => `0x${n.toString(16).padStart(64, "0")}`;
export function operationFixture(root) {
	const dir = path.join(root, "inputs");
	fs.mkdirSync(dir, { recursive: true });
	const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
	const artifactFile = path.join(dir, "facet.json");
	const artifact = {
		contractName: "NewFacet",
		sourceName: "contracts/NewFacet.sol",
		abi: ["function foo()", "function bar()"],
		bytecode: "0x60006000",
		deployedBytecode: "0x6000",
		linkReferences: {},
		deployedLinkReferences: {},
	};
	write(artifactFile, artifact);
	const recipe = JSON.parse(fs.readFileSync(new URL("../../../deployment-recipes/localhost.json", import.meta.url)));
	const recipeFile = path.join(dir, "credentials.json");
	write(recipeFile, recipe);
	const profile = {
		schemaVersion: 1,
		kind: "symmio.deployment-profile",
		id: "fixture",
		network: recipe.network,
		credentialRecipe: "credentials.json",
		components: { core: { address: operationAddress(1), upgradeAuthority: operationAddress(2) } },
	};
	const profileFile = path.join(dir, "profile.json");
	write(profileFile, profile);
	const release = {
		schemaVersion: 1,
		kind: "symmio.release",
		id: "fixture-release",
		sourceCommit: "a".repeat(40),
		buildProfile: "production",
		components: {
			core: {
				facets: [
					{ artifactPath: "facet.json", sha256: "sha256:" + createHash("sha256").update(fs.readFileSync(artifactFile)).digest("hex") },
				],
				allowedRemovedSelectors: [],
				baselineFacetCodeHashes: [operationHash(3)],
				migrations: [],
			},
		},
	};
	const releaseFile = path.join(dir, "release.json");
	write(releaseFile, release);
	const request = {
		schemaVersion: 1,
		kind: "symmio.operation",
		deploymentProfile: "profile.json",
		operation: "upgrade",
		parameters: { components: ["core"], releaseManifest: "release.json" },
		execution: { mode: "plan" },
	};
	const file = path.join(dir, "request.json");
	write(file, request);
	return { file, profileFile, releaseFile, recipeFile, artifactFile, profile, release, request, artifact };
}
