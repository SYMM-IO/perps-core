import { CHAINS } from "../cli/lib/context.js";
import { muonUpgradePolicy } from "./operations/muon-upgrade.js";
import { parseSecretRef, validateDeploymentRecipe } from "./recipe.js";
import Ajv from "ajv";
import { getAddress, ZeroAddress, id } from "ethers";
import fs from "node:fs";

export const CORE_INPUT_API = "operations.symm.io/core-upgrade-input-v1";
export const CORE_INPUT_API_V2 = "operations.symm.io/core-upgrade-input-v2";
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(
	JSON.parse(fs.readFileSync(new URL("./core-upgrade-input.schema.json", import.meta.url))),
);
export function validateCoreUpgradeInput(input) {
	if (!validateSchema(input)) throw new Error(`Invalid Core upgrade input: ${JSON.stringify(validateSchema.errors)}`);
	muonUpgradePolicy(coreUpgradeMuonPolicy(input));
	const network = CHAINS[input.network.name],
		fork = CHAINS[input.network.fork];
	if (!network || network.simulated || network.chainId !== input.network.chainId || !fork?.simulated || fork.upstream !== input.network.name)
		throw new Error("Input must select a configured live network and its matching rehearsal fork");
	for (const [key, value] of Object.entries({
		...input.target,
		owner: input.governance.owner,
		accountLayerOwner: input.governance.accountLayerOwner,
	}))
		if (getAddress(value) === ZeroAddress) throw new Error(`Zero ${key} address`);
	for (const [purpose, ref] of Object.entries(input.credentials)) parseSecretRef(ref, `credentials.${purpose}`);
	if (!input.credentials.deployer.startsWith("hardhat-keystore://")) throw new Error("Deployment signer must use the input keystore reference");
	if (input.governance.kind === "safe" && input.governance.signerMode !== "safe-file")
		throw new Error("Safe governance requires safe-file delivery");
	if (input.governance.kind === "eoa" && !["ledger", "hardhat-keystore"].includes(input.governance.signerMode))
		throw new Error("EOA governance requires Ledger or Hardhat keystore signing");
	if (input.governance.signerMode === "hardhat-keystore" && !input.governance.signerKey)
		throw new Error("Governance keystore reference is required");
	if (input.governance.signerMode === "ledger" && !input.governance.ledgerDerivation)
		throw new Error("Ledger derivation family is required in the input");
	if (
		(input.governance.signerMode !== "ledger" && input.governance.ledgerDerivation) ||
		(input.governance.signerMode !== "hardhat-keystore" && input.governance.signerKey)
	)
		throw new Error("Governance credential fields must match the selected signer mode");
	for (const item of Object.values(input.inventory || {}))
		if (item.kind !== "subgraph" && getAddress(item.address) === ZeroAddress) throw new Error("Zero inventory address");
	const grants = new Set();
	for (const grant of coreUpgradeRoleGrants(input)) {
		if (getAddress(grant.holder) === ZeroAddress) throw new Error("Zero role holder");
		if (grant.role === "MIGRATION_ROLE" && grant.holder.toLowerCase() === input.governance.owner.toLowerCase())
			throw new Error("The Core owner's migration role must be restored, not persistently granted");
		const key = `${grant.holder.toLowerCase()}:${id(grant.role)}`;
		if (grants.has(key)) throw new Error("Duplicate role grant");
		grants.add(key);
	}
	const removals = coreUpgradePolicies(input).selectors.core.allowedRemovals;
	if (new Set(removals).size !== removals.length) throw new Error("Duplicate removed selector");
	coreUpgradeRecipe(input);
	return input;
}
export const isStandardCoreInput = config => [CORE_INPUT_API, CORE_INPUT_API_V2].includes(config?.apiVersion);

/** Keep historical profiles unchanged; scoped verifier bounds join their Muon policy. */
export function coreUpgradeMuonPolicy(config) {
	const policy = config.muon || {},
		limits = config.limits?.signatureVerifierSnapshot;
	if (!limits) return policy;
	if (Object.hasOwn(policy, "maxRoleMembers") || Object.hasOwn(policy, "maxSigners"))
		throw new Error("limits.signatureVerifierSnapshot: verifier scan limits must not also be declared in muon");
	return { ...policy, maxRoleMembers: limits.maxRoleMembers, maxSigners: limits.maxSigners };
}

