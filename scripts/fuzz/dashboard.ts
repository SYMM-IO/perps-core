import { fork } from "node:child_process"
import { readFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"

import { fuzzPaths } from "../../perps-core-ui/server/fuzz.js"

type FinalReportInspection = { ready: true; status: "passed" | "stopped" | "failed"; warning?: string } | { ready: false; reason: string }

type DashboardHandle = {
	/** What to open in a browser. Carries the session token when this process started the app. */
	link: string
	origin: string
	/** True when the app was already running and keeps running after this fuzz run. */
	shared: boolean
	close(): Promise<void>
}

const DEFAULT_UI_PORT = 4318
const UI_START_TIMEOUT_MS = 30_000

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function uiPort(env: NodeJS.ProcessEnv): number {
	const raw = env.PERPS_CORE_UI_PORT?.trim()
	if (raw === undefined || raw === "") return DEFAULT_UI_PORT
	const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`PERPS_CORE_UI_PORT must be an integer between 1 and 65535, received ${JSON.stringify(env.PERPS_CORE_UI_PORT)}`)
	}
	return port
}

async function isPerpsCoreUi(origin: string): Promise<boolean> {
	try {
		const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) })
		return response.ok && object(await response.json()).app === "perps-core-ui"
	} catch {
		return false
	}
}

/** Reuses perps-core-ui when it is already open on the port; otherwise starts it for the length of this run. */
async function openDashboard(port: number, env: NodeJS.ProcessEnv): Promise<DashboardHandle> {
	const origin = `http://127.0.0.1:${port}`
	if (await isPerpsCoreUi(origin)) return { link: `${origin}/?view=fuzz`, origin, shared: true, close: async () => {} }

	// Detached, so the first Ctrl+C stops the simulation and leaves the report up to read.
	// The app watches the IPC channel and stops by itself if this process goes away.
	const child = fork(resolve(process.cwd(), "perps-core-ui/server/server.js"), [], {
		env: { ...env, PERPS_CORE_UI_PORT: String(port) },
		detached: true,
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	})
	const started = await new Promise<Record<string, unknown>>((resolveStarted, rejectStarted) => {
		const timer = setTimeout(() => rejectStarted(new Error("perps-core-ui did not start in time")), UI_START_TIMEOUT_MS)
		child.once("message", message => {
			clearTimeout(timer)
			resolveStarted(object(message))
		})
		child.once("error", error => {
			clearTimeout(timer)
			rejectStarted(error)
		})
		child.once("exit", code => {
			clearTimeout(timer)
			rejectStarted(new Error(`perps-core-ui stopped before it was ready (exit code ${code}). Port ${port} may be in use by another program.`))
		})
	})
	const url = String(started.url)
	return {
		link: `${origin}/?view=fuzz${url.slice(url.indexOf("#"))}`,
		origin,
		shared: false,
		close: () =>
			new Promise<void>(resolveClose => {
				if (child.exitCode !== null || child.signalCode !== null) return resolveClose()
				child.once("exit", () => resolveClose())
				child.kill("SIGTERM")
			}),
	}
}

async function clearCurrentReport(file: string): Promise<void> {
	try {
		await unlink(file)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

async function inspectFinalReport(file: string): Promise<FinalReportInspection> {
	let document: Record<string, unknown>
	try {
		document = object(JSON.parse(await readFile(file, "utf8")))
	} catch (error) {
		return {
			ready: false,
			reason: error instanceof Error ? error.message : String(error),
		}
	}

	if (document.kind !== "symmio-fuzz-dashboard") return { ready: false, reason: "the persisted file is not a fuzz dashboard report" }
	const run = object(document.run)
	const status = run.status
	if (status !== "passed" && status !== "stopped" && status !== "failed") {
		return { ready: false, reason: `the persisted run is still ${String(status ?? "initializing")}` }
	}
	const lastWriteError = object(document.retention).lastWriteError
	return {
		ready: true,
		status,
		...(typeof lastWriteError === "string" && lastWriteError !== "" ? { warning: lastWriteError } : {}),
	}
}

async function waitForDashboardClose(close: () => Promise<void>): Promise<void> {
	await new Promise<void>(resolve => {
		let closing = false
		const finish = () => {
			if (closing) return
			closing = true
			process.off("SIGINT", finish)
			process.off("SIGTERM", finish)
			void close().then(resolve, resolve)
		}
		process.once("SIGINT", finish)
		process.once("SIGTERM", finish)
	})
}

async function main(): Promise<void> {
	const customPaths = Boolean(process.env.FUZZ_DASHBOARD_FILE?.trim() || process.env.FUZZ_DASHBOARD_ARCHIVE_DIR?.trim())
	const paths = fuzzPaths(process.env, process.cwd())
	// The app reads the report from the same files this run writes, so both get the resolved paths.
	process.env.FUZZ_DASHBOARD_FILE = paths.reportFile
	process.env.FUZZ_DASHBOARD_ARCHIVE_DIR = paths.archiveDir
	const dashboard = await openDashboard(uiPort(process.env), process.env)

	try {
		await clearCurrentReport(paths.reportFile)
		process.env.TEST_MODE = "fuzz"
		process.env.FUZZ_RUN_MODE = "continuous"
		// This address is stored in the report, so it must not carry the session token.
		process.env.FUZZ_DASHBOARD_URL = `${dashboard.origin}/?view=fuzz`

		process.stdout.write(
			[
				"╭─ SYMMIO · FUZZ OBSERVATORY",
				`│ dashboard  ${dashboard.link}`,
				...(dashboard.shared ? ["│            perps-core-ui is already running: use the tab you have open, Fuzz testing"] : []),
				// An app that was started earlier reads the paths it was started with, not this run's.
				...(dashboard.shared && customPaths
					? ["│            restart it with the same FUZZ_DASHBOARD_FILE / FUZZ_DASHBOARD_ARCHIVE_DIR to see this run"]
					: []),
				`│ data       ${paths.reportFile}`,
				"╰─ live charts start filling as soon as the Hardhat world is ready",
				"",
			].join("\n"),
		)

		const [{ runFuzzSimulation }, { FuzzStopController, installFuzzSignalHandlers }] = await Promise.all([
			import("../../test/FuzzRunner.js"),
			import("../../test/utils/FuzzRunControl.js"),
		])
		const stop = new FuzzStopController()
		const disposeSignals = installFuzzSignalHandlers(process, stop)
		let runError: unknown

		try {
			await runFuzzSimulation({ runMode: "continuous", stop })
		} catch (error) {
			runError = error
			process.exitCode = 1
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
		} finally {
			disposeSignals()
		}

		const report = await inspectFinalReport(paths.reportFile)
		if (!report.ready) {
			process.stderr.write(`\nDashboard report unavailable at ${paths.reportFile}: ${report.reason}\n`)
			return
		}
		if (report.warning !== undefined) {
			process.stderr.write(`\nDashboard storage warning: ${report.warning}\n`)
		}
		if (!process.stdin.isTTY || process.env.CI) return

		const ready = `\n${report.status === "failed" || runError !== undefined ? "Failure report ready" : "Final report ready"} at ${dashboard.link}\n`
		if (dashboard.shared) {
			process.stdout.write(ready)
			return
		}
		process.stdout.write(`${ready}Review it in the browser, then press Ctrl+C to close the dashboard.\n`)
		await waitForDashboardClose(dashboard.close)
	} finally {
		await dashboard.close()
	}
}

main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exitCode = 1
})
