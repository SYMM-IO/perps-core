import { expect } from "chai"
import fs from "fs"
import path from "path"

import {
	FacetSpecs,
	LibrarySpecs,
	getLibrarySpec,
	requiredLibraryOrder,
	type DeploymentSpec,
	type DiamondScope,
} from "../../utils/deploymentManifest.js"

type Artifact = {
	contractName: string
	sourceName: string
	linkReferences: Record<string, Record<string, unknown>>
}

function collectArtifacts(directory: string, artifacts: Artifact[] = []): Artifact[] {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) collectArtifacts(entryPath, artifacts)
		else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
			artifacts.push(JSON.parse(fs.readFileSync(entryPath, "utf-8")) as Artifact)
		}
	}
	return artifacts
}

function resolveArtifact(spec: DeploymentSpec, artifacts: Artifact[]): Artifact {
	if (spec.artifact.includes(":")) {
		const separator = spec.artifact.lastIndexOf(":")
		const sourceName = spec.artifact.slice(0, separator)
		const contractName = spec.artifact.slice(separator + 1)
		const match = artifacts.find(artifact => artifact.sourceName === sourceName && artifact.contractName === contractName)
		if (!match) throw new Error(`Artifact not found for ${spec.artifact}`)
		return match
	}

	const matches = artifacts.filter(artifact => artifact.contractName === spec.artifact)
	if (matches.length !== 1) throw new Error(`Expected one artifact named ${spec.artifact}, found ${matches.length}`)
	return matches[0]
}

function actualLinks(artifact: Artifact): string[] {
	return Object.entries(artifact.linkReferences ?? {})
		.flatMap(([sourceName, libraries]) => Object.keys(libraries).map(name => `${sourceName}:${name}`))
		.sort()
}

function expectedLinks(scope: DiamondScope, spec: DeploymentSpec): string[] {
	return spec.libraries.map(name => getLibrarySpec(scope, name).linkReference!).sort()
}

describe("deployment manifest", function () {
	const artifacts = collectArtifacts(path.resolve("artifacts/contracts"))

	for (const scope of ["core", "accountLayer"] as const) {
		it(`matches compiled direct link references for every ${scope} deployment`, function () {
			for (const spec of [...Object.values(LibrarySpecs[scope]), ...Object.values(FacetSpecs[scope])]) {
				const artifact = resolveArtifact(spec, artifacts)
				expect(actualLinks(artifact), `${scope}:${spec.name}`).to.deep.equal(expectedLinks(scope, spec))
			}
		})

		it(`orders ${scope} libraries after all of their dependencies`, function () {
			const order = requiredLibraryOrder(scope)
			const indexes = Object.fromEntries(order.map((name, index) => [name, index]))
			for (const spec of Object.values(LibrarySpecs[scope])) {
				for (const dependency of spec.libraries) {
					expect(indexes[dependency], `${dependency} must precede ${spec.name}`).to.be.lessThan(indexes[spec.name])
				}
			}
		})
	}

	it("captures the release-critical transitive dependency graphs", function () {
		expect(FacetSpecs.core.PartyBExecutionFacet.libraries).to.deep.equal(["LibQuoteClose"])
		expect(FacetSpecs.core.PartyBPositionActionsFacet.libraries).to.deep.equal(["PartyBPositionActionsFacetImpl", "LibQuoteClose"])
		expect(LibrarySpecs.core.PartyBPositionActionsFacetImpl.libraries).to.deep.equal(["LibQuoteFunding"])
		expect(FacetSpecs.core.ClearingHouseFacet.libraries).to.deep.equal(["ClearingHouseFacetImpl"])
		expect(LibrarySpecs.core.ClearingHouseFacetImpl.libraries).to.deep.equal(["LibQuoteClose", "LibQuoteFunding"])
		expect(FacetSpecs.accountLayer.CoreFacet.libraries).to.deep.equal(["LibQuoteParams"])
	})
})
