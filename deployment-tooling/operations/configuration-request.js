import { buildConfigurationMigration, captureConfigurationSnapshot, validateConfigurationProfile } from "./configuration-migration.js";
import { operationDigest, readOperationJson } from "./inputs.js";
import path from "node:path";

export function loadConfigurationRequest(file) {
	const loaded = readOperationJson(file),
		request = loaded.value;
	const required = ["schemaVersion", "kind", "sourceCommit", "credentialRecipe", "profile", "sourceCheckpoint"];
	if (
		request?.schemaVersion !== 1 ||
		request.kind !== "symmio.configuration-request" ||
		Object.keys(request).some(key => ![...required, "target"].includes(key)) ||
		required.some(key => !Object.hasOwn(request, key)) ||
		!/^[0-9a-f]{40}$/.test(request.sourceCommit) ||
		typeof request.credentialRecipe !== "string"
	)
		throw new Error("Invalid configuration request");
	if (
		!request.profile ||
		Object.keys(request.profile).sort().join(",") !== "file,sha256" ||
		typeof request.profile.file !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(request.profile.sha256)
	)
		throw new Error("Configuration profile requires a file and SHA-256");
	const profile = readOperationJson(path.resolve(path.dirname(file), request.profile.file));
	if (profile.hash !== request.profile.sha256) throw new Error("Configuration profile changed");
	validateConfigurationProfile(profile.value);
	const checkpoint = value => {
		if (
			!value ||
			Object.keys(value).sort().join(",") !== "blockHash,blockNumber" ||
			!Number.isSafeInteger(value.blockNumber) ||
			value.blockNumber < 0 ||
			!/^0x[0-9a-fA-F]{64}$/.test(value.blockHash)
		)
			throw new Error("Invalid configuration request checkpoint");
	};
	checkpoint(request.sourceCheckpoint);
	if (request.target) {
		if (
			Object.keys(request.target).sort().join(",") !== "checkpoint,contract" ||
			!request.target.contract ||
			Object.keys(request.target.contract).some(key => !["address", "codeHash", "implementation"].includes(key)) ||
			!/^0x[0-9a-fA-F]{40}$/.test(request.target.contract.address) ||
			!/^0x[0-9a-fA-F]{64}$/.test(request.target.contract.codeHash)
		)
			throw new Error("Invalid configuration target");
		checkpoint(request.target.checkpoint);
	}
	return {
		path: path.resolve(file),
		request,
		profile: profile.value,
		recipePath: path.resolve(path.dirname(file), request.credentialRecipe),
		inputDigest: operationDigest({ request: loaded.hash, profile: profile.hash }),
	};
}

export async function prepareConfiguration(provider, bundle) {
	const snapshot = await captureConfigurationSnapshot(provider, bundle.profile, bundle.request.sourceCheckpoint);
	const plan = bundle.request.target
		? await buildConfigurationMigration(provider, bundle.profile, snapshot, bundle.request.target.contract, bundle.request.target.checkpoint)
		: null;
	return {
		schemaVersion: 1,
		kind: "symmio.prepared-configuration",
		inputDigest: bundle.inputDigest,
		status: plan ? "planned" : "inspected",
		snapshot,
		plan,
	};
}
