import { lstat, readFile, readdir } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { resolve } from "node:path"

export type FuzzDashboardLoopbackHost = "127.0.0.1" | "localhost" | "::1"

export type FuzzDashboardServerConfig = {
	host: FuzzDashboardLoopbackHost
	port: number
	assetsDir: string
	reportFile: string
	archiveDir?: string
}

export type FuzzDashboardServerHandle = {
	url: string
	port: number
	close(): Promise<void>
}

type ResponsePayload = {
	status: number
	contentType: string
	body: Buffer
	headers?: Readonly<Record<string, string>>
}

type DashboardRoute =
	| { kind: "asset"; filename: "index.html" | "dashboard.js" | "dashboard.css"; contentType: string }
	| { kind: "report" }
	| { kind: "runs" }
	| { kind: "archived-run"; filename: string }
	| { kind: "health" }

const DEFAULT_HOST: FuzzDashboardLoopbackHost = "127.0.0.1"
const DEFAULT_PORT = 4173
const LOOPBACK_HOSTS = new Set<FuzzDashboardLoopbackHost>(["127.0.0.1", "localhost", "::1"])
const SAFE_ARCHIVE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
	Pragma: "no-cache",
	Expires: "0",
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
		"base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy": "camera=(), geolocation=(), microphone=()",
}

const STATIC_ROUTES = new Map<string, Extract<DashboardRoute, { kind: "asset" }>>([
	["/", { kind: "asset", filename: "index.html", contentType: "text/html; charset=utf-8" }],
	["/dashboard.js", { kind: "asset", filename: "dashboard.js", contentType: "text/javascript; charset=utf-8" }],
	["/dashboard.css", { kind: "asset", filename: "dashboard.css", contentType: "text/css; charset=utf-8" }],
])

function loopbackHost(value: string | undefined): FuzzDashboardLoopbackHost {
	const host = value?.trim() || DEFAULT_HOST
	if (!LOOPBACK_HOSTS.has(host as FuzzDashboardLoopbackHost)) {
		throw new Error(`FUZZ_DASHBOARD_HOST must be a loopback host (127.0.0.1, localhost, or ::1), received ${JSON.stringify(host)}`)
	}
	return host as FuzzDashboardLoopbackHost
}

function dashboardPort(value: string | undefined): number {
	const raw = value?.trim()
	if (raw === undefined || raw === "") return DEFAULT_PORT
	if (!/^\d+$/.test(raw)) {
		throw new Error(`FUZZ_DASHBOARD_PORT must be an integer between 1 and 65535, received ${JSON.stringify(value)}`)
	}
	const port = Number(raw)
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`FUZZ_DASHBOARD_PORT must be an integer between 1 and 65535, received ${JSON.stringify(value)}`)
	}
	return port
}

function configuredPath(cwd: string, value: string | undefined, fallback: string): string {
	const configured = value?.trim()
	return resolve(cwd, configured === undefined || configured === "" ? fallback : configured)
}

export function resolveFuzzDashboardServerConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): FuzzDashboardServerConfig {
	return {
		host: loopbackHost(env.FUZZ_DASHBOARD_HOST),
		port: dashboardPort(env.FUZZ_DASHBOARD_PORT),
		assetsDir: resolve(cwd, "scripts/fuzz/dashboard"),
		reportFile: configuredPath(cwd, env.FUZZ_DASHBOARD_FILE, ".fuzz-dashboard/report.json"),
		archiveDir: configuredPath(cwd, env.FUZZ_DASHBOARD_ARCHIVE_DIR, ".fuzz-dashboard/runs"),
	}
}

function validateServerConfig(config: FuzzDashboardServerConfig): void {
	if (!LOOPBACK_HOSTS.has(config.host)) {
		throw new Error(`Fuzz dashboard server may only bind to a loopback host, received ${JSON.stringify(config.host)}`)
	}
	if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65_535) {
		throw new Error(`Fuzz dashboard server port must be an integer between 0 and 65535, received ${config.port}`)
	}
	if (config.assetsDir.length === 0) throw new Error("Fuzz dashboard assetsDir must not be empty")
	if (config.reportFile.length === 0) throw new Error("Fuzz dashboard reportFile must not be empty")
}

function jsonPayload(value: unknown, status = 200, headers?: Readonly<Record<string, string>>): ResponsePayload {
	return {
		status,
		contentType: "application/json; charset=utf-8",
		body: Buffer.from(`${JSON.stringify(value)}\n`),
		headers,
	}
}

function isFileSystemError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}

async function readJsonPayload(
	filename: string,
	options: {
		missing: ResponsePayload
		invalidMessage: string
	},
): Promise<ResponsePayload> {
	let content: string
	try {
		content = await readFile(filename, "utf8")
	} catch (error) {
		if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return options.missing
		throw error
	}

	try {
		return jsonPayload(JSON.parse(content))
	} catch {
		return jsonPayload({ status: "error", message: options.invalidMessage }, 503)
	}
}

function decodeArchiveFilename(pathname: string): string | undefined {
	const prefix = "/api/runs/"
	if (!pathname.startsWith(prefix)) return undefined
	const encodedName = pathname.slice(prefix.length)
	if (encodedName.length === 0 || encodedName.includes("/")) return undefined

	let filename: string
	try {
		filename = decodeURIComponent(encodedName)
	} catch {
		return undefined
	}
	if (!SAFE_ARCHIVE_FILENAME.test(filename) || filename.includes("/") || filename.includes("\\")) return undefined
	return filename
}

