import { Interface, ZeroAddress, getAddress, id, keccak256 } from "ethers";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TARGET = Object.freeze({
	chainId: 999,
	core: "0x57331038c21982116EE9b0906E4a5c5cB52dcE2e",
	recipient: "0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9",
	owner: "0x77A955776Ee1dd3E9C800c3214ed489441d74b94",
	collateral: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
	legacyAccountFacet: "0xb6c0FD8B8721ECfb8De7782B9565DE5c8A5C468B",
});
export const ROLE = id("SUSPENDED_FUNDS_WITHDRAWER_ROLE");
export const ARTIFACT = "contracts/patches/hyperevm-v085/ZeroBalanceRecoveryFacet085.sol:ZeroBalanceRecoveryFacet085";
export const CONFIG = "hardhat.recovery.config.ts";
export const ABI = [
	"function owner() view returns(address)",
	"function getCollateral() view returns(address)",
	"function getSigner() view returns(address)",
	"function hasRole(address,bytes32) view returns(bool)",
	"function isRoleAdmin(address,bytes32) view returns(bool)",
	"function grantRole(address,bytes32)",
	"function revokeRole(address,bytes32)",
	"function balanceOf(address) view returns(uint256)",
	"function allocatedBalanceOfPartyA(address) view returns(uint256)",
	"function facets() view returns((address facetAddress,bytes4[] functionSelectors)[])",
	"function facetAddress(bytes4) view returns(address)",
	"function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[],address,bytes)",
	"function recoverZeroAddressBalance(address) returns(uint256)",
	"event ZeroAddressBalanceRecovered(address indexed operator,address indexed recipient,uint256 amount,uint256 recipientBalanceBefore,uint256 recipientBalanceAfter)",
	"function withdrawSuspendedUserFunds(address,address,uint256)",
	"function suspendedAddress(address)",
	"function pauseAccounting()",
	"function unpauseAccounting()",
	"function pauseGlobal()",
	"function unpauseGlobal()",
	"function setSigner(address)",
];
export const iface = new Interface(ABI);
export const SELECTOR = iface.getFunction("recoverZeroAddressBalance").selector;
export const LEGACY_SELECTOR = iface.getFunction("withdrawSuspendedUserFunds").selector;
export const json = value => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
export const digest = value => createHash("sha256").update(json(value)).digest("hex");
export const SOURCE_FILES = [
	CONFIG,
	"contracts/patches/hyperevm-v085/GlobalAppStorage085.sol",
	"contracts/patches/hyperevm-v085/ZeroBalanceRecoveryFacet085.sol",
];
export const sourceDigest = root => digest(SOURCE_FILES.map(file => [file, fs.readFileSync(path.join(root, file), "utf8")]));
export const selectorMap = facets => Object.fromEntries(facets.flatMap(f => [...f.functionSelectors].map(s => [s, getAddress(f.facetAddress)])));
export const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function validateInput(input, root) {
	if (digest(input.target) !== digest(TARGET) || input.schema !== 1)
		throw new Error("Recovery target changed; this task is only for the reviewed HyperEVM v0.8.5 Core");
	if (typeof input.forkEnabled !== "boolean") throw new Error("Choose whether to run the optional fork rehearsal");
	for (const key of [input.rpcKey, ...(input.forkEnabled ? [input.archiveRpcKey] : [])])
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key || "")) throw new Error("RPC credentials must be keystore key names");
	if (root && sourceDigest(root) !== input.sourceDigest) throw new Error("Recovery source or isolated compiler configuration changed");
}

export function requireRecipientConfirmation(confirmation) {
	if (!sameAddress(confirmation?.recipient, TARGET.recipient) || !Number.isFinite(Date.parse(confirmation?.confirmedAt)))
		throw new Error("Operator confirmation of the exact recipient and confirmation date is required");
}

export function planCut(baseline, current, facet) {
	if (!baseline || baseline[SELECTOR] || !sameAddress(baseline[LEGACY_SELECTOR], TARGET.legacyAccountFacet))
		throw new Error("Invalid v0.8.5 selector baseline");
	const expected = { ...baseline, ...(current[SELECTOR] ? { [SELECTOR]: getAddress(facet) } : {}) };
	if (Object.keys(expected).length !== Object.keys(current).length || Object.entries(expected).some(([s, a]) => !sameAddress(a, current[s])))
		throw new Error("Core selectors changed outside the one-selector recovery upgrade");
	if (current[SELECTOR]) return [];
	return [
		{
			to: TARGET.core,
			value: "0",
			description: "Add the v0.8.5 zero-address recovery selector; no replacements, removals or initializer",
			data: iface.encodeFunctionData("diamondCut", [[{ facetAddress: facet, action: 0, functionSelectors: [SELECTOR] }], ZeroAddress, "0x"]),
		},
	];
}

export const REQUIRED_CHECKS = [
	"exact-balance",
	"two-storage-writes",
	"unchanged-selectors",
	"unauthorized",
	"accounting-pause",
	"global-pause",
	"proxy-guard",
	"zero-recipient",
	"repeat-recovery",
	"legacy-suspended-recovery",
];
export function requireRehearsal(report, input, artifact) {
	const r = report.rehearsal;
	if (
		!r?.passed ||
		r.inputDigest !== digest(input) ||
		r.runtimeHash !== keccak256(artifact.deployedBytecode) ||
		!r.archiveVerified ||
		!r.blockHash ||
		!Number.isSafeInteger(r.blockNumber) ||
		REQUIRED_CHECKS.some(c => !r.checks?.includes(c))
	)
		throw new Error("A complete archive-backed fork rehearsal of this exact input and artifact is required");
}

export function requireValidation(report, input, artifact) {
	if (!report.localTests?.passed || report.localTests.inputDigest !== digest(input) || report.localTests.sourceDigest !== input.sourceDigest)
		throw new Error("The local recovery tests must pass for this exact task input and source");
	if (input.forkEnabled) requireRehearsal(report, input, artifact);
}

export function recoveryEvent(receipt) {
	if (Number(receipt?.status) !== 1) throw new Error("Recovery receipt did not succeed");
	const events = receipt.logs
		.filter(l => sameAddress(l.address, TARGET.core))
		.map(l => {
			try {
				return iface.parseLog(l);
			} catch {
				return null;
			}
		})
		.filter(e => e?.name === "ZeroAddressBalanceRecovered");
	if (events.length !== 1) throw new Error("Expected exactly one recovery event emitted by Core");
	const e = events[0].args;
	if (
		!sameAddress(e.operator, TARGET.recipient) ||
		!sameAddress(e.recipient, TARGET.recipient) ||
		e.amount <= 0n ||
		e.recipientBalanceAfter - e.recipientBalanceBefore !== e.amount
	)
		throw new Error("Recovery event recipient, operator or exact balance arithmetic is invalid");
	return {
		amount: e.amount.toString(),
		zeroBefore: e.amount.toString(),
		zeroAfter: "0",
		recipientBefore: e.recipientBalanceBefore.toString(),
		recipientAfter: e.recipientBalanceAfter.toString(),
	};
}

export function recoveryAction() {
	return {
		to: TARGET.core,
		value: "0",
		data: iface.encodeFunctionData("recoverZeroAddressBalance", [TARGET.recipient]),
		description: "Sweep the full zero-address internal balance, including 18-decimal dust, into the confirmed recipient Safe's Core account",
	};
}
