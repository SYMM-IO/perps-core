import { digest, selectors } from "./model.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function sourceIdentity(root = ROOT) {
	const files = [];
	const walk = dir => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile()) files.push([path.relative(root, file), digest(fs.readFileSync(file, "utf8"))]);
		}
	};
	walk(path.join(root, "contracts"));
	for (const name of ["hardhat.config.ts", "package.json", "package-lock.json", "utils/deploymentManifest.ts", "tasks/deploy/constants.ts"])
		if (fs.existsSync(path.join(root, name))) files.push([name, digest(fs.readFileSync(path.join(root, name), "utf8"))]);
	let commit = "unknown",
		branch = "unknown";
	try {
		commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {}
	return { commit, branch, digest: digest(files.sort(([a], [b]) => a.localeCompare(b))) };
}
export async function loadBuild(root = ROOT, scope = "core") {
	const { FacetSpecs, LibrarySpecs } = await import("../../utils/deploymentManifest.ts");
	const allFiles = [];
	const walk = dir => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "build-info") walk(file);
			} else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) allFiles.push(file);
		}
	};
	walk(path.join(root, "artifacts"));
	const all = allFiles.map(file => JSON.parse(fs.readFileSync(file, "utf8"))).filter(a => a.abi && a.bytecode && a.bytecode !== "0x");
	const find = name => {
		const matches = all.filter(a => (name.includes(":") ? `${a.sourceName}:${a.contractName}` === name : a.contractName === name));
		if (matches.length !== 1) throw new Error(`Compile first: expected one artifact for ${name}, found ${matches.length}`);
		return matches[0];
	};
	const componentArtifacts = { instantLayer: "InstantLayer", partyB: "SymmioPartyB", verifier: "MuonSignatureVerifier" };
	if (!["core", "accountLayer", ...Object.keys(componentArtifacts)].includes(scope)) throw new Error("Unknown contract scope");
	const specs = componentArtifacts[scope]
		? { [componentArtifacts[scope]]: { artifact: componentArtifacts[scope], libraries: [] } }
		: {
				...LibrarySpecs[scope],
				...FacetSpecs[scope],
				DiamondCutFacet: { artifact: "DiamondCutFacet", libraries: [] },
			};
	const catalog = {};
	for (const [name, spec] of Object.entries(specs)) {
		const artifact = find(spec.artifact);
		catalog[name] = {
			...artifact,
			name,
			kind: componentArtifacts[scope] ? "implementation" : LibrarySpecs[scope]?.[name] ? "library" : "facet",
			dependencies: spec.libraries,
			selectors: LibrarySpecs[scope]?.[name] ? {} : selectors(artifact.abi),
		};
	}
	const source = sourceIdentity(root),
		storageSources = {},
		compilers = {};
	// Preserve complete compiler input for reproducible identity and conservative source-based storage review.
	const inputs = {};
	const compileCache = new Map();
	for (const a of Object.values(catalog)) {
		const file = path.join(root, "artifacts/build-info", `${a.buildInfoId}.json`);
		if (!fs.existsSync(file)) throw new Error(`Missing compiler input for ${a.name}; recompile`);
		if (!compileCache.has(a.buildInfoId)) {
			const info = JSON.parse(fs.readFileSync(file, "utf8"));
			const output = JSON.parse(fs.readFileSync(file.replace(/\.json$/, ".output.json"), "utf8")).output;
			const imports = Object.fromEntries(
				Object.entries(output.sources).map(([name, source]) => [
					name,
					(source.ast?.nodes || []).filter(n => n.nodeType === "ImportDirective").map(n => n.absolutePath),
				]),
			);
			const declarations = {};
			for (const [name, source] of Object.entries(output.sources)) {
				declarations[name] = (source.ast?.nodes || [])
					.filter(n => n.nodeType === "ContractDefinition")
					.map(contract => ({
						name: contract.name,
						bases: contract.baseContracts.map(base => base.baseName.name || base.baseName.namePath),
						variables: contract.nodes
							.filter(
								n =>
									n.nodeType === "VariableDeclaration" &&
									n.stateVariable &&
									!n.constant &&
									!n.immutable &&
									n.mutability !== "immutable",
							)
							.map(v => ({ name: v.name, type: v.typeDescriptions.typeString })),
					}))
					.filter(c => c.variables.length || c.bases.length);
			}
			compileCache.set(a.buildInfoId, { info, imports, declarations });
		}
		const { info, imports, declarations } = compileCache.get(a.buildInfoId);
		const relevant = new Set();
		const visit = name => {
			if (relevant.has(name)) return;
			relevant.add(name);
			for (const dependency of imports[name] || []) visit(dependency);
		};
		visit(`project/${a.sourceName}`);
		inputs[a.buildInfoId] = { version: info.solcLongVersion, settings: info.input.settings, sources: info.input.sources };
		compilers[a.buildInfoId] = { version: info.solcLongVersion, settings: info.input.settings };
		for (const [name, item] of Object.entries(info.input.sources).filter(([name]) => relevant.has(name))) {
			if (declarations[name]?.length) storageSources[`declarations:${name}`] = digest(declarations[name]);
			if (name.startsWith("project/")) {
				const local = path.join(root, name.slice("project/".length));
				if (!fs.existsSync(local) || fs.readFileSync(local, "utf8") !== item.content)
					throw new Error(`Compiled source is stale: ${name}. Compile the checkout first.`);
			}
			// Includes full source for structs, enums, fixed storage slots, assembly, and their containing logic.
			// This deliberately rejects some harmless edits rather than declaring a changed layout safe.
			if (/\b(struct|enum)\s+\w+|\.slot\s*:=|\bassembly\b/.test(item.content)) storageSources[name] = digest(item.content);
		}
	}
	const body = { version: 1, scope, source, catalog, diamond: find("Diamond"), storageSources, compilers, inputs };
	return { ...body, digest: digest(body) };
}
export function validateBuild(build) {
	if (!build || build.version !== 1 || !build.catalog || !build.inputs || !build.storageSources) throw new Error("Invalid build bundle");
	const { digest: checksum, ...body } = build;
	if (checksum !== digest(body)) throw new Error("Build bundle checksum mismatch");
	return build;
}
