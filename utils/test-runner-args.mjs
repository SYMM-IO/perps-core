export function parseTestRunnerArguments(args, environmentJobs) {
	const hasWorkerArgument = args[0] !== undefined && /^[0-9]+$/.test(args[0]);
	const raw = hasWorkerArgument ? args[0] : (environmentJobs ?? "8");
	if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 64) {
		throw new Error(`parallel jobs must be an integer between 1 and 64; received "${raw}"`);
	}
	return { jobs: Number(raw), extraArgs: hasWorkerArgument ? args.slice(1) : [...args] };
}
