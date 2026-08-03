async function main(): Promise<void> {
	process.env.TEST_MODE = "fuzz"
	process.env.FUZZ_RUN_MODE = "continuous"
	const [{ runFuzzSimulation }, { FuzzStopController, installFuzzSignalHandlers }] = await Promise.all([
		import("../test/FuzzRunner.js"),
		import("../test/utils/FuzzRunControl.js"),
	])
	const stop = new FuzzStopController()
	const disposeSignals = installFuzzSignalHandlers(process, stop)
	try {
		await runFuzzSimulation({ runMode: "continuous", stop })
	} finally {
		disposeSignals()
	}
}

main().catch(error => {
	if (process.env.FUZZ_LOG_FORMAT !== "json") {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	}
	process.exitCode = 1
})
