import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		base: { type: "string" },
		solc: { type: "string" },
		output: { type: "string" },
	},
});
assert(
	values.base && values.solc && values.output,
	"Usage: node scripts/audit/check-storage-layout.mjs --base <commit> --solc <compiler> --output <report.json>",
);
const baseline = execFileSync("git", ["rev-parse", "--verify", `${values.base}^{commit}`], { encoding: "utf8" }).trim();
const baselineLock = JSON.parse(execFileSync("git", ["show", `${baseline}:package-lock.json`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
const currentLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const dependencies = {};
for (const name of ["@openzeppelin/contracts", "@openzeppelin/contracts-upgradeable"]) {
	const key = `node_modules/${name}`;
	assert.deepEqual(
		currentLock.packages[key],
		baselineLock.packages[key],
		`${name}: dependency change requires a separate inherited-namespace review`,
	);
	const installed = JSON.parse(readFileSync(`${key}/package.json`, "utf8"));
	assert.equal(installed.version, currentLock.packages[key].version, `${name}: installed version differs from lockfile`);
	dependencies[name] = { version: installed.version, integrity: currentLock.packages[key].integrity };
}
const dependencySourceHashes = {};
const compilerVersion = execFileSync(values.solc, ["--version"], { encoding: "utf8" }).trim();
assert.match(compilerVersion, /Version: 0\.8\.36\+/, "Use the release's Solidity 0.8.36 compiler");
const relayer = "contracts/helpers/relayers/SymmioGlobalRelayer.sol";
const harnesses = {
	"AuditAccountLayout.sol":
		'pragma solidity >=0.8.18; import {AccountStorage} from "contracts/accountLayer/storages/AccountStorage.sol"; contract AuditAccountLayout { AccountStorage.Layout internal state; }',
	"AuditDelegationLayout.sol":
		'pragma solidity >=0.8.18; import {DelegationStorage} from "contracts/instantLayer/storages/DelegationStorage.sol"; contract AuditDelegationLayout { DelegationStorage.Layout internal state; }',
};

function sourceContent(name, revision) {
	if (name in harnesses) return harnesses[name];
	if (name.startsWith("@")) {
		const content = readFileSync(path.join("node_modules", name), "utf8");
		dependencySourceHashes[name] = createHash("sha256").update(content).digest("hex");
		return content;
	}
	assert(name.startsWith("contracts/"), `Unexpected source ${name}`);
	return revision
		? execFileSync("git", ["show", `${revision}:${name}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
		: readFileSync(name, "utf8");
}

function compile(revision) {
	const sources = {};
	function visit(name) {
		if (name in sources) return;
		const content = sourceContent(name, revision);
		sources[name] = { content };
		for (const match of content.matchAll(/import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']\s*;/g)) {
			const dependency = match[1].startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1])) : match[1];
			visit(dependency);
		}
	}
	for (const name of [...Object.keys(harnesses), relayer]) visit(name);
	const input = {
		language: "Solidity",
		sources,
		settings: { evmVersion: "cancun", outputSelection: { "*": { "*": ["storageLayout"] } } },
	};
	const raw = execFileSync(values.solc, ["--standard-json"], {
		input: JSON.stringify(input),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const result = JSON.parse(raw.slice(raw.indexOf("{")));
	const errors = (result.errors ?? []).filter(item => item.severity === "error");
	assert.equal(errors.length, 0, errors.map(item => item.formattedMessage).join("\n"));
	return result.contracts;
}

function typeShape(typeId, types, seen = new Set()) {
	const type = types[typeId];
	assert(type, `Missing compiler type ${typeId}`);
	const result = { label: type.label, encoding: type.encoding, numberOfBytes: type.numberOfBytes };
	if (seen.has(typeId)) return { recursive: type.label };
	const descendants = new Set([...seen, typeId]);
	for (const key of ["base", "key", "value"]) if (type[key]) result[key] = typeShape(type[key], types, descendants);
	if (type.members) result.members = type.members.map(member => memberShape(member, types, descendants));
	return result;
}

function memberShape(member, types, seen = new Set()) {
	return { label: member.label, slot: member.slot, offset: member.offset, type: typeShape(member.type, types, seen) };
}

function compare(name, before, after, expectedAdditions, struct = false) {
	const oldMembers = struct ? before.types[before.storage[0].type].members : before.storage;
	const newMembers = struct ? after.types[after.storage[0].type].members : after.storage;
	assert.equal(newMembers.length, oldMembers.length + expectedAdditions.length, `${name}: unexpected field count`);
	for (let index = 0; index < oldMembers.length; index++) {
		assert.deepEqual(
			memberShape(newMembers[index], after.types),
			memberShape(oldMembers[index], before.types),
			`${name}.${oldMembers[index].label}: storage changed`,
		);
	}
	const additions = newMembers.slice(oldMembers.length);
	assert.deepEqual(
		additions.map(member => member.label),
		expectedAdditions,
		`${name}: unexpected appended fields`,
	);
	return {
		name,
		preservedMembers: oldMembers.length,
		additions: additions.map(member => memberShape(member, after.types)),
	};
}

const before = compile(baseline);
const after = compile(undefined);
const checked = [
	compare(
		"AccountLayer AccountStorage.Layout",
		before["AuditAccountLayout.sol"].AuditAccountLayout.storageLayout,
		after["AuditAccountLayout.sol"].AuditAccountLayout.storageLayout,
		["ownershipEpochs"],
		true,
	),
	compare(
		"InstantLayer DelegationStorage.Layout",
		before["AuditDelegationLayout.sol"].AuditDelegationLayout.storageLayout,
		after["AuditDelegationLayout.sol"].AuditDelegationLayout.storageLayout,
		["ownershipEpochs"],
		true,
	),
	compare(
		"SymmioGlobalRelayer ordinary compiler storage",
		before[relayer].SymmioGlobalRelayer.storageLayout,
		after[relayer].SymmioGlobalRelayer.storageLayout,
		["sourceMultiAccounts", "transferActive"],
	),
];
const namespaceBindings = [];
for (const name of ["contracts/accountLayer/storages/AccountStorage.sol", "contracts/instantLayer/storages/DelegationStorage.sol"]) {
	const oldSource = sourceContent(name, baseline).replace(/\r\n/g, "\n");
	const newSource = sourceContent(name, undefined).replace(/\r\n/g, "\n");
	const constant = /bytes32\s+internal\s+constant\s+(\w+)\s*=\s*keccak256\("([^"]+)"\)\s*;/;
	const oldBinding = oldSource.match(constant);
	const newBinding = newSource.match(constant);
	assert(oldBinding && newBinding, `${name}: unsupported namespace declaration; manual review required`);
	assert.deepEqual(newBinding.slice(1), oldBinding.slice(1), `${name}: namespace constant changed`);
	const layoutFunction = /function layout\(\) internal pure returns \(Layout storage l\)\s*\{[\s\S]*$/;
	const oldFunction = oldSource.match(layoutFunction)?.[0];
	const newFunction = newSource.match(layoutFunction)?.[0];
	assert(oldFunction && newFunction, `${name}: unsupported layout binding; manual review required`);
	assert.equal(newFunction, oldFunction, `${name}: layout binding changed`);
	namespaceBindings.push({ source: name, constant: newBinding[1], namespace: newBinding[2] });
}
for (const name of ["contracts/core/storages/AccountStorage.sol", "contracts/core/storages/QuoteStorage.sol"]) {
	assert.equal(
		sourceContent(name, undefined).replace(/\r\n/g, "\n"),
		sourceContent(name, baseline).replace(/\r\n/g, "\n"),
		`${name}: requires a separate storage comparison`,
	);
}
const report = {
	baseline,
	compilerVersion,
	checked,
	namespaceBindings,
	dependencies,
	dependencySourceHashes,
	coreAccountAndQuoteStorageUnchanged: true,
	dependencyScope:
		"OpenZeppelin lock entries and installed versions are unchanged. ERC-7201 inherited namespaces are not included in ordinary storageLayout.storage; imported dependency source hashes are recorded for review.",
	result: "pass",
};
mkdirSync(path.dirname(values.output), { recursive: true });
writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
for (const item of checked)
	console.log(
		`${item.name}: ${item.preservedMembers} existing members preserved; ${item.additions.map(entry => `${entry.label}@${entry.slot}:${entry.offset}`).join(", ")}`,
	);
console.log(`Storage compatibility passed against ${baseline}; report: ${values.output}`);
