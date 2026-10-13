import { fuzzPaths } from "../server/fuzz.js";
import { startServer } from "../server/server.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const engineFactory = () => ({ status: () => ({ active: null }), close() {} });
async function fixture(t, { archive = true } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "perps-core-ui-fuzz-"));
	const fuzz = { reportFile: path.join(root, "report.json"), archiveDir: path.join(root, "runs") };
	if (archive) await fs.mkdir(fuzz.archiveDir);
	const app = await startServer({ port: 0, engineFactory, fuzz });
	t.after(async () => {
		await app.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const headers = { Authorization: `Bearer ${app.url.split("#")[1]}` };
	return { ...fuzz, app, get: route => fetch(`${app.origin}${route}`, { headers }) };
}

test("fuzz report paths follow the runner's environment variables and default under the checkout", () => {
	assert.deepEqual(fuzzPaths({}, "/workspace/project"), {
		reportFile: path.resolve("/workspace/project", ".fuzz-dashboard/report.json"),
		archiveDir: path.resolve("/workspace/project", ".fuzz-dashboard/runs"),
	});
	assert.deepEqual(fuzzPaths({ FUZZ_DASHBOARD_FILE: "output/live.json", FUZZ_DASHBOARD_ARCHIVE_DIR: "/var/tmp/fuzz-runs" }, "/workspace/project"), {
		reportFile: path.resolve("/workspace/project", "output/live.json"),
		archiveDir: "/var/tmp/fuzz-runs",
	});
});

test("fuzz reports need the session token; the health probe names the app and nothing more", async t => {
	const { app, reportFile } = await fixture(t);
	await fs.writeFile(reportFile, JSON.stringify({ run: { status: "running" } }));
	for (const route of ["/api/fuzz/report", "/api/fuzz/runs", "/api/fuzz/runs/run-001.json"])
		assert.equal((await fetch(`${app.origin}${route}`)).status, 401, route);
	const health = await fetch(`${app.origin}/health`);
	assert.equal(health.status, 200);
	assert.deepEqual(await health.json(), { app: "perps-core-ui" });
	assert.equal(health.headers.get("x-frame-options"), "DENY");
	assert.equal(health.headers.get("cross-origin-resource-policy"), "same-origin");
	assert.equal(health.headers.get("access-control-allow-origin"), null);
});

test("the live report is waiting until the runner writes it, and a half-written file is a retry", async t => {
	const { get, reportFile } = await fixture(t);
	const waiting = await get("/api/fuzz/report");
	assert.equal(waiting.status, 200);
	assert.match(waiting.headers.get("cache-control"), /no-store/);
	assert.deepEqual(await waiting.json(), { status: "waiting" });

	await fs.writeFile(reportFile, JSON.stringify({ status: "running", roots: 17, seed: "dashboard-seed" }));
	assert.deepEqual(await (await get("/api/fuzz/report")).json(), { status: "running", roots: 17, seed: "dashboard-seed" });

	await fs.writeFile(reportFile, "{partial");
	const malformed = await get("/api/fuzz/report");
	assert.equal(malformed.status, 503);
	assert.deepEqual(await malformed.json(), { status: "error", message: "Live fuzz report is not valid JSON" });
});

test("only safe archived JSON reports are listed and served", async t => {
	const { get, reportFile, archiveDir } = await fixture(t);
	await fs.writeFile(reportFile, JSON.stringify({ secret: "outside the archive" }));
	await Promise.all([
		fs.writeFile(path.join(archiveDir, "run-001.json"), JSON.stringify({ run: 1 })),
		fs.writeFile(path.join(archiveDir, "run-002.json"), JSON.stringify({ run: 2 })),
		fs.writeFile(path.join(archiveDir, "notes.txt"), "not a report"),
		fs.writeFile(path.join(archiveDir, "broken.json"), "{partial"),
	]);
	await fs.symlink(reportFile, path.join(archiveDir, "linked.json"));

	assert.deepEqual(await (await get("/api/fuzz/runs")).json(), { runs: ["run-002.json", "run-001.json", "broken.json"] });
	const archived = await get("/api/fuzz/runs/run-001.json");
	assert.equal(archived.status, 200);
	assert.deepEqual(await archived.json(), { run: 1 });
	assert.equal((await get("/api/fuzz/runs/broken.json")).status, 503);

	for (const route of [
		"/api/fuzz/runs/missing.json",
		"/api/fuzz/runs/linked.json",
		"/api/fuzz/runs/%2e%2e%2freport.json",
		"/api/fuzz/runs/%5c..%5creport.json",
		"/api/fuzz/runs/bad%20name.json",
		"/api/fuzz/runs/nested/run-001.json",
		"/api/fuzz/runs/%E0%A4%A",
		"/api/fuzz/runs/",
	])
		assert.equal((await get(route)).status, 404, route);
});

test("a missing archive directory is an empty collection", async t => {
	const { get } = await fixture(t, { archive: false });
	const listing = await get("/api/fuzz/runs");
	assert.equal(listing.status, 200);
	assert.deepEqual(await listing.json(), { runs: [] });
	assert.equal((await get("/api/fuzz/runs/run-001.json")).status, 404);
});