export function coreUpgradeLimits(config) {
	const verifier = muonUpgradePolicy(coreUpgradeMuonPolicy(config));
	return {
		coreSnapshot: config.limits.coreSnapshot || {
			maxHistoricalQuotes: config.limits.maxQuotes,
			maxRegisteredSymbols: config.limits.maxSymbols,
		},
		signatureVerifierSnapshot: { maxRoleMembers: verifier.maxRoleMembers, maxSigners: verifier.maxSigners },
	};
}

export function coreUpgradeInputReview(config) {
	if (!isStandardCoreInput(config)) return `target.core: Core (${config.target.core}); existing dependencies remain in place`;
	const muon = muonUpgradePolicy(coreUpgradeMuonPolicy(config)),
		purposes = {
			core: "Core upgrade target",
			collateral: "existing collateral token",
			accountLayer: "existing Account Layer; owner and wiring checks",
			instantLayer: "existing Instant Layer; wiring and role checks",
			signatureVerifier: "existing Signature Verifier; Muon configuration and administrative membership checks",
			symbolManager: "existing Symbol Manager; runtime and required Core role checks",
			gaslessLayer: "existing Gasless Layer; wiring and role checks",
			liquidator: "existing Liquidator; runtime and Core role checks",
			gaslessReceiver: "existing Gasless treasury receiver",
			partyB: "existing solver PartyB contract; wiring and role checks",
			multicall: "snapshot read batching contract",
		};
	return [
		`network: ${config.network.name} (${config.network.chainId}); optional rehearsal ${config.network.fork}`,
		`release.ref: Core target Solidity ${config.release.ref}`,
		`release.baselineRef: Core baseline Git provenance ${config.release.baselineRef}; deployed bytecode checks are separate`,
		`credentials.deployer: new Core facet/library deployment wallet ${config.credentials.deployer}`,
		`credentials.rpc: workflow-wide chain reads and transaction submission ${config.credentials.rpc}`,
		`credentials.explorer: Core facet/library publication ${config.credentials.explorer}`,
		`execution (workflow-wide): ${config.execution.confirmations} confirmations; transaction timeout ${config.execution.txTimeoutSeconds}s; slow notice ${config.execution.slowNoticeSeconds}s; logging ${config.execution.logLevel}; explorer publication required`,
		`governance.owner: Core (${config.target.core}) owner ${config.governance.owner} (${config.governance.kind}); signer ${config.governance.signerMode}`,
		`governance.accountLayerOwner: expected existing Account Layer (${config.target.accountLayer}) owner ${config.governance.accountLayerOwner}`,
		...Object.entries(config.target).map(([name, address]) => `target.${name}: ${purposes[name]} (${address})`),
		`muon.requiredFunctions: restoration canaries through Core (${config.target.core}) and Signature Verifier (${config.target.signatureVerifier}): ${muon.requiredFunctions.join(", ")}`,
		`muon.additionalVerifierRoles: ${muon.additionalVerifierRoles.length} additional Signature Verifier roles to preserve; no grants performed`,
		...Object.entries(config.inventory || {}).map(
			([name, item]) => `inventory.${name}: ${item.kind}; contextual inventory, outside the Core cut`,
		),
	].join("\n");
}

/** Resolve Core recipients without rewriting the original input or old snapshots. */
export function coreUpgradeRoleGrants(config) {
	if (!config.roleGrants) return [];
	if (Array.isArray(config.roleGrants)) return config.roleGrants;
	if (config.apiVersion !== CORE_INPUT_API_V2 || Object.keys(config.roleGrants).length !== 1 || !Array.isArray(config.roleGrants.core))
		throw new Error("roleGrants.core: only Core contract grants are supported");
	const holders = { "target.symbolManager": config.target.symbolManager, "governance.owner": config.governance.owner };
	return config.roleGrants.core.map(grant => {
		if (!grant.holderRef) return grant;
		if (!Object.hasOwn(holders, grant.holderRef) || !holders[grant.holderRef])
			throw new Error(`roleGrants.core: unsupported holderRef ${grant.holderRef}`);
		return { ...grant, holder: holders[grant.holderRef] };
	});
}

