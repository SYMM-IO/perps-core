import { loadDeploymentRecipe } from "../recipe.js";
import Ajv from "ajv/dist/2020.js";
import { getAddress, ZeroAddress } from "ethers";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class OperationError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "OperationError";
		this.code = code;
	}
}
export const hashBytes = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map(key => [key, canonical(value[key])]),
		);
	return value;
}
export const operationDigest = value => hashBytes(JSON.stringify(canonical(value)));
const schema = JSON.parse(fs.readFileSync(new URL("./schemas/v1.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: false, strict: true });
ajv.addFormat("address", {
	type: "string",
	validate(value) {
		try {
			return getAddress(value) !== ZeroAddress;
		} catch {
			return false;
		}
	},
});
ajv.addSchema(schema);

/** Public schemas are the runtime validators; errors never echo supplied values. */
export function validateDocument(kind, value) {
	if (!Object.hasOwn(schema.$defs, kind)) throw new OperationError("invalid-document", "Unknown operation document kind");
	const validate = ajv.getSchema(`${schema.$id}#/$defs/${kind}`);
	if (!validate(value)) {
		const error = validate.errors[0];
		throw new OperationError("invalid-document", `${kind}${error.instancePath}: ${error.message}`);
	}
	return value;
}

export function readOperationJson(file) {
	try {
		const bytes = fs.readFileSync(file);
		if (bytes.length > 16 * 1024 * 1024) throw new Error("size");
		return { value: JSON.parse(bytes.toString("utf8")), hash: hashBytes(bytes) };
	} catch {
		throw new OperationError("unreadable-document", "Operation dependency is missing, oversized or invalid JSON");
	}
}

/** Each relative reference belongs to the document containing it, never to the shell cwd. */
export function loadOperation(requestFile) {
	const requestPath = path.resolve(requestFile);
	const requestDoc = readOperationJson(requestPath);
	const request = validateDocument("request", requestDoc.value);
	const profilePath = path.resolve(path.dirname(requestPath), request.deploymentProfile);
	const releasePath = path.resolve(path.dirname(requestPath), request.parameters.releaseManifest);
	const profileDoc = readOperationJson(profilePath),
		releaseDoc = readOperationJson(releasePath);
	const profile = validateDocument("profile", profileDoc.value),
		release = validateDocument("release", releaseDoc.value);
	const recipePath = path.resolve(path.dirname(profilePath), profile.credentialRecipe);
	let recipe;
	try {
		recipe = loadDeploymentRecipe(recipePath);
	} catch {
		throw new OperationError("invalid-credentials", "Credential recipe failed validation; use a valid deployment recipe with secret references");
	}
	for (const key of ["name", "chainId", "mode"])
		if (profile.network[key] !== recipe.recipe.network[key])
			throw new OperationError("network-mismatch", "Profile and credential recipe network differ");
	const artifacts = release.components.core.facets.map(entry => {
		const artifact = readOperationJson(path.resolve(path.dirname(releasePath), entry.artifactPath));
		if (artifact.hash !== entry.sha256) throw new OperationError("artifact-mismatch", "Release artifact hash mismatch");
		const a = artifact.value;
		if (
			typeof a.contractName !== "string" ||
			!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.contractName) ||
			typeof a.sourceName !== "string" ||
			!/^[A-Za-z0-9_./-]+\.sol$/.test(a.sourceName) ||
			!Array.isArray(a.abi) ||
			typeof a.bytecode !== "string" ||
			a.bytecode.length <= 2 ||
			typeof a.deployedBytecode !== "string" ||
			a.deployedBytecode.length <= 2 ||
			!a.linkReferences ||
			!a.deployedLinkReferences
		)
			throw new OperationError("invalid-artifact", "Expected a compiled Hardhat contract artifact");
		return a;
	});
	const names = artifacts.map(a => `${a.sourceName}:${a.contractName}`);
	if (new Set(names).size !== names.length) throw new OperationError("duplicate-artifact", "Release repeats a facet artifact");
	const bindings = {
		request: requestDoc.hash,
		profile: profileDoc.hash,
		release: releaseDoc.hash,
		recipe: hashBytes(fs.readFileSync(recipePath)),
		artifacts: release.components.core.facets.map(f => f.sha256),
	};
	const resolved = validateDocument("resolved", {
		schemaVersion: 1,
		kind: "symmio.resolved-input",
		request,
		profile,
		release,
		bindings,
		inputDigest: operationDigest(bindings),
	});
	return { requestPath, recipe, resolved, artifacts };
}

export function assertOperationUnchanged(file, inputDigest) {
	const loaded = loadOperation(file);
	if (loaded.resolved.inputDigest !== inputDigest)
		throw new OperationError("input-drift", "Operation request or a bound dependency changed; create a new reviewed plan");
	return loaded;
}
