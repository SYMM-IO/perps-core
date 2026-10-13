import { address, canonical, codeHash, digest, runtimeBytecode, matchRuntime, planSelectors } from "./model.js";

/** Match both the facet AND recursively linked libraries; a matching facet alone is insufficient. */
export async function identifyBuild(snapshot, build, provider) {
	const matches = {},
		libraryAddresses = {},
		visiting = new Set();
	const validate = async (artifact, code, deployedAddress) => {
		const links = matchRuntime(artifact, code, deployedAddress);
		if (!links) return false;
		for (const [key, deployed] of Object.entries(links)) {
			const libraryName = key.slice(key.lastIndexOf(":") + 1),
				library = build.catalog[libraryName];
			if (!library || visiting.has(deployed)) return false;
			visiting.add(deployed);
			const okay = await validate(library, await provider.getCode(deployed, snapshot.blockNumber), deployed);
			visiting.delete(deployed);
			if (!okay) return false;
			if (libraryAddresses[libraryName] && libraryAddresses[libraryName] !== deployed) return false;
			libraryAddresses[libraryName] = deployed;
		}
		return true;
	};
	for (const facet of snapshot.facets)
		for (const [name, artifact] of Object.entries(build.catalog)) {
			if (artifact.kind === "facet" && (await validate(artifact, facet.code, facet.address))) {
				matches[facet.address] = name;
				break;
			}
		}
	return { matches, libraryAddresses, complete: Object.keys(matches).length === snapshot.facets.length };
}
export async function preparePlan({ snapshot, build, baseline, selected, mode, removals, deployer, provider }) {
	if (!Array.isArray(selected) || new Set(selected).size !== selected.length) throw new Error("Select unique facets");
	const current = await identifyBuild(snapshot, build, provider);
	const previous = baseline ? await identifyBuild(snapshot, baseline, provider) : current;
	const baselineBuild = baseline || build;
	const blockers = [];
	if ((baselineBuild.scope || "core") !== (build.scope || "core")) blockers.push("Baseline belongs to a different contract scope");
	if (!baselineBuild.diamond || codeHash(baselineBuild.diamond.deployedBytecode) !== snapshot.diamondCodeHash)
		blockers.push("The baseline does not identify this Core Diamond runtime. Its storage and authority adapter cannot be assumed.");
	if (!previous.complete)
		blockers.push(
			"The baseline build does not identify every deployed facet and linked library. Import a matching build bundle before execution.",
		);
	if (canonical(baselineBuild.storageSources) !== canonical(build.storageSources))
		blockers.push(
			"Storage-related source definitions changed. This version requires a reviewed migration adapter and does not execute storage changes.",
		);
	if (snapshot.authority.kind === "unknown-contract") blockers.push("The upgrade owner is an unsupported governance contract.");
	const deployments = [],
		included = new Set(),
		bindings = {},
		candidates = [];
	async function include(name) {
		if (included.has(name)) return;
		const artifact = build.catalog[name];
		if (!artifact) throw new Error(`Unknown build component ${name}`);
		included.add(name);
		for (const dependency of artifact.dependencies) await include(dependency);
		const existing =
			artifact.kind === "library" ? current.libraryAddresses[name] : Object.keys(current.matches).find(a => current.matches[a] === name);
		// Linked runtime must use exactly the bindings of this plan to be reused.
		let reusable = false;
		if (existing && artifact.dependencies.every(n => bindings[n] && !bindings[n].startsWith("deploy:"))) {
			try {
				reusable =
					runtimeBytecode(artifact, bindings, existing).toLowerCase() ===
					(await provider.getCode(existing, snapshot.blockNumber)).toLowerCase();
			} catch {}
		}
		bindings[name] = reusable ? existing : `deploy:${name}`;
		if (!reusable)
			deployments.push({
				id: `deploy.${name.toLowerCase()}`,
				name,
				kind: artifact.kind,
				dependencies: artifact.dependencies,
				reason: existing ? "Linked dependencies changed" : "No exact deployed runtime match",
			});
	}
	for (const name of selected) {
		if (build.catalog[name]?.kind !== "facet") throw new Error(`Unknown facet ${name}`);
		await include(name);
		candidates.push({ name, address: bindings[name], selectors: build.catalog[name].selectors });
	}
	const routing = planSelectors(snapshot.map, candidates, { mode, removals });
	const supportingCode = {};
	for (const deployed of new Set([...Object.values(previous.libraryAddresses), ...Object.values(current.libraryAddresses)]))
		supportingCode[deployed] = codeHash(await provider.getCode(deployed, snapshot.blockNumber));
	const body = {
		version: 1,
		scope: build.scope || "core",
		snapshot,
		buildDigest: build.digest,
		source: build.source,
		baselineDigest: baselineBuild.digest,
		selected,
		mode,
		removals,
		deployer: address(deployer),
		bindings,
		deployments,
		supportingCode,
		...routing,
		blockers,
	};
	return { ...body, id: digest(body), createdAt: new Date().toISOString() };
}
export function resolveRouting(plan, build, deployed) {
	const bindings = { ...plan.bindings, ...deployed };
	const candidates = plan.selected.map(name => ({ name, address: bindings[name], selectors: build.catalog[name].selectors }));
	return { bindings, ...planSelectors(plan.snapshot.map, candidates, plan) };
}
