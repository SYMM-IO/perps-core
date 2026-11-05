import { ROOT } from "./build.js";
import { activeTaskStamp, createEngine } from "./engine.js";
import { HttpError, classify } from "./errors.js";
import { createFuzzReports, fuzzPaths } from "./fuzz.js";
import { createJobs } from "./jobs.js";
import { defaultProfiles, logInspectionPhases } from "./system.js";
import { createWorkspace } from "./workspace.js";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist");
// The task runner keeps the active task here (cli/task-runner.js); ./symmio can change it from another process.
const TASK_STATE = process.env.SYMMIO_TASK_STATE_DIR || path.join(ROOT, ".symmio", "tasks");
export async function startServer({ port = 4318, engineFactory = createEngine, fuzz = fuzzPaths(), taskState = TASK_STATE } = {}) {
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
	// The engine learns the selected deployment once at startup and again on every selection (C11).
	engine.resetForWorkspace?.(workspace.status().profile);
	const fuzzReports = createFuzzReports(fuzz);
	const jobs = createJobs({
		onChange: () => {
			revision++;
		},
	});
	const ui = {
		transaction: prompt =>
			new Promise((resolve, reject) => {
				const id = randomUUID();
				const planId = prompt.planId ?? jobs.current()?.planId;
				pending.set(id, { prompt: { ...prompt, ...(planId ? { planId } : {}), requestId: id }, resolve, reject });
				revision++;
			}),
	};
	// A status answer changes when anything this process holds changes, or when the active task file does.
	// The tag also carries a per-process id, so a counter that restarts at zero cannot match a tag from before.
	const boot = randomBytes(4).toString("hex");
	function etag(adapter) {
		// An adapter knows its own task root; the default location covers one that does not say.
		const task = adapter.activeTaskStamp?.() ?? activeTaskStamp(taskState);
		const own = Number.isSafeInteger(adapter.revision) ? adapter.revision : 0;
		return { revision: revision + own, tag: `"${boot}.${revision + own}.${task}"` };
	}
	function conditional(req, res, adapter, payload) {
		const { revision: current, tag } = etag(adapter);
		const known = String(req.headers["if-none-match"] || "")
			.split(",")
			.map(t => t.trim().replace(/^W\//, ""));
		if (known.includes(tag)) {
			res.writeHead(304, { ETag: tag, "Cache-Control": "no-store" });
			return res.end();
		}
		return json(res, 200, { ...payload(), revision: current, jobs: jobs.list() }, { ETag: tag });
	}
	function json(res, status, value, headers = {}) {
		if (status === 304) {
			res.writeHead(304, { "Cache-Control": "no-store", ...headers });
			return res.end();
		}
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
		res.end(JSON.stringify(value));
	}
	async function body(req) {
		if (req.headers["content-type"] !== "application/json") throw new HttpError(400, "bad-input", "Expected application/json");
		let bytes = 0;
		const chunks = [];
		for await (const chunk of req) {
			bytes += chunk.length;
			if (bytes > 64 * 1024 * 1024) throw new HttpError(413, "too-large", "Request exceeds 64 MB");
			chunks.push(chunk);
		}
		let data;
		try {
			data = JSON.parse(Buffer.concat(chunks).toString());
		} catch {
			throw new HttpError(400, "bad-input", "Request body is not valid JSON");
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "bad-input", "Request body must be a JSON object");
		return data;
	}
	const optionalRpc = value => {
		if (value !== undefined && value !== null && value !== "" && typeof value !== "string")
			throw new HttpError(400, "bad-input", "The RPC endpoint must be text");
		return value || undefined;
	};
	const inline = async (res, route, action, meta) => {
		const { jobId, value } = await jobs.inline(route, action, meta);
		return json(res, 200, value ?? null, { "X-Job-Id": jobId });
	};
	const background = (res, route, action, meta) => json(res, 202, jobs.start(route, action, meta));
	const idle = () => {
		if (jobs.busy()) throw new HttpError(409, "busy", "Wait for the current operation to finish");
	};
	const server = http.createServer(async (req, res) => {
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		);
		let route = "";
		try {
			if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: "Invalid host", code: "forbidden" });
			if (req.headers.origin && req.headers.origin !== origin)
				return json(res, 403, { error: "Cross-origin requests are refused", code: "forbidden" });
			const url = new URL(req.url, origin);
			route = url.pathname;
			// Lets the fuzz runner tell whether this app already owns the port. Says nothing else.
			if (url.pathname === "/health") return json(res, 200, { app: "perps-core-ui" });
			if (url.pathname.startsWith("/api/")) {
				const supplied = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, ""));
				if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
					return json(res, 401, { error: "Open the access link printed in your terminal", code: "unauthorized" });
				if (req.method === "GET") {
					if (url.pathname === "/api/profiles") return json(res, 200, { profiles: defaultProfiles });
					if (url.pathname === "/api/system/status")
						return conditional(req, res, workspace, () => {
							// The deployment list never changes while the service runs; /api/profiles serves it once.
							const { profiles, ...status } = workspace.status();
							return status;
						});
					if (url.pathname === "/api/system/plan") return json(res, 200, workspace.read(url.searchParams.get("id")));
					if (url.pathname === "/api/system/build") return json(res, 200, await workspace.build(url.searchParams.get("scope")));
					if (url.pathname === "/api/system/export") return json(res, 200, workspace.export(url.searchParams.get("id")));
					if (url.pathname === "/api/system/safe") return json(res, 200, await workspace.safe(url.searchParams.get("id")));
					if (url.pathname === "/api/status")
						return conditional(req, res, engine, () => ({ ...engine.status(), prompts: [...pending.values()].map(p => p.prompt) }));
					if (url.pathname === "/api/build") return json(res, 200, engine.build());
					// The plan without its build; /api/export attaches the stored build for download.
					if (url.pathname === "/api/plan") return json(res, 200, engine.readPlan(url.searchParams.get("id")));
					if (url.pathname === "/api/export") return json(res, 200, engine.read(url.searchParams.get("id")));
					const ifNoneMatch = req.headers["if-none-match"];
					if (url.pathname === "/api/fuzz/report") return json(res, ...(await fuzzReports.report({ ifNoneMatch })));
					if (url.pathname === "/api/fuzz/runs") return json(res, ...(await fuzzReports.runs()));
					if (url.pathname.startsWith("/api/fuzz/runs/"))
						return json(res, ...(await fuzzReports.run(url.pathname.slice("/api/fuzz/runs/".length), { ifNoneMatch })));
				}
				if (req.method !== "POST") return json(res, 405, { error: "Unsupported method", code: "method" });
				const data = await body(req);
				if (url.pathname === "/api/claim") {
					const entry = pending.get(data.requestId);
					if (!entry || entry.prompt.claimed)
						throw new HttpError(409, "claimed", "This wallet request was already opened. Reconcile its outcome before trying again.");
					entry.prompt.claimed = true;
					revision++;
					return json(res, 200, { accepted: true });
				}
				if (url.pathname === "/api/pause-wallet") {
					const entry = pending.get(data.requestId);
					if (!entry) throw new HttpError(409, "prompt-gone", "This wallet request is no longer active");
					pending.delete(data.requestId);
					revision++;
					entry.reject(new Error("Wallet outcome unresolved. Attach its transaction hash before continuing."));
					return json(res, 200, { accepted: true });
				}
				if (url.pathname === "/api/respond") {
					const entry = pending.get(data.requestId);
					if (!entry) throw new HttpError(409, "prompt-gone", "This wallet request is no longer active");
					if (data.rejected !== true && !/^0x[\da-f]{64}$/i.test(data.hash || ""))
						throw new HttpError(400, "bad-input", "Return a transaction hash or an explicit wallet rejection");
					pending.delete(data.requestId);
					revision++;
					entry.resolve(data);
					return json(res, 200, { accepted: true });
				}
				// These answer while a job runs: one stops it, the other only clears a message.
				if (url.pathname === "/api/jobs/cancel") return json(res, 200, jobs.cancel(data.jobId));
				if (url.pathname === "/api/errors/dismiss") {
					if (typeof data.id !== "string" || !data.id) throw new HttpError(400, "bad-input", "Name the error to dismiss");
					const dismissed = [engine, workspace].map(a => a.dismissError?.(data.id)).some(r => r?.dismissed === true);
					revision++;
					return json(res, 200, { dismissed });
				}
				switch (url.pathname) {
					case "/api/system/execute":
						return background(res, "system/execute", () => workspace.execute(data.id, data, ui), { planId: data.id });
					case "/api/system/resume":
						return background(res, "system/resume", () => workspace.resume(ui));
					case "/api/system/cancel":
						return background(res, "system/cancel", () => workspace.cancel());
					case "/api/system/attach":
						return await inline(res, "system/attach", () => workspace.attach(data.id, data.actionId, data.hash), { planId: data.id });
					case "/api/system/reconnect": {
						const rpc = optionalRpc(data.rpc);
						return await inline(res, "system/reconnect", () => workspace.reconnect({ rpc }));
					}
					case "/api/system/select": {
						idle();
						const profile = workspace.select(data.profile || data.id);
						// A Diamond connection from another deployment must not be offered for this one. The engine keeps it
						// while it owns an active task, which still needs that chain.
						engine.resetForWorkspace?.(profile);
						return json(res, 200, profile);
					}
					case "/api/system/scan": {
						const rpc = optionalRpc(data.rpc);
						return background(res, "system/scan", ({ signal }) => workspace.scan({ rpc, profile: data.profile, signal }));
					}
					case "/api/system/compare":
						return background(res, "system/compare", ({ signal }) => workspace.compare({ signal }));
					case "/api/system/prepare":
						return background(res, "system/prepare", () => workspace.prepare(data));
					case "/api/system/rehearse":
						return background(res, "system/rehearse", ({ signal }) => workspace.rehearse(data.id, { signal }), { planId: data.id });
					case "/api/system/verify":
						return background(res, "system/verify", () => workspace.verify(data.id), { planId: data.id });
					case "/api/system/open":
						idle();
						return json(res, 200, workspace.open(data.id));
					case "/api/system/baseline":
						idle();
						return json(res, 200, workspace.importBaseline(data));
					case "/api/connect": {
						const explicit = optionalRpc(data.rpc);
						return await inline(res, "connect", ({ signal }) => {
							// Without an explicit RPC, a Diamond upgrade uses the connection the workspace inspected with.
							const rpc = explicit || workspace.endpoint();
							if (!rpc) throw new Error("Inspect the deployment live in Workspace first, or supply an RPC endpoint");
							return engine.connect({ rpc, target: data.target, signal });
						});
					}
					case "/api/reconnect": {
						const rpc = optionalRpc(data.rpc);
						// Without an RPC, the workspace's own connection is reused when it is on the task's chain, then the public one.
						const shared = { rpc: workspace.endpoint(), chainId: workspace.status().profile?.chainId };
						return await inline(res, "reconnect", () => engine.reconnect({ rpc, shared }));
					}
					case "/api/compile":
						return background(res, "compile", ({ signal }) => engine.compile(data.scope, { signal }));
					case "/api/baseline":
						idle();
						return json(res, 200, engine.importBaseline(data));
					case "/api/prepare":
						return await inline(res, "prepare", () => {
							// The engine refuses when its connection is on another chain than the deployment on screen.
							const workspaceChainId = workspace.status().profile?.chainId;
							return engine.prepare(data, { workspaceChainId });
						});
					case "/api/rehearse":
						return background(res, "rehearse", ({ signal }) => engine.rehearse(data.id, { signal }), { planId: data.id });
					case "/api/execute":
						return background(res, "execute", () => engine.execute(data.id, data, ui), { planId: data.id });
					case "/api/resume":
						return background(res, "resume", () => engine.resume(ui));
					case "/api/cancel":
						return background(res, "cancel", () => engine.cancel());
					case "/api/attach":
						return await inline(res, "attach", () => engine.attachHash(data.id, data.actionId, data.hash), { planId: data.id });
					default:
						return json(res, 404, { error: "Unknown action", code: "unknown-route" });
				}
			}
			if (req.method !== "GET") return json(res, 405, { error: "Unsupported method", code: "method" });
			const assets = { "/": [path.join(DIST, "index.html"), "text/html"] };
			if (/^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)) {
				assets[url.pathname] = [path.join(DIST, url.pathname.slice(1)), url.pathname.endsWith(".js") ? "text/javascript" : "text/css"];
			}
			assets["/docs/v0.8.6/assets/v086-docs.css"] = [path.join(ROOT, "docs/v0.8.6/assets/v086-docs.css"), "text/css"];
			assets["/docs/v0.8.6/assets/symmio-mark.svg"] = [path.join(ROOT, "docs/v0.8.6/assets/symmio-mark.svg"), "image/svg+xml"];
			for (const name of ["inter", "manrope", "jetbrains-mono"])
				assets[`/docs/assets/fonts/${name}-latin.woff2`] = [path.join(ROOT, `docs/assets/fonts/${name}-latin.woff2`), "font/woff2"];
			const asset = assets[url.pathname];
			if (!asset) return json(res, 404, { error: "Not found", code: "not-found" });
			if (!fs.existsSync(asset[0]))
				return json(res, url.pathname === "/" ? 503 : 404, {
					error: "Frontend build missing. Run npm run ui:build, then reload.",
					code: "no-build",
				});
			res.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
			// A rebuild can replace dist between the existence check and the read; drop the response, not the process.
			fs.createReadStream(asset[0])
				.on("error", () => res.destroy())
				.pipe(res);
		} catch (error) {
			const { status, code, message } = classify(error);
			if (status >= 500) console.error(`${route || "request"} failed: ${message}`);
			if (!res.headersSent) json(res, status, { error: message, code, ...(error?.jobId ? { jobId: error.jobId } : {}) });
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
			jobs.abortAll();
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
	// One line per inspection phase in this terminal, so a long run is never silent.
	logInspectionPhases(line => console.log(line));
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
