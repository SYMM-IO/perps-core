import { CHAINS } from "../cli/lib/context.js";
import { parseSecretRef, validateDeploymentRecipe } from "./recipe.js";
import Ajv from "ajv";
import { getAddress, ZeroAddress, id } from "ethers";
import fs from "node:fs";

export const CORE_INPUT_API = "operations.symm.io/core-upgrade-input-v1";
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(
	JSON.parse(fs.readFileSync(new URL("./core-upgrade-input.schema.json", import.meta.url))),
);
export function validateCoreUpgradeInput(input) {
	if (!validateSchema(input)) throw new Error(`Invalid Core upgrade input: ${JSON.stringify(validateSchema.errors)}`);
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
	for (const grant of input.roleGrants) {
		if (getAddress(grant.holder) === ZeroAddress) throw new Error("Zero role holder");
		if (grant.role === "MIGRATION_ROLE" && grant.holder.toLowerCase() === input.governance.owner.toLowerCase())
			throw new Error("The Core owner's migration role must be restored, not persistently granted");
		const key = `${grant.holder.toLowerCase()}:${id(grant.role)}`;
		if (grants.has(key)) throw new Error("Duplicate role grant");
		grants.add(key);
	}
	if (new Set(input.allowedRemovedSelectors).size !== input.allowedRemovedSelectors.length) throw new Error("Duplicate removed selector");
	coreUpgradeRecipe(input);
	return input;
}
export const isStandardCoreInput = config => config?.apiVersion === CORE_INPUT_API;
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
