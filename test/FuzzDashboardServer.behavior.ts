import { expect } from "chai"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
	resolveFuzzDashboardServerConfig,
	startFuzzDashboardServer,
	type FuzzDashboardServerConfig,
	type FuzzDashboardServerHandle,
} from "../scripts/fuzz/FuzzDashboardServer.js"

type ServerFixture = {
	root: string
	config: FuzzDashboardServerConfig
	server: FuzzDashboardServerHandle
}

async function createServerFixture(options: { createArchive?: boolean } = {}): Promise<ServerFixture> {
	const root = await mkdtemp(join(tmpdir(), "symmio-fuzz-dashboard-"))
	const assetsDir = join(root, "assets")
	const archiveDir = join(root, "runs")
	await mkdir(assetsDir, { recursive: true })
	if (options.createArchive !== false) await mkdir(archiveDir, { recursive: true })
	await Promise.all([
		writeFile(join(assetsDir, "index.html"), "<!doctype html><title>Fuzz dashboard</title>"),
		writeFile(join(assetsDir, "dashboard.js"), "globalThis.fuzzDashboard = true;\n"),
		writeFile(join(assetsDir, "dashboard.css"), "body { color: white; }\n"),
	])
	const config: FuzzDashboardServerConfig = {
		host: "127.0.0.1",
		port: 0,
		assetsDir,
		reportFile: join(root, "report.json"),
		archiveDir,
	}
	return {
		root,
		config,
		server: await startFuzzDashboardServer(config),
	}
}

async function listenOnPort(port: number): Promise<() => Promise<void>> {
	const server = createServer((_request, response) => response.end("ok"))
	await new Promise<void>((resolveListening, rejectListening) => {
		server.once("error", rejectListening)
		server.listen(port, "127.0.0.1", resolveListening)
	})
	return () => new Promise<void>((resolveClose, rejectClose) => server.close(error => (error ? rejectClose(error) : resolveClose())))
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
		throw new Error("Expected promise to reject")
	} catch (error) {
		return error
	}
}

