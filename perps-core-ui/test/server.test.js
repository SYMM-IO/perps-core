import { redact, classify } from "../server/errors.js";
import { HttpError } from "../server/errors.js";
import { startServer } from "../server/server.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("localhost API requires session authentication and refuses cross-origin writes", async () => {
	let calls = 0;
	const app = await startServer({
		port: 0,
		engineFactory: () => ({
			status: () => ({ active: null }),
			connect: () => {
				calls++;
			},
			close() {},
		}),
	});
	try {
		assert.equal((await fetch(`${app.origin}/`)).status, 200);
		assert.equal((await fetch(`${app.origin}/api/status`)).status, 401);
		const headers = { Authorization: `Bearer ${app.url.split("#")[1]}`, "Content-Type": "application/json" };
		assert.equal((await fetch(`${app.origin}/api/status`, { headers })).status, 200);
		assert.equal(
			(await fetch(`${app.origin}/api/connect`, { method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: "{}" }))
				.status,
			403,
		);
		assert.equal(calls, 0);
		const hostStatus = await new Promise(resolve => {
			const req = http.request(`${app.origin}/api/connect`, { method: "POST", headers: { ...headers, Host: "attacker.example" } }, res => {
				res.resume();
				resolve(res.statusCode);
			});
			req.end("{}");
		});
		assert.equal(hostStatus, 403);
		// A Diamond upgrade may omit the RPC only when the workspace already holds a live connection.
		const unconnected = await fetch(`${app.origin}/api/connect`, { method: "POST", headers, body: JSON.stringify({ target: "0x" }) });
		assert.equal(unconnected.status, 400);
		assert.match((await unconnected.json()).error, /Inspect the deployment live in Workspace first/);
		assert.equal(calls, 0);
		const explicit = await fetch(`${app.origin}/api/connect`, {
			method: "POST",
			headers,
			body: JSON.stringify({ rpc: "http://127.0.0.1:1", target: "0x" }),
		});
		assert.equal(explicit.status, 200);
		assert.equal(calls, 1);
		const response = await fetch(`${app.origin}/`);
		assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
		assert.match(response.headers.get("content-security-policy"), /script-src 'self';/);
		const html = await response.text();
		const script = html.match(/src="(\/assets\/[^"]+\.js)"/)[1];
		assert.equal((await fetch(`${app.origin}${script}`)).status, 200);
		assert.equal((await fetch(`${app.origin}/assets/missing.js`)).status, 404);
		assert.equal((await fetch(`${app.origin}/assets/../server.js`)).status, 404);
		assert.equal((await fetch(`${app.origin}/app.js`)).status, 404);
		assert.equal((await fetch(`${app.origin}/.env.local`)).status, 404);
	} finally {
		await app.close();
	}
});