function matchRoute(pathname: string): DashboardRoute | undefined {
	const asset = STATIC_ROUTES.get(pathname)
	if (asset !== undefined) return asset
	if (pathname === "/api/report") return { kind: "report" }
	if (pathname === "/api/runs") return { kind: "runs" }
	if (pathname === "/health") return { kind: "health" }
	const filename = decodeArchiveFilename(pathname)
	return filename === undefined ? undefined : { kind: "archived-run", filename }
}

async function listArchivedRuns(archiveDir: string | undefined): Promise<ResponsePayload> {
	if (archiveDir === undefined) return jsonPayload({ runs: [] })

	let entries
	try {
		entries = await readdir(archiveDir, { withFileTypes: true })
	} catch (error) {
		if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return jsonPayload({ runs: [] })
		throw error
	}

	const runs = entries
		.filter(entry => entry.isFile() && SAFE_ARCHIVE_FILENAME.test(entry.name))
		.map(entry => entry.name)
		.sort((left, right) => right.localeCompare(left))
	return jsonPayload({ runs })
}

async function archivedRunPayload(archiveDir: string | undefined, filename: string): Promise<ResponsePayload> {
	const notFound = jsonPayload({ status: "not_found" }, 404)
	if (archiveDir === undefined) return notFound

	const archiveRoot = resolve(archiveDir)
	const candidate = resolve(archiveRoot, filename)
	if (resolve(candidate, "..") !== archiveRoot) return notFound

	try {
		const metadata = await lstat(candidate)
		if (!metadata.isFile() || metadata.isSymbolicLink()) return notFound
	} catch (error) {
		if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return notFound
		throw error
	}

	return readJsonPayload(candidate, {
		missing: notFound,
		invalidMessage: "Archived fuzz report is not valid JSON",
	})
}

async function payloadForRoute(route: DashboardRoute, config: FuzzDashboardServerConfig): Promise<ResponsePayload> {
	switch (route.kind) {
		case "asset": {
			const filename = resolve(config.assetsDir, route.filename)
			try {
				return {
					status: 200,
					contentType: route.contentType,
					body: await readFile(filename),
				}
			} catch (error) {
				if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) {
					return jsonPayload({ status: "not_found" }, 404)
				}
				throw error
			}
		}
		case "report":
			return readJsonPayload(config.reportFile, {
				missing: jsonPayload({ status: "waiting" }),
				invalidMessage: "Live fuzz report is not valid JSON",
			})
		case "runs":
			return listArchivedRuns(config.archiveDir)
		case "archived-run":
			return archivedRunPayload(config.archiveDir, route.filename)
		case "health":
			return jsonPayload({ status: "ok" })
	}
}

function writePayload(response: ServerResponse, payload: ResponsePayload, headOnly: boolean): void {
	response.writeHead(payload.status, {
		...SECURITY_HEADERS,
		"Content-Type": payload.contentType,
		"Content-Length": payload.body.byteLength.toString(),
		...payload.headers,
	})
	response.end(headOnly ? undefined : payload.body)
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, config: FuzzDashboardServerConfig): Promise<void> {
	let pathname: string
	try {
		pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
	} catch {
		writePayload(response, jsonPayload({ status: "bad_request" }, 400), request.method === "HEAD")
		return
	}

	const route = matchRoute(pathname)
	if (route === undefined) {
		writePayload(response, jsonPayload({ status: "not_found" }, 404), request.method === "HEAD")
		return
	}

	if (request.method !== "GET" && request.method !== "HEAD") {
		writePayload(response, jsonPayload({ status: "method_not_allowed" }, 405, { Allow: "GET, HEAD" }), false)
		return
	}

	try {
		writePayload(response, await payloadForRoute(route, config), request.method === "HEAD")
	} catch {
		if (!response.headersSent) writePayload(response, jsonPayload({ status: "error" }, 500), request.method === "HEAD")
		else response.destroy()
	}
}

function displayHost(host: FuzzDashboardLoopbackHost): string {
	return host.includes(":") ? `[${host}]` : host
}

export async function startFuzzDashboardServer(config: FuzzDashboardServerConfig): Promise<FuzzDashboardServerHandle> {
	validateServerConfig(config)

	const sockets = new Set<Socket>()
	const server = createServer((request, response) => {
		void handleRequest(request, response, config)
	})
	server.on("connection", socket => {
		sockets.add(socket)
		socket.once("close", () => sockets.delete(socket))
	})

	await new Promise<void>((resolveListening, rejectListening) => {
		const onError = (error: Error) => {
			server.off("listening", onListening)
			rejectListening(error)
		}
		const onListening = () => {
			server.off("error", onError)
			resolveListening()
		}
		server.once("error", onError)
		server.once("listening", onListening)
		server.listen(config.port, config.host)
	})

	const address = server.address()
	if (address === null || typeof address === "string") {
		await new Promise<void>(resolveClose => server.close(() => resolveClose()))
		throw new Error("Fuzz dashboard server did not expose a TCP listening address")
	}
	const port = address.port
	let closePromise: Promise<void> | undefined

	return {
		url: `http://${displayHost(config.host)}:${port}`,
		port,
		close() {
			closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
				server.close(error => {
					if (error !== undefined && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error)
					else resolveClose()
				})
				server.closeIdleConnections()
				for (const socket of sockets) socket.destroy()
			})
			return closePromise
		},
	}
}
