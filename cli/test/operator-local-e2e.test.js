// Menu-only full local deployment, driven exactly as an operator would drive it.
//
// This is the only test that proves the whole guided path end to end: catalog, guided form,
// reviewed intent, execution, local handover, health, and the completion screen. It needs a
// persistent Hardhat node and compiled artifacts, so it is opt-in rather than part of
// `npm run test:cli`:
//
//   npm run test:cli:e2e
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;
const RPC_URL = process.env.SYMMIO_LOCAL_E2E_RPC || "http://127.0.0.1:8545";

async function rpcReady(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(RPC_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
			});
			if (response.ok) return true;
		} catch {}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	return false;
}

test(
	"the menu-only flow deploys the full system against a persistent local node",
	{ timeout: 20 * 60_000, skip: process.env.SYMMIO_LOCAL_E2E !== "true" ? "set SYMMIO_LOCAL_E2E=true to run" : false },
	async () => {
		const node = spawn("./node_modules/.bin/hardhat", ["node"], { cwd: process.cwd(), stdio: "ignore" });
		try {
			assert.ok(await rpcReady(120_000), `no JSON-RPC endpoint at ${RPC_URL}`);
			const driver = spawn(
				"python3",
				[path.resolve("cli/test/fixtures/pty-local-e2e.py"), process.cwd(), process.execPath, path.resolve("cli/symmio.js")],
				{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
			);
			let screen = "";
			let diagnostics = "";
			driver.stdout.on("data", chunk => (screen += chunk.toString()));
			driver.stderr.on("data", chunk => (diagnostics += chunk.toString()));
			const code = await new Promise((resolve, reject) => {
				driver.on("error", reject);
				driver.on("close", resolve);
			});
			const plain = screen.replace(ANSI, "");
			assert.equal(code, 0, `${diagnostics}\n${plain.slice(-4000)}`);
			assert.match(plain, /Full SYMMIO system completed/);
			// The progress bar must actually finish, not stall at the contract budget.
			assert.match(plain, /Progress\s+(\d+)\/\1 completed/);
		} finally {
			node.kill("SIGTERM");
		}
	},
);
