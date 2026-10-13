import { ROOT } from "./build.js";
import { createEngine } from "./engine.js";
import { createFuzzReports, fuzzPaths } from "./fuzz.js";
import { createWorkspace } from "./workspace.js";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist");
export async function startServer({ port = 4318, engineFactory = createEngine, fuzz = fuzzPaths() } = {}) {
	const token = randomBytes(32).toString("hex");
	const pending = new Map();
	let origin,
		revision = 0;
	const engine = engineFactory({
		onChange: () => {
			revision++;
		},
	});
	const workspace = createWorkspace({
		onChange: () => {
			revision++;
		},
	});
	const fuzzReports = createFuzzReports(fuzz);
	const ui = {
		transaction: prompt =>
			new Promise((resolve, reject) => {
				const id = randomUUID();
				pending.set(id, { prompt: { ...prompt, requestId: id }, resolve, reject });
				revision++;
			}),
	};
	let job = null;
	function run(action) {
		if (job) throw new Error("An operation is already running");
		job = Promise.resolve()
			.then(action)
			.catch(() => {})
			.finally(() => {
				job = null;
				revision++;
			});
		return { accepted: true };
	}
	function json(res, status, value) {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(value));
	}
	async function body(req) {
		if (req.headers["content-type"] !== "application/json") throw new Error("Expected application/json");
		let bytes = 0;
		const chunks = [];
		for await (const chunk of req) {
			bytes += chunk.length;
			if (bytes > 64 * 1024 * 1024) throw new Error("Request exceeds 64 MB");
			chunks.push(chunk);
		}
		return JSON.parse(Buffer.concat(chunks).toString());
	}
	const server = http.createServer(async (req, res) => {
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		);
		try {
			if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: "Invalid host" });
			if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "Cross-origin requests are refused" });
			const url = new URL(req.url, origin);
			// Lets the fuzz runner tell whether this app already owns the port. Says nothing else.
			if (url.pathname === "/health") return json(res, 200, { app: "perps-core-ui" });
			if (url.pathname.startsWith("/api/")) {
				const supplied = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, ""));
				if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
					return json(res, 401, { error: "Open the access link printed in your terminal" });
				if (req.method === "GET") {
					if (url.pathname === "/api/system/status") return json(res, 200, { ...workspace.status(), revision });
					if (url.pathname === "/api/system/plan") return json(res, 200, workspace.read(url.searchParams.get("id")));
					if (url.pathname === "/api/system/build") return json(res, 200, await workspace.build(url.searchParams.get("scope")));
					if (url.pathname === "/api/system/export") return json(res, 200, workspace.export(url.searchParams.get("id")));
					if (url.pathname === "/api/system/safe") return json(res, 200, await workspace.safe(url.searchParams.get("id")));
					if (url.pathname === "/api/status")
						return json(res, 200, { ...engine.status(), revision, prompts: [...pending.values()].map(p => p.prompt) });
					if (url.pathname === "/api/build") return json(res, 200, engine.build());
					if (url.pathname === "/api/plan") {
						const { build, ...record } = engine.read(url.searchParams.get("id"));
						return json(res, 200, record);
					}
					if (url.pathname === "/api/export") return json(res, 200, engine.read(url.searchParams.get("id")));
					if (url.pathname === "/api/fuzz/report") return json(res, ...(await fuzzReports.report()));
					if (url.pathname === "/api/fuzz/runs") return json(res, ...(await fuzzReports.runs()));
					if (url.pathname.startsWith("/api/fuzz/runs/"))
						return json(res, ...(await fuzzReports.run(url.pathname.slice("/api/fuzz/runs/".length))));
				}
				if (req.method !== "POST") return json(res, 405, { error: "Unsupported method" });
				const data = await body(req);
				if (url.pathname === "/api/claim") {
					const entry = pending.get(data.requestId);
					if (!entry || entry.prompt.claimed)
						throw new Error("This wallet request was already opened. Reconcile its outcome before trying again.");
					entry.prompt.claimed = true;
					revision++;
					return json(res, 200, { accepted: true });
				}
				if (url.pathname === "/api/pause-wallet") {
					const entry = pending.get(data.requestId);
					if (!entry) throw new Error("This wallet request is no longer active");
					pending.delete(data.requestId);
					entry.reject(new Error("Wallet outcome unresolved. Attach its transaction hash before continuing."));
					return json(res, 200, { accepted: true });
				}
				if (url.pathname === "/api/respond") {
					const entry = pending.get(data.requestId);
					if (!entry) throw new Error("This wallet request is no longer active");
					if (data.rejected !== true && !/^0x[\da-f]{64}$/i.test(data.hash || ""))
						throw new Error("Return a transaction hash or an explicit wallet rejection");
					pending.delete(data.requestId);
					entry.resolve(data);
					return json(res, 200, { accepted: true });
				}
				if (job) throw new Error("Wait for the current operation to finish");
				switch (url.pathname) {
					case "/api/system/execute":
						return json(
							res,
							202,
							run(() => workspace.execute(data.id, data, ui)),
						);
					case "/api/system/resume":
						return json(
							res,
							202,
							run(() => workspace.resume(ui)),
						);
					case "/api/system/cancel":
						return json(
							res,
							202,
							run(() => workspace.cancel()),
						);
					case "/api/system/attach":
						return json(res, 200, await workspace.attach(data.id, data.actionId, data.hash));
					case "/api/system/select":
						if (engine.status().busy) throw new Error("Finish the active operation before switching workspaces");
						return json(res, 200, workspace.select(data.profile || data.id));
					case "/api/system/scan":
						return json(
							res,
							202,
							run(() => workspace.scan(data.rpc, data.profile)),
						);
					case "/api/system/compare":
						return json(
							res,
							202,
							run(() => workspace.compare()),
						);
					case "/api/system/prepare":
						return json(
							res,
							202,
							run(() => workspace.prepare(data)),
						);
					case "/api/system/rehearse":
						return json(
							res,
							202,
							run(() => workspace.rehearse(data.id)),
						);
					case "/api/system/verify":
						return json(
							res,
							202,
							run(() => workspace.verify(data.id)),
						);
					case "/api/system/open":
						return json(res, 200, workspace.open(data.id));
					case "/api/system/baseline":
						return json(res, 200, workspace.importBaseline(data));
					case "/api/connect": {
						// Without an explicit RPC, a Diamond upgrade uses the connection the workspace inspected with.
						const rpc = data.rpc || workspace.endpoint();
						if (!rpc) throw new Error("Inspect the deployment live in Workspace first, or supply an RPC endpoint");
						return json(res, 200, await engine.connect(rpc, data.target));
					}
					case "/api/compile":
						return json(
							res,
							202,
							run(() => engine.compile(data.scope)),
						);
					case "/api/baseline":
						return json(res, 200, engine.importBaseline(data));
					case "/api/prepare":
						return json(res, 200, await engine.prepare(data));
					case "/api/rehearse":
						return json(
							res,
							202,
							run(() => engine.rehearse(data.id)),
						);
					case "/api/execute":
						return json(
							res,
							202,
							run(() => engine.execute(data.id, data, ui)),
						);
					case "/api/resume":
						return json(
							res,
							202,
							run(() => engine.resume(ui)),
						);
					case "/api/cancel":
						return json(
							res,
							202,
							run(() => engine.cancel()),
						);
					case "/api/attach":
						return json(res, 200, await engine.attachHash(data.id, data.actionId, data.hash));
					default:
						return json(res, 404, { error: "Unknown action" });
				}
			}
			if (req.method !== "GET") return json(res, 405, { error: "Unsupported method" });
			const assets = { "/": [path.join(DIST, "index.html"), "text/html"] };
			if (/^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)) {
				assets[url.pathname] = [path.join(DIST, url.pathname.slice(1)), url.pathname.endsWith(".js") ? "text/javascript" : "text/css"];
			}
			assets["/docs/v0.8.6/assets/v086-docs.css"] = [path.join(ROOT, "docs/v0.8.6/assets/v086-docs.css"), "text/css"];
			assets["/docs/v0.8.6/assets/symmio-mark.svg"] = [path.join(ROOT, "docs/v0.8.6/assets/symmio-mark.svg"), "image/svg+xml"];
			for (const name of ["inter", "manrope", "jetbrains-mono"])
				assets[`/docs/assets/fonts/${name}-latin.woff2`] = [path.join(ROOT, `docs/assets/fonts/${name}-latin.woff2`), "font/woff2"];
			const asset = assets[url.pathname];
			if (!asset) return json(res, 404, { error: "Not found" });
			if (!fs.existsSync(asset[0]))
				return json(res, url.pathname === "/" ? 503 : 404, { error: "Frontend build missing. Run npm run ui:build, then reload." });
			res.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
			// A rebuild can replace dist between the existence check and the read; drop the response, not the process.
			fs.createReadStream(asset[0])
				.on("error", () => res.destroy())
				.pipe(res);
		} catch (error) {
			json(res, 400, {
				error: String(error.shortMessage || error.message)
					.replace(/https?:\/\/[^\s'"<>]+/g, "<rpc>")
					.slice(0, 2000),
			});
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	origin = `http://127.0.0.1:${server.address().port}`;
	return {
		url: `${origin}/#${token}`,
		origin,
		engine,
		close: async () => {
			for (const entry of pending.values())
				entry.reject(new Error("Workbench closed while awaiting wallet outcome. Reconcile before retrying."));
			pending.clear();
			workspace.close();
			engine.close();
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		},
	};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const app = await startServer({ port: Number(process.env.PERPS_CORE_UI_PORT || 4318) });
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		await app.close();
		process.exit(0);
	};
	process.on("SIGINT", close);
	process.on("SIGTERM", close);
	if (process.send) {
		// Started by the fuzz runner: hand it the link and stop when it goes away.
		process.send({ url: app.url, origin: app.origin });
		process.on("disconnect", close);
	} else
		console.log(
			`\nSYMMIO Perps Core UI\n${app.url}\n\nKeep this terminal open. Ctrl+C stops the service; saved plans remain in .symmio/workbench.\n`,
		);
}