test("wallet prompts are claimed once across reloads and can pause for hash recovery", async () => {
	let result;
	const app = await startServer({
		port: 0,
		engineFactory: () => ({
			status: () => ({}),
			close() {},
			execute: async (_id, _input, ui) => {
				try {
					result = await ui.transaction({ id: "cut", sender: "0x123" });
				} catch (error) {
					result = error.message;
				}
			},
		}),
	});
	const headers = { Authorization: `Bearer ${app.url.split("#")[1]}`, "Content-Type": "application/json" };
	const post = (route, body) => fetch(`${app.origin}/api/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
	try {
		await post("execute", { id: "plan" });
		const { prompts } = await (await fetch(`${app.origin}/api/status`, { headers })).json();
		assert.equal(prompts.length, 1);
		const requestId = prompts[0].requestId;
		assert.equal((await post("claim", { requestId })).status, 200);
		const again = await post("claim", { requestId });
		assert.equal(again.status, 409);
		assert.equal((await again.json()).code, "claimed");
		const status = await (await fetch(`${app.origin}/api/status`, { headers })).json();
		assert.equal(status.prompts[0].claimed, true);
		assert.equal((await post("pause-wallet", { requestId })).status, 200);
		assert.match(result, /outcome unresolved/);
		assert.equal((await post("respond", { requestId, rejected: true })).status, 409);
	} finally {
		await app.close();
	}
});

// A fake engine whose operations finish when the test says so, and whose compile honours cancellation.
function controllable() {
	const waiting = {};
	const until = name => new Promise(resolve => (waiting[name] = resolve));
	let revision = 0;
	const engine = {
		get revision() {
			return revision;
		},
		status: () => ({ busy: false }),
		close() {},
		execute: () => until("execute"),
		compile: (_scope, { signal } = {}) =>
			new Promise((resolve, reject) => {
				waiting.compile = () => resolve({ digest: "0xabc" });
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
		prepare: async () => {
			throw new Error("Source changed; compile again");
		},
		bump: () => revision++,
	};
	return { engine, finish: (name, value) => waiting[name]?.(value) };
}
async function session(engine) {
	const app = await startServer({ port: 0, engineFactory: () => engine });
	const headers = { Authorization: `Bearer ${app.url.split("#")[1]}`, "Content-Type": "application/json" };
	const get = (route, extra = {}) => fetch(`${app.origin}/api/${route}`, { headers: { ...headers, ...extra } });
	const post = (route, body = {}) => fetch(`${app.origin}/api/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
	const jobs = async () => (await (await get("status")).json()).jobs;
	const settled = async jobId => {
		for (let i = 0; i < 100; i++) {
			const job = (await jobs()).find(j => j.id === jobId);
			if (job.state !== "running") return job;
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		throw new Error("job did not finish");
	};
	return { app, get, post, jobs, settled };
}

test("profiles are served once, and status answers 304 until something changes", async () => {
	const { engine } = controllable();
	const { app, get, post } = await session(engine);
	try {
		const { profiles } = await (await get("profiles")).json();
		assert.equal(profiles.length, 26);
		assert.equal(profiles.find(p => p.id === "arbitrum-vibe").chainName, "arbitrum");

		const system = await get("system/status");
		assert.equal(system.status, 200);
		const systemTag = system.headers.get("etag");
		assert.match(systemTag, /^"[a-f0-9]{8}\.\d+\.[^"]+"$/);
		const body = await system.json();
		assert.equal("profiles" in body, false);
		assert.ok(body.profile);
		assert.equal((await get("system/status", { "If-None-Match": systemTag })).status, 304);

		const first = await get("status");
		const tag = first.headers.get("etag");
		assert.equal((await first.json()).revision, Number(tag.slice(1).split(".")[1]));
		const unchanged = await get("status", { "If-None-Match": tag });
		assert.equal(unchanged.status, 304);
		assert.equal(await unchanged.text(), "");
		// A change inside the engine moves the tag, and so does a job the server records.
		engine.bump();
		const moved = await get("status", { "If-None-Match": tag });
		assert.equal(moved.status, 200);
		const next = moved.headers.get("etag");
		assert.notEqual(next, tag);
		await post("prepare", {});
		assert.equal((await get("status", { "If-None-Match": next })).status, 200);
	} finally {
		await app.close();
	}
});

test("the status tag moves when the CLI's task runner stops, even though no task file changes", async () => {
	const taskState = fs.mkdtempSync(path.join(os.tmpdir(), "task-etag-"));
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const app = await startServer({ port: 0, taskState, engineFactory: () => ({ status: () => ({}), close() {} }) });
	const headers = { Authorization: `Bearer ${app.url.split("#")[1]}` };
	const get = (extra = {}) => fetch(`${app.origin}/api/status`, { headers: { ...headers, ...extra } });
	try {
		fs.writeFileSync(path.join(taskState, "active.json"), JSON.stringify({ status: "running" }));
		fs.writeFileSync(path.join(taskState, "runner.lock"), JSON.stringify({ pid: child.pid, runId: "r" }));
		const tag = (await get()).headers.get("etag");
		assert.equal((await get({ "If-None-Match": tag })).status, 304);
		// The CLI dies without releasing its lock: getActive now reports it as not running, so the tag must move.
		const exited = new Promise(resolve => child.once("exit", resolve));
		child.kill("SIGKILL");
		await exited;
		assert.equal((await get({ "If-None-Match": tag })).status, 200);
		// Two atomic rewrites of the active task in quick succession are still two different states.
		const before = (await get()).headers.get("etag");
		const next = path.join(taskState, "active.json.tmp");
		fs.writeFileSync(next, JSON.stringify({ status: "paused" }));
		fs.renameSync(next, path.join(taskState, "active.json"));
		assert.equal((await get({ "If-None-Match": before })).status, 200);
	} finally {
		child.kill("SIGKILL");
		await app.close();
		fs.rmSync(taskState, { recursive: true, force: true });
	}
});

test("jobs have ids, a refused start is recorded, and only reads can be cancelled", async () => {
	const { engine, finish } = controllable();
	const { app, post, jobs, settled } = await session(engine);
	try {
		const started = await post("execute", { id: "a".repeat(64) });
		assert.equal(started.status, 202);
		const { accepted, jobId } = await started.json();
		assert.equal(accepted, true);
		const [running] = await jobs();
		assert.deepEqual([running.id, running.route, running.state, running.planId], [jobId, "execute", "running", "a".repeat(64)]);

		// A second job while one runs: 409 with a code, and a failed job the interface can show.
		const busy = await post("compile", { scope: "core" });
		assert.equal(busy.status, 409);
		const refusal = await busy.json();
		assert.equal(refusal.code, "busy");
		const refused = (await jobs()).find(j => j.id === refusal.jobId);
		assert.deepEqual([refused.route, refused.state, refused.code], ["compile", "failed", "busy"]);
		// The inline routes take the same lock.
		assert.equal((await post("connect", { rpc: "http://127.0.0.1:1", target: "0x" })).status, 409);

		// Execution follows the task runner's own cancellation, so the job route refuses it.
		const refuse = await post("jobs/cancel", { jobId });
		assert.equal(refuse.status, 409);
		assert.equal((await refuse.json()).code, "not-cancellable");
		assert.equal((await post("jobs/cancel", { jobId: "missing" })).status, 404);

		finish("execute", { status: "completed" });
		assert.equal((await settled(jobId)).state, "done");

		// A compile can be stopped; its job ends cancelled. One left to finish reports what it built.
		const compile = (await (await post("compile", { scope: "core" })).json()).jobId;
		assert.equal((await post("jobs/cancel", { jobId: compile })).status, 200);
		assert.equal((await settled(compile)).state, "cancelled");
		const built = (await (await post("compile", { scope: "core" })).json()).jobId;
		finish("compile");
		assert.deepEqual((await settled(built)).result, { digest: "0xabc" });

		// A stale precondition answers 412 with its code, and is kept on the job as well.
		const stale = await post("prepare", {});
		assert.equal(stale.status, 412);
		const { code, jobId: staleJob } = await stale.json();
		assert.equal(code, "stale-source");
		assert.equal((await jobs()).find(j => j.id === staleJob).code, "stale-source");
		assert.ok((await jobs()).length <= 10);

		// Malformed input is a 400 with a code, not an unexpected failure.
		const malformed = await fetch(`${app.origin}/api/compile`, {
			method: "POST",
			headers: { Authorization: `Bearer ${app.url.split("#")[1]}`, "Content-Type": "application/json" },
			body: "{",
		});
		assert.equal(malformed.status, 400);
		assert.equal((await malformed.json()).code, "bad-input");
	} finally {
		await app.close();
	}
});

test("a failed job hands its error to the job list and the adapter, the lock is released, and dismissal clears only that error", async () => {
	const current = { error: null, errorInfo: null };
	let dismissCalls = 0;
	const engine = {
		status: () => ({ busy: false, ...current }),
		close() {},
		// Like engine.guarded: the adapter keeps the error it raised, then rethrows it tagged.
		rehearse: async id => {
			const error = new HttpError(412, "stale-plan", `Saved plan checksum mismatch for ${id.slice(0, 4)} via https://rpc.example/key123`);
			current.error = "Saved plan checksum mismatch";
			current.errorInfo = { id: "err-1", operation: "rehearse", message: current.error, code: error.code, at: new Date().toISOString() };
			throw error;
		},
		readPlan: id => ({ plan: { id }, status: "prepared" }),
		read: id => ({ plan: { id }, status: "prepared", build: { digest: "x" } }),
		dismissError: id => {
			dismissCalls++;
			if (current.errorInfo?.id !== id) return { dismissed: false };
			current.error = current.errorInfo = null;
			return { dismissed: true };
		},
	};
	const { app, get, post, settled } = await session(engine);
	try {
		const { jobId } = await (await post("rehearse", { id: "a".repeat(64) })).json();
		const job = await settled(jobId);
		assert.deepEqual([job.state, job.code, job.planId], ["failed", "stale-plan", "a".repeat(64)]);
		assert.match(job.error, /checksum mismatch/);
		assert.doesNotMatch(job.error, /key123/, "job errors are redacted");
		const status = await (await get("status")).json();
		assert.equal(status.errorInfo.code, "stale-plan");
		// The lock was released: another job starts.
		assert.equal((await post("rehearse", { id: "b".repeat(64) })).status, 202);
		assert.deepEqual(await (await post("errors/dismiss", { id: "someone-else" })).json(), { dismissed: false });
		assert.deepEqual(await (await post("errors/dismiss", { id: "err-1" })).json(), { dismissed: true });
		assert.ok(dismissCalls >= 2);
		assert.equal((await (await get("status")).json()).errorInfo, null);
		assert.equal((await post("errors/dismiss", {})).status, 400);
		// The plan route answers without the build; export keeps it.
		assert.equal("build" in (await (await get(`plan?id=${"a".repeat(64)}`)).json()), false);
		assert.equal((await (await get(`export?id=${"a".repeat(64)}`)).json()).build.digest, "x");
	} finally {
		await app.close();
	}
});

test("compile receives the cancellation signal through the server's call shape", async () => {
	let received;
	const engine = {
		status: () => ({ busy: false }),
		close() {},
		compile: (scope, { signal } = {}) => {
			received = { scope, signal };
			return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		},
	};
	const { app, post, settled } = await session(engine);
	try {
		const { jobId } = await (await post("compile", { scope: "accountLayer" })).json();
		assert.equal(received.scope, "accountLayer");
		assert.ok(received.signal instanceof AbortSignal);
		assert.equal((await post("jobs/cancel", { jobId })).status, 200);
		const job = await settled(jobId);
		assert.deepEqual([job.state, job.code], ["cancelled", "cancelled"]);
	} finally {
		await app.close();
	}
});

test("the fuzz report route sends an ETag and answers 304 for an unchanged report", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-etag-"));
	const reportFile = path.join(dir, "report.json");
	fs.writeFileSync(reportFile, JSON.stringify({ schemaVersion: 1, run: { status: "running" } }));
	const app = await startServer({
		port: 0,
		engineFactory: () => ({ status: () => ({}), close() {} }),
		fuzz: { reportFile, archiveDir: path.join(dir, "runs") },
	});
	const headers = { Authorization: `Bearer ${app.url.split("#")[1]}` };
	try {
		const first = await fetch(`${app.origin}/api/fuzz/report`, { headers });
		assert.equal(first.status, 200);
		const tag = first.headers.get("etag");
		assert.ok(tag);
		assert.equal((await first.json()).run.status, "running");
		const unchanged = await fetch(`${app.origin}/api/fuzz/report`, { headers: { ...headers, "If-None-Match": tag } });
		assert.equal(unchanged.status, 304);
		assert.equal(await unchanged.text(), "");
		fs.writeFileSync(reportFile, JSON.stringify({ schemaVersion: 1, run: { status: "passed", extra: true } }));
		const changed = await fetch(`${app.origin}/api/fuzz/report`, { headers: { ...headers, "If-None-Match": tag } });
		assert.equal(changed.status, 200);
		assert.equal((await changed.json()).run.status, "passed");
	} finally {
		await app.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("one redaction rule covers RPC URLs, named keys and tokens, and leaves hashes readable", () => {
	const key = "ab".repeat(32);
	const hash = `0x${"cd".repeat(32)}`;
	const text = redact(
		`could not reach https://arb-mainnet.example.io/v2/SECRET123 or wss://node.example/ws?token=abc; private key: 0x${key}; ` +
			`api_key=xyz token: t0k key=k3y; tx ${hash}`,
	);
	for (const secret of ["SECRET123", "abc", key, "xyz", "t0k", "k3y"]) assert.doesNotMatch(text, new RegExp(secret));
	assert.match(text, /could not reach <rpc> or <rpc>/);
	assert.match(text, new RegExp(hash));
	assert.equal(redact("x".repeat(3000)).length, 2000);
	// Each kind of failure keeps its own status and code.
	assert.deepEqual(
		[
			classify(new Error("Another workbench operation is running")),
			classify(new Error("Deployment signer nonce changed; prepare again")),
			classify(new TypeError("x is undefined")),
			classify(Object.assign(new Error("No such plan"), { status: 412, code: "stale-plan" })),
		].map(e => [e.status, e.code]),
		[
			[409, "busy"],
			[412, "nonce-changed"],
			[500, "internal"],
			[412, "stale-plan"],
		],
	);
});