export function shouldBehaveLikeFuzzDashboardServer(): void {
	const fixtures: ServerFixture[] = []

	afterEach(async function () {
		for (const fixture of fixtures.splice(0)) {
			await fixture.server.close()
			await rm(fixture.root, { recursive: true, force: true })
		}
	})

	describe("configuration", function () {
		it("resolves loopback defaults and dashboard storage relative to cwd", function () {
			const config = resolveFuzzDashboardServerConfig({}, "/workspace/project")

			expect(config).to.deep.equal({
				host: "127.0.0.1",
				port: 4173,
				assetsDir: resolve("/workspace/project", "scripts/fuzz/dashboard"),
				reportFile: resolve("/workspace/project", ".fuzz-dashboard/report.json"),
				archiveDir: resolve("/workspace/project", ".fuzz-dashboard/runs"),
			})
		})

		it("accepts explicit loopback hosts, ports, and report paths", function () {
			const config = resolveFuzzDashboardServerConfig(
				{
					FUZZ_DASHBOARD_HOST: "::1",
					FUZZ_DASHBOARD_PORT: "65535",
					FUZZ_DASHBOARD_FILE: "output/live.json",
					FUZZ_DASHBOARD_ARCHIVE_DIR: "/var/tmp/fuzz-runs",
				},
				"/workspace/project",
			)

			expect(config.host).to.equal("::1")
			expect(config.port).to.equal(65_535)
			expect(config.reportFile).to.equal(resolve("/workspace/project", "output/live.json"))
			expect(config.archiveDir).to.equal("/var/tmp/fuzz-runs")
			expect(resolveFuzzDashboardServerConfig({ FUZZ_DASHBOARD_HOST: "localhost" }).host).to.equal("localhost")
		})

		it("rejects non-loopback hosts and invalid environment ports", function () {
			for (const host of ["0.0.0.0", "192.168.1.10", "example.com"]) {
				expect(() => resolveFuzzDashboardServerConfig({ FUZZ_DASHBOARD_HOST: host })).to.throw("FUZZ_DASHBOARD_HOST must be a loopback host")
			}
			for (const port of ["0", "-1", "1.5", "1e3", "65536", "not-a-port"]) {
				expect(() => resolveFuzzDashboardServerConfig({ FUZZ_DASHBOARD_PORT: port })).to.throw(
					"FUZZ_DASHBOARD_PORT must be an integer between 1 and 65535",
				)
			}
		})

		it("allows an injected ephemeral port but still validates direct server configs", async function () {
			const fixture = await createServerFixture()
			fixtures.push(fixture)
			expect(fixture.server.port).to.be.greaterThan(0)

			const hostError = await rejectionOf(
				startFuzzDashboardServer({
					...fixture.config,
					host: "0.0.0.0" as "127.0.0.1",
				}),
			)
			expect(hostError).to.be.instanceOf(Error)
			expect((hostError as Error).message).to.include("may only bind to a loopback host")

			const portError = await rejectionOf(startFuzzDashboardServer({ ...fixture.config, port: 65_536 }))
			expect(portError).to.be.instanceOf(Error)
			expect((portError as Error).message).to.include("port must be an integer between 0 and 65535")
		})
	})

	describe("HTTP surface", function () {
		it("serves fixed static assets with correct content types and security headers", async function () {
			const fixture = await createServerFixture()
			fixtures.push(fixture)

			const expected = [
				["/", "text/html", "<!doctype html>"],
				["/dashboard.js", "text/javascript", "fuzzDashboard"],
				["/dashboard.css", "text/css", "color: white"],
			] as const
			for (const [pathname, contentType, body] of expected) {
				const response = await fetch(`${fixture.server.url}${pathname}`)
				expect(response.status).to.equal(200)
				expect(response.headers.get("content-type")).to.include(contentType)
				expect(await response.text()).to.include(body)
				expect(response.headers.get("cache-control")).to.include("no-store")
				expect(response.headers.get("content-security-policy")).to.include("default-src 'none'")
				expect(response.headers.get("content-security-policy")).to.include("frame-ancestors 'none'")
				expect(response.headers.get("x-content-type-options")).to.equal("nosniff")
				expect(response.headers.get("referrer-policy")).to.equal("no-referrer")
				expect(response.headers.get("x-frame-options")).to.equal("DENY")
				expect(response.headers.get("cross-origin-resource-policy")).to.equal("same-origin")
				expect(response.headers.get("access-control-allow-origin")).to.equal(null)
			}
		})

		it("returns a waiting response until the explicit live report exists, then serves its JSON", async function () {
			const fixture = await createServerFixture()
			fixtures.push(fixture)

			const waiting = await fetch(`${fixture.server.url}/api/report`)
			expect(waiting.status).to.equal(200)
			expect(waiting.headers.get("content-type")).to.include("application/json")
			expect(await waiting.json()).to.deep.equal({ status: "waiting" })

			await writeFile(fixture.config.reportFile, JSON.stringify({ status: "running", roots: 17, seed: "dashboard-seed" }))
			const live = await fetch(`${fixture.server.url}/api/report`)
			expect(live.status).to.equal(200)
			expect(await live.json()).to.deep.equal({ status: "running", roots: 17, seed: "dashboard-seed" })

			await writeFile(fixture.config.reportFile, "{partial")
			const malformed = await fetch(`${fixture.server.url}/api/report`)
			expect(malformed.status).to.equal(503)
			expect(await malformed.json()).to.deep.equal({ status: "error", message: "Live fuzz report is not valid JSON" })
		})

		it("lists and serves only safe archived JSON reports", async function () {
			const fixture = await createServerFixture()
			fixtures.push(fixture)
			await Promise.all([
				writeFile(join(fixture.config.archiveDir!, "run-001.json"), JSON.stringify({ run: 1 })),
				writeFile(join(fixture.config.archiveDir!, "run-002.json"), JSON.stringify({ run: 2 })),
				writeFile(join(fixture.config.archiveDir!, "notes.txt"), "not a report"),
			])
			await symlink(fixture.config.reportFile, join(fixture.config.archiveDir!, "linked.json"))

			const listing = await fetch(`${fixture.server.url}/api/runs`)
			expect(listing.status).to.equal(200)
			expect(await listing.json()).to.deep.equal({ runs: ["run-002.json", "run-001.json"] })

			const archived = await fetch(`${fixture.server.url}/api/runs/run-001.json`)
			expect(archived.status).to.equal(200)
			expect(await archived.json()).to.deep.equal({ run: 1 })

			for (const pathname of [
				"/api/runs/missing.json",
				"/api/runs/linked.json",
				"/api/runs/%2e%2e%2freport.json",
				"/api/runs/%5c..%5creport.json",
				"/api/runs/bad%20name.json",
				"/api/runs/",
			]) {
				const response = await fetch(`${fixture.server.url}${pathname}`)
				expect(response.status, pathname).to.equal(404)
			}
		})

		it("treats a missing optional archive directory as an empty collection", async function () {
			const fixture = await createServerFixture({ createArchive: false })
			fixtures.push(fixture)

			const listing = await fetch(`${fixture.server.url}/api/runs`)
			expect(listing.status).to.equal(200)
			expect(await listing.json()).to.deep.equal({ runs: [] })
		})

		it("supports HEAD and distinguishes method-not-allowed from unknown routes", async function () {
			const fixture = await createServerFixture()
			fixtures.push(fixture)

			const head = await fetch(`${fixture.server.url}/dashboard.js`, { method: "HEAD" })
			expect(head.status).to.equal(200)
			expect(head.headers.get("content-type")).to.include("text/javascript")
			expect(Number(head.headers.get("content-length"))).to.be.greaterThan(0)
			expect(await head.text()).to.equal("")

			const health = await fetch(`${fixture.server.url}/health`)
			expect(health.status).to.equal(200)
			expect(await health.json()).to.deep.equal({ status: "ok" })

			const method = await fetch(`${fixture.server.url}/api/report`, { method: "POST" })
			expect(method.status).to.equal(405)
			expect(method.headers.get("allow")).to.equal("GET, HEAD")
			expect(await method.json()).to.deep.equal({ status: "method_not_allowed" })

			const missing = await fetch(`${fixture.server.url}/not-allowlisted`)
			expect(missing.status).to.equal(404)
			expect(await missing.json()).to.deep.equal({ status: "not_found" })

			const unknownMethod = await fetch(`${fixture.server.url}/not-allowlisted`, { method: "POST" })
			expect(unknownMethod.status).to.equal(404)
		})

		it("closes idempotently and releases an injected ephemeral port", async function () {
			const fixture = await createServerFixture()
			fixtures.push(fixture)
			expect((await fetch(`${fixture.server.url}/health`)).status).to.equal(200)

			await Promise.all([fixture.server.close(), fixture.server.close()])
			const closeReplacement = await listenOnPort(fixture.server.port)
			await closeReplacement()
		})
	})
}
