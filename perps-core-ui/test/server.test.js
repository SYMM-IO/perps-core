import { startServer } from "../server/server.js";
import assert from "node:assert/strict";
import http from "node:http";
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
		assert.equal((await post("claim", { requestId })).status, 400);
		const status = await (await fetch(`${app.origin}/api/status`, { headers })).json();
		assert.equal(status.prompts[0].claimed, true);
		assert.equal((await post("pause-wallet", { requestId })).status, 200);
		assert.match(result, /outcome unresolved/);
		assert.equal((await post("respond", { requestId, rejected: true })).status, 400);
	} finally {
		await app.close();
	}
});
