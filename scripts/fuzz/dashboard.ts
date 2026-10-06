import { readFile, unlink } from "node:fs/promises"
import process from "node:process"

import { resolveFuzzDashboardServerConfig, startFuzzDashboardServer } from "./FuzzDashboardServer.js"

type FinalReportInspection = { ready: true; status: "passed" | "stopped" | "failed"; warning?: string } | { ready: false; reason: string }

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
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
	const serverConfig = resolveFuzzDashboardServerConfig(process.env, process.cwd())
	const dashboard = await startFuzzDashboardServer(serverConfig)

	try {
		await clearCurrentReport(serverConfig.reportFile)
		process.env.TEST_MODE = "fuzz"
		process.env.FUZZ_RUN_MODE = "continuous"
		process.env.FUZZ_DASHBOARD_FILE = serverConfig.reportFile
		if (serverConfig.archiveDir === undefined) delete process.env.FUZZ_DASHBOARD_ARCHIVE_DIR
		else process.env.FUZZ_DASHBOARD_ARCHIVE_DIR = serverConfig.archiveDir
		process.env.FUZZ_DASHBOARD_URL = dashboard.url

		process.stdout.write(
			[
				"╭─ SYMMIO · FUZZ OBSERVATORY",
				`│ dashboard  ${dashboard.url}`,
				`│ data       ${serverConfig.reportFile}`,
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

		const report = await inspectFinalReport(serverConfig.reportFile)
		if (!report.ready) {
			process.stderr.write(`\nDashboard report unavailable at ${serverConfig.reportFile}: ${report.reason}\n`)
			return
		}
		if (report.warning !== undefined) {
			process.stderr.write(`\nDashboard storage warning: ${report.warning}\n`)
		}
		if (!process.stdin.isTTY || process.env.CI) return

		process.stdout.write(
			`\n${report.status === "failed" || runError !== undefined ? "Failure report ready" : "Final report ready"} at ${dashboard.url}\n` +
				"Review it in the browser, then press Ctrl+C to close the dashboard.\n",
		)
		await waitForDashboardClose(dashboard.close)
	} finally {
		await dashboard.close()
	}
}

main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exitCode = 1
})
