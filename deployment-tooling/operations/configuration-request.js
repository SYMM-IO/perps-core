import {
	buildConfigurationMigration,
	captureConfigurationSnapshot,
	validateConfigurationProfile,
	verifyConfigurationMigration,
} from "./configuration-migration.js";
import { operationDigest, readOperationJson } from "./inputs.js";
import { captureMuonConfiguration, validateMuonProfile, verifyMuonConfiguration } from "./muon-upgrade.js";
import { buildRoleMigration, captureRoleMigration, readRoleInventory, validateRoleProfile, verifyRoleMigration } from "./role-migration.js";
import { buildWiringMigration, captureWiringSnapshot, validateWiringProfile, verifyWiringMigration } from "./wiring-migration.js";
import { getAddress } from "ethers";
import path from "node:path";

export function loadConfigurationRequest(file) {
	const loaded = readOperationJson(file),
		request = loaded.value;
	const required = ["schemaVersion", "kind", "sourceCommit", "credentialRecipe", "profile", "sourceCheckpoint"];
	if (
		request?.schemaVersion !== 1 ||
		request.kind !== "symmio.configuration-request" ||
		Object.keys(request).some(key => ![...required, "target", "roles", "wiring", "muon"].includes(key)) ||
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
	if (Object.hasOwn(request, "target")) {
		if (
			!request.target ||
			Object.keys(request.target).sort().join(",") !== "checkpoint,contract" ||
			!request.target.contract ||
			Object.keys(request.target.contract).some(key => !["address", "codeHash", "implementation"].includes(key)) ||
			!/^0x[0-9a-fA-F]{40}$/.test(request.target.contract.address) ||
			!/^0x[0-9a-fA-F]{64}$/.test(request.target.contract.codeHash)
		)
			throw new Error("Invalid configuration target");
		checkpoint(request.target.checkpoint);
	}
	const dependency = (name, extras) => {
		const reference = request[name];
		if (!Object.hasOwn(request, name)) return null;
		if (
			!reference ||
			typeof reference !== "object" ||
			Array.isArray(reference) ||
			(name !== "muon" && !request.target) ||
			Object.keys(reference).sort().join(",") !== ["file", "sha256", ...extras].sort().join(",") ||
			typeof reference.file !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(reference.sha256)
		)
			throw new Error(`Invalid ${name} configuration dependency; a deployed target is required`);
		const document = readOperationJson(path.resolve(path.dirname(file), reference.file));
		if (document.hash !== reference.sha256) throw new Error(`Configuration ${name} profile changed`);
		if (document.value.chainId !== profile.value.chainId) throw new Error(`Configuration ${name} chain differs`);
		return document;
	};
	const roles = dependency("roles", ["maxMembersPerRole"]),
		wiring = dependency("wiring", ["dependency"]),
		muon = dependency("muon", []);
	if (muon) validateMuonProfile(muon.value);
	if (roles) {
		validateRoleProfile(roles.value);
		if (
			!Number.isSafeInteger(request.roles.maxMembersPerRole) ||
			request.roles.maxMembersPerRole < 1 ||
			operationDigest(roles.value.source) !== operationDigest(profile.value.source) ||
			operationDigest(roles.value.target) !== operationDigest(request.target.contract)
		)
			throw new Error("Role profile does not bind the configuration source, target or enumeration limit");
	}
	if (wiring) {
		validateWiringProfile(wiring.value);
		if (
			!/^[a-z][a-z0-9-]*$/.test(request.wiring.dependency) ||
			wiring.value.bindings.some(
				binding =>
					binding.dependency !== request.wiring.dependency || getAddress(binding.source) !== getAddress(profile.value.source.address),
			)
		)
			throw new Error("Wiring profile does not bind this configuration replacement");
	}
	return {
		path: path.resolve(file),
		request,
		profile: profile.value,
		roles: roles?.value || null,
		wiring: wiring?.value || null,
		muon: muon?.value || null,
		recipePath: path.resolve(path.dirname(file), request.credentialRecipe),
		inputDigest: operationDigest({
			request: loaded.hash,
			profile: profile.hash,
			...(roles ? { roles: roles.hash } : {}),
			...(wiring ? { wiring: wiring.hash } : {}),
			...(muon ? { muon: muon.hash } : {}),
		}),
	};
}

export async function prepareConfiguration(provider, bundle) {
	const snapshot = await captureConfigurationSnapshot(provider, bundle.profile, bundle.request.sourceCheckpoint);
	const plan = bundle.request.target
		? await buildConfigurationMigration(provider, bundle.profile, snapshot, bundle.request.target.contract, bundle.request.target.checkpoint)
		: null;
	let roles = null,
		wiring = null;
	if (bundle.roles) {
		const inventory = await readRoleInventory(provider, bundle.roles, bundle.request.sourceCheckpoint, bundle.request.roles.maxMembersPerRole);
		const snapshot = await captureRoleMigration(provider, bundle.roles, inventory, {
			source: bundle.request.sourceCheckpoint,
			target: bundle.request.target.checkpoint,
		});
		await captureRoleMigration(provider, bundle.roles, inventory, {
			source: bundle.request.target.checkpoint,
			target: bundle.request.target.checkpoint,
		});
		roles = { inventory, snapshot, plan: buildRoleMigration(bundle.roles, snapshot) };
	}
	if (bundle.wiring) {
		const snapshot = await captureWiringSnapshot(provider, bundle.wiring, bundle.request.sourceCheckpoint);
		const current = await captureWiringSnapshot(provider, bundle.wiring, bundle.request.target.checkpoint);
		if (operationDigest(snapshot.observations) !== operationDigest(current.observations))
			throw new Error("Consumer wiring changed since the source checkpoint");
		wiring = {
			snapshot,
			plan: buildWiringMigration(bundle.wiring, current, { [bundle.request.wiring.dependency]: bundle.request.target.contract.address }),
		};
	}
	const muon = bundle.muon ? await captureMuonConfiguration(provider, bundle.muon, bundle.request.sourceCheckpoint) : null;
	if (muon && bundle.request.target)
		await verifyMuonConfiguration(provider, bundle.muon, muon, bundle.request.target.checkpoint, operationDigest(muon));
	return {
		schemaVersion: 1,
		kind: "symmio.prepared-configuration",
		inputDigest: bundle.inputDigest,
		status: plan ? "planned" : "inspected",
		snapshot,
		plan,
		roles,
		wiring,
		muon,
	};
}

/** Post-state evidence only: transaction execution/receipt verification belongs to the execution adapter. */
export async function verifyPreparedConfiguration(provider, bundle, prepared, checkpoint, reviewedEvidenceDigest) {
	if (operationDigest(prepared) !== reviewedEvidenceDigest) throw new Error("Reviewed configuration evidence changed");
	if (
		prepared.inputDigest !== bundle.inputDigest ||
		prepared.kind !== "symmio.prepared-configuration" ||
		!prepared.plan ||
		Boolean(prepared.roles) !== Boolean(bundle.roles) ||
		Boolean(prepared.wiring) !== Boolean(bundle.wiring) ||
		Boolean(prepared.muon) !== Boolean(bundle.muon)
	)
		throw new Error("Prepared configuration binding differs");
	if (
		prepared.plan.chainId !== bundle.profile.chainId ||
		operationDigest(prepared.plan.target) !== operationDigest(bundle.request.target?.contract)
	)
		throw new Error("Prepared target binding differs");
	if (
		prepared.plan.profileDigest !== operationDigest(bundle.profile) ||
		(prepared.roles && prepared.roles.plan.profileDigest !== operationDigest(bundle.roles)) ||
		(prepared.wiring && prepared.wiring.plan.profileDigest !== operationDigest(bundle.wiring))
	)
		throw new Error("Prepared profile binding differs");
	return {
		configuration: await verifyConfigurationMigration(provider, prepared.plan, checkpoint),
		roles: prepared.roles ? await verifyRoleMigration(provider, prepared.roles.plan, checkpoint) : null,
		wiring: prepared.wiring ? await verifyWiringMigration(provider, prepared.wiring.plan, checkpoint) : null,
		muon: prepared.muon ? await verifyMuonConfiguration(provider, bundle.muon, prepared.muon, checkpoint, operationDigest(prepared.muon)) : null,
	};
}
