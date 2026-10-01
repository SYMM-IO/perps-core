import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { exportLfArtifacts } from "./lfArtifacts.js"
import { createLfPlan } from "./lfUpdate.js"
import { atomicWriteJson, withDigest } from "./symbolSync.js"

const createdAt = "2026-09-15T18:30:00.123Z"
function fixture(t: any) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lf-artifact-test-"))
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
	const config = {
		network: "base",
		chainId: 8453,
		core: "0x1111111111111111111111111111111111111111",
		symbolManager: "0x2222222222222222222222222222222222222222",
		authority: "0x3333333333333333333333333333333333333333",
		batchSize: 50,
		announcementReference: "fixture-announcement",
		enforcementAt: "2026-09-15T00:00:00Z",
	}
	const snapshot = withDigest({
		apiVersion: "operations.symm.io/lf-snapshot-v1",
		config,
		symbols: [
			{
				symbolId: "1",
				name: "BTCUSDT",
				isValid: true,
				minAcceptableQuoteValue: "100",
				minAcceptablePortionLF: "30000000000000000",
				tradingFee: "1",
				maxLeverage: "100",
				fundingRateEpochDuration: "3600",
				fundingRateWindowTime: "300",
			},
		],
	})
	const plan = createLfPlan(snapshot, "1")
	const report = {
		planDigest: plan.digest,
		authority: config.authority,
		status: "complete",
		total: 1,
		completed: 1,
		pending: 0,
		verification: { block: { number: 100, hash: "0x" + "12".repeat(32) }, symbols: snapshot.symbols, fundingChanges: [] },
	}
	for (const [name, data] of Object.entries({ "snapshot.json": snapshot, "plan.json": plan, "report.json": report }))
		atomicWriteJson(path.join(directory, name), data)
	fs.writeFileSync(path.join(directory, "preview.csv"), "symbolId,targetLF\n1,30000000000000000\n")
	return { directory, config, plan, report, phase: "verify" as const, succeeded: true, createdAt }
}

test("exports chain and UTC datetime in directories and every evidence filename", t => {
	const options = fixture(t)
	const before = fs.readFileSync(path.join(options.directory, "plan.json"))
	const output = exportLfArtifacts(options)
	assert.equal(output.directory, path.join(options.directory, "outputs", "8453", "20260915T183000.123Z-verify"))
	for (const name of fs.readdirSync(output.directory)) assert.match(name, /^8453-20260915T183000\.123Z-verify-/)
	const verification = JSON.parse(fs.readFileSync(path.join(output.directory, output.files["verification.json"]), "utf8"))
	assert.equal(verification.chainId, 8453)
	assert.equal(verification.createdAt, createdAt)
	assert.equal(verification.status, "verified")
	assert.equal(verification.planDigest, options.plan.digest)
	assert.deepEqual(verification.symbols, options.report.verification.symbols)
	assert.deepEqual(fs.readFileSync(path.join(options.directory, "plan.json")), before)
})

test("a failed verification attempt cannot export an earlier complete report as verified", t => {
	const options = fixture(t)
	const output = exportLfArtifacts({ ...options, succeeded: false })
	const verification = JSON.parse(fs.readFileSync(path.join(output.directory, output.files["verification.json"]), "utf8"))
	assert.equal(verification.status, "incomplete")
})

test("a complete status without symbol reads cannot produce verified evidence", t => {
	const options = fixture(t)
	atomicWriteJson(path.join(options.directory, "report.json"), { ...options.report, verification: undefined })
	const output = exportLfArtifacts(options)
	const verification = JSON.parse(fs.readFileSync(path.join(output.directory, output.files["verification.json"]), "utf8"))
	assert.equal(verification.status, "incomplete")
})

test("refuses evidence from another chain or a different bound plan", t => {
	const options = fixture(t)
	assert.throws(() => exportLfArtifacts({ ...options, config: { ...options.config, chainId: 56 } }), /does not belong/)
	atomicWriteJson(path.join(options.directory, "report.json"), { ...options.report, planDigest: "wrong" })
	assert.throws(() => exportLfArtifacts(options), /does not belong/)
})

test("later output preserves earlier timestamped evidence and rejects collisions", t => {
	const options = fixture(t)
	const first = exportLfArtifacts(options)
	const saved = fs.readFileSync(path.join(first.directory, first.files["report.json"]))
	const later = exportLfArtifacts({ ...options, createdAt: "2026-09-15T18:31:00.123Z" })
	assert.notEqual(first.directory, later.directory)
	assert.throws(() => exportLfArtifacts(options), /EEXIST/)
	assert.deepEqual(fs.readFileSync(path.join(first.directory, first.files["report.json"])), saved)
})