export function coreUpgradeRoleGrantReview(config) {
	const grants = coreUpgradeRoleGrants(config),
		target = `Core (${config.target.core})`;
	return [
		`roleGrants.core: ${target}; ${grants.length} planned grants; already-held roles are skipped`,
		...grants.map(grant => {
			const holder = getAddress(grant.holder);
			return `${grant.role} on ${target} to ${grant.holderRef ? `${grant.holderRef} (${holder})` : holder}`;
		}),
	].join("\n");
}

/** Read categorized policies without rewriting the original, digest-bound input. */
export function coreUpgradePolicies(config) {
	if (config.apiVersion === CORE_INPUT_API_V2) return { storage: config.storage, funding: config.funding, selectors: config.selectors };
	return {
		storage: {
			symbolAdjustment: config.storage || { legacyAdjustmentWords: 15, upgradedAdjustmentWords: 17, requireEmptyAdjustments: true },
		},
		funding: { aggregate: { repair: config.repairAggregateFunding } },
		selectors: { core: { allowedRemovals: config.allowedRemovedSelectors } },
	};
}

export function coreUpgradePolicyReview(config) {
	const policies = coreUpgradePolicies(config),
		adjustment = policies.storage.symbolAdjustment,
		limits = coreUpgradeLimits(config);
	return [
		`limits.coreSnapshot: Core (${config.target.core}); at most ${limits.coreSnapshot.maxHistoricalQuotes} historical quotes and ${limits.coreSnapshot.maxRegisteredSymbols} registered symbols; complete scans required`,
		`limits.signatureVerifierSnapshot: Signature Verifier (${config.target.signatureVerifier}); at most ${limits.signatureVerifierSnapshot.maxRoleMembers} members per role and ${limits.signatureVerifierSnapshot.maxSigners} entries per public-key/gateway-signer list`,
		`storage.symbolAdjustment: Core getter; ${adjustment.legacyAdjustmentWords} zero ABI words before upgrade; ${adjustment.upgradedAdjustmentWords} afterward; empty adjustments required`,
		`funding.aggregate: Core accounting reconciliation and repair ${policies.funding.aggregate.repair ? "required" : "disabled"}`,
		`selectors.core: allowed removals ${policies.selectors.core.allowedRemovals.join(", ") || "none"}; unreviewed removals rejected`,
	].join("\n");
}
export const coreUpgradeAuthority = config => (isStandardCoreInput(config) ? config.governance.owner : config.target.safe);
export function coreUpgradeNetwork(config) {
	if (isStandardCoreInput(config)) return config.network;
	const name = Object.keys(CHAINS).find(key => !CHAINS[key].simulated && CHAINS[key].chainId === config.chainId && CHAINS[`fork-${key}`]);
	if (!name) throw new Error("Legacy Core input has no configured rehearsal network");
	return { name, chainId: config.chainId, fork: `fork-${name}` };
}
export const coreGovernanceKind = config => (isStandardCoreInput(config) ? config.governance.kind : "safe");
export function coreUpgradeRecipe(input, fork = false) {
	return validateDeploymentRecipe({
		apiVersion: "deployment.symm.io/v1",
		kind: "DeploymentRecipe",
		name: `${input.name}${fork ? "-fork" : ""}`,
		network: { name: fork ? input.network.fork : input.network.name, chainId: input.network.chainId, mode: fork ? "fork" : "live" },
		secrets: input.credentials,
		execution: input.execution,
		governance: { admin: input.governance.owner },
		core: { mode: "skip", collateral: { mode: "reuse", address: input.target.collateral } },
		partyB: { mode: "skip", adlEnabled: false },
		symbolManager: { mode: "skip" },
		expressProvider: { mode: "skip" },
		gaslessLayer: { mode: "skip" },
		liquidator: { mode: "skip" },
	});
}
