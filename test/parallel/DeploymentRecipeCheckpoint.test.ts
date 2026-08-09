import { expect } from "chai"
import fs from "node:fs"
import path from "node:path"

import {
	createCheckpoint,
	getCheckpointPath,
	loadCheckpoint,
	normalizeCheckpointScope,
	saveCheckpoint,
	setCheckpointSimulated,
} from "../../tasks/deploy/checkpoint.js"

describe("deployment recipe checkpoint scopes", function () {
	const chainId = 9_913_370
	const scope = "component-arbitrum-release-partyB"
	const files = [
		path.resolve(`tasks/data/checkpoints/checkpoint-${chainId}.json`),
		path.resolve(`tasks/data/checkpoints/checkpoint-${chainId}-${scope}.json`),
		path.resolve(`tasks/data/checkpoints/checkpoint-${chainId}-fork-${scope}.json`),
	]

	afterEach(function () {
		setCheckpointSimulated(false)
		for (const file of files) fs.rmSync(file, { force: true })
	})

	it("keeps legacy system and component checkpoints in distinct stable files", function () {
		setCheckpointSimulated(false)
		const system = createCheckpoint("arbitrum", chainId)
		const component = createCheckpoint("arbitrum", chainId, scope)
		saveCheckpoint(system)
		saveCheckpoint(component)

		expect(path.normalize(getCheckpointPath(chainId))).to.equal(path.normalize(`tasks/data/checkpoints/checkpoint-${chainId}.json`))
		expect(path.normalize(getCheckpointPath(chainId, scope))).to.equal(path.normalize(`tasks/data/checkpoints/checkpoint-${chainId}-${scope}.json`))
		expect(loadCheckpoint(chainId)?.deploymentId).to.equal(system.deploymentId)
		expect(loadCheckpoint(chainId, scope)?.deploymentId).to.equal(component.deploymentId)
	})

	it("keeps component checkpoints separate from live chain state on forks", function () {
		setCheckpointSimulated(true)
		expect(path.normalize(getCheckpointPath(chainId, scope))).to.equal(
			path.normalize(`tasks/data/checkpoints/checkpoint-${chainId}-fork-${scope}.json`),
		)
	})

	it("rejects path traversal and ambiguous scopes", function () {
		for (const invalid of ["../partyB", "partyB/main", "partyB\\main", ".", "..", " white-space ", ""]) {
			if (invalid === "") {
				expect(normalizeCheckpointScope(invalid)).to.equal(undefined)
				continue
			}
			expect(() => normalizeCheckpointScope(invalid)).to.throw("Invalid deployment checkpoint scope")
		}
	})
})
