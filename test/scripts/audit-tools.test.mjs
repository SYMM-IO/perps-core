import { Interface, ZeroAddress } from "ethers";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("deployment inventory rejects missing code and failed required reads without sending transactions", async () => {
	const methods = [];
	const hash = `0x${"11".repeat(32)}`;
	const block = {
		hash,
		parentHash: hash,
		number: "0x64",
		timestamp: "0x1",
		nonce: "0x0000000000000000",
		difficulty: "0x0",
		gasLimit: "0x1c9c380",
		gasUsed: "0x0",
		miner: `0x${"00".repeat(20)}`,
		extraData: "0x",
		baseFeePerGas: "0x1",
		transactions: [],
	};
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const query = JSON.parse(body);
		methods.push(query.method);
		const results = { eth_chainId: "0xa4b1", eth_blockNumber: "0x64", eth_getBlockByNumber: block, eth_getCode: "0x" };
		const reply = Object.hasOwn(results, query.method)
			? { jsonrpc: "2.0", id: query.id, result: results[query.method] }
			: { jsonrpc: "2.0", id: query.id, error: { code: 3, message: "execution reverted", data: "0x" } };
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(reply));
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const directory = mkdtempSync(path.join(os.tmpdir(), "symmio-audit-read-only-"));
	const output = path.join(directory, "inventory.json");
	try {
		const root = fileURLToPath(new URL("../..", import.meta.url));
		const outcome = await new Promise(resolve =>
			execFile(
				process.execPath,
				["scripts/audit/inspect-deployment.mjs", "--deployment", "arbitrum-vibe", "--output", output],
				{
					cwd: root,
					env: { ...process.env, AUDIT_RPC_URL: `http://127.0.0.1:${server.address().port}` },
					timeout: 30_000,
				},
				(error, stdout, stderr) => resolve({ error, stdout, stderr }),
			),
		);
		assert.equal(outcome.error?.code, 1, `${outcome.stdout}\n${outcome.stderr}`);
		const report = JSON.parse(readFileSync(output, "utf8"));
		assert.equal(report.deployments[0].status, "incomplete");
		assert(report.deployments[0].requiredReadFailures.some(item => item.error === "Configured address has no bytecode"));
		assert(methods.includes("eth_call"));
		assert(methods.every(method => ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(method)));
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		if (existsSync(output)) unlinkSync(output);
		rmdirSync(directory);
	}
});

function emptyValue(type) {
	if (type.baseType === "array") return Array.from({ length: Math.max(type.arrayLength, 0) }, () => emptyValue(type.arrayChildren));
	if (type.baseType === "tuple") return type.components.map(emptyValue);
	if (type.type === "address") return ZeroAddress;
	if (type.type === "bool") return false;
	if (type.type === "string") return "";
	if (type.type.startsWith("bytes")) return `0x${"00".repeat(Number(type.type.slice(5)) || 0)}`;
	return 0n;
}

for (const failAccountReads of [false, true]) {
	test(`bounded inventory scans IDs above one million and ${failAccountReads ? "rejects failed" : "retains successful"} account reads`, async () => {
		const root = fileURLToPath(new URL("../..", import.meta.url));
		const interfaces = ["symmio", "accountLayer", "instantLayer"].map(
			name => new Interface(JSON.parse(readFileSync(path.join(root, "abis", `${name}.json`), "utf8"))),
		);
		interfaces.push(
			new Interface([
				"function facets() view returns ((address facetAddress,bytes4[] functionSelectors)[])",
				"function getAllPublicKeys() view returns ((uint256 x,uint8 parity)[])",
			]),
		);
		const lastId = 2_000_001n;
		const hash = `0x${"11".repeat(32)}`;
		const block = {
			hash,
			parentHash: hash,
			number: "0x64",
			timestamp: "0x1",
			nonce: "0x0000000000000000",
			difficulty: "0x0",
			gasLimit: "0x1c9c380",
			gasUsed: "0x0",
			miner: ZeroAddress,
			extraData: "0x",
			baseFeePerGas: "0x1",
			transactions: [],
		};
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			const query = JSON.parse(body);
			let result;
			try {
				if (query.method === "eth_call") {
					let match;
					for (const iface of interfaces) {
						const fragment = iface.getFunction(query.params[0].data.slice(0, 10));
						if (fragment) {
							match = { iface, fragment };
							break;
						}
					}
					assert(match, "Unexpected contract call");
					const { iface, fragment } = match;
					if (failAccountReads && ["getPartyAPendingQuotes", "isPartyALiquidated"].includes(fragment.name))
						throw new Error("account read failed");
					const output = fragment.outputs.map(emptyValue);
					if (fragment.name === "getNextQuoteId") output[0] = lastId;
					if (fragment.name === "getPartyAPendingQuotes") output[0] = [lastId];
					if (fragment.name === "getQuotesWithBitmap") {
						const type = fragment.outputs[0].arrayChildren;
						const quote = emptyValue(type);
						quote[type.components.findIndex(item => item.name === "id")] = lastId;
						quote[type.components.findIndex(item => item.name === "partyA")] = `0x${"22".repeat(20)}`;
						output[0] = [quote];
					}
					result = iface.encodeFunctionResult(fragment, output);
				} else {
					const results = { eth_chainId: "0xa4b1", eth_blockNumber: "0x64", eth_getBlockByNumber: block, eth_getCode: "0x6000" };
					assert(Object.hasOwn(results, query.method), `Unexpected RPC method ${query.method}`);
					result = results[query.method];
				}
				response.end(JSON.stringify({ jsonrpc: "2.0", id: query.id, result }));
			} catch {
				response.end(JSON.stringify({ jsonrpc: "2.0", id: query.id, error: { code: 3, message: "execution reverted", data: "0x" } }));
			}
		});
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		const directory = mkdtempSync(path.join(os.tmpdir(), "symmio-audit-account-reads-"));
		const output = path.join(directory, "inventory.json");
		try {
			const outcome = await new Promise(resolve =>
				execFile(
					process.execPath,
					["scripts/audit/inspect-deployment.mjs", "--deployment", "arbitrum-vibe", "--quote-limit", "1", "--output", output],
					{ cwd: root, env: { ...process.env, AUDIT_RPC_URL: `http://127.0.0.1:${server.address().port}` }, timeout: 30_000 },
					(error, stdout, stderr) => resolve({ error, stdout, stderr }),
				),
			);
			assert.equal(outcome.error?.code ?? 0, failAccountReads ? 1 : 0, `${outcome.stdout}\n${outcome.stderr}`);
			const deployment = JSON.parse(readFileSync(output, "utf8")).deployments[0];
			assert.equal(deployment.quoteScan.scanned, 1);
			assert.equal(deployment.quoteScan.firstId, String(lastId));
			assert.equal(deployment.quoteScan.accounts.length, 1);
			assert.equal(deployment.status, failAccountReads ? "incomplete" : "declared reads complete");
			if (failAccountReads) {
				assert(deployment.requiredReadFailures.some(item => item.path === "quoteScan.accounts.0.pending"));
				assert(deployment.requiredReadFailures.some(item => item.path === "quoteScan.accounts.0.liquidating"));
			} else assert.deepEqual(deployment.requiredReadFailures, []);
		} finally {
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
			if (existsSync(output)) unlinkSync(output);
			rmdirSync(directory);
		}
	});
}
