// Immutable local Git source -> isolated, credential-free Docker checks -> evidence.
import { hashSourceTree } from "../deployment-tooling/operations/source-manifest.js";
import { validateDeploymentRecipe } from "../deployment-tooling/recipe.js";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_GROUPS = Object.freeze([
	{ id: "contracts", script: "check:release" },
	{ id: "operations", script: "check:operations" },
	{ id: "fuzz", script: "test:fuzz:ci" },
	{ id: "documentation", script: "docs:check" },
]);
export const EXCLUSION_CANARIES = Object.freeze([
	".git/config",
	".env",
	".env.production",
	".env.local",
	".symmio/tasks/active.json",
	"tasks/data/checkpoints/canary.json",
	"deployment-recipes/canary.json",
	"deployments/canary.json",
	".ledger-handover-cache.json",
	".gasless-layer-ledger-upgrade-cache.json",
	".fuzz-dashboard/canary.json",
	"scripts/upgrade/config/canary.json",
	"scripts/upgrade/output/canary.json",
	"scripts/liquidator/output/canary.json",
	"scripts/output/canary.json",
	"tasks/canary.env",
	"tasks/nested/.env.production",
	"tasks/nested/key.pem",
]);
export function releaseSucceeded(results) {
	return ["image", "image-policy", ...RELEASE_GROUPS.map(group => group.id), "artifacts", "image-metadata", "fuzz-evidence"].every(
		id => results.filter(result => result.id === id).length === 1 && results.find(result => result.id === id).status === "passed",
	);
}

export async function runCandidate(
	commit,
	output,
	{ repository = process.cwd(), timeoutMs = 3600000, seed = "symmio-release-0.8.6", rootActions = 50, execute = spawnSync } = {},
) {
	if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("Candidate must be a full immutable 40-character commit SHA");
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1000 ||
		timeoutMs > 7200000 ||
		!Number.isSafeInteger(rootActions) ||
		rootActions < 1 ||
		rootActions > 10000 ||
		!/^[a-zA-Z0-9._-]{1,100}$/.test(seed)
	)
		throw new Error("Invalid bounded release controls");
	// No deployment, RPC, signing, proxy, keystore or caller npm overrides inherited.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"].includes(key)),
	);
	const probe = execute("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
		cwd: repository,
		env,
		encoding: "utf8",
		timeout: Math.min(timeoutMs, 30000),
		windowsHide: true,
	});
	if (probe.status !== 0 || probe.stdout.trim() !== commit) throw new Error("Candidate commit is unavailable locally");
	const bundle = path.resolve(output);
	fs.mkdirSync(bundle, { recursive: false, mode: 0o700 }); // Preserve prior/failed candidates.
	const source = path.join(bundle, "source");
	fs.mkdirSync(source, { mode: 0o700 });
	const results = [];
	const report = {
		apiVersion: "operations.symm.io/release-candidate-v1",
		commit,
		startedAt: new Date().toISOString(),
		controls: { timeoutMs, seed, rootActions },
		status: "incomplete",
		results,
	};
	const save = () => fs.writeFileSync(path.join(bundle, "result.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	save();
	const command = (id, binary, args, cwd = source, timeout = timeoutMs) => {
		const log = fs.openSync(path.join(bundle, `${id}.log`), "w", 0o600);
		const start = Date.now();
		let execution;
		try {
			execution = execute(binary, args, { cwd, env, stdio: ["ignore", log, log], timeout, windowsHide: true });
		} finally {
			fs.closeSync(log);
		}
		const result = {
			id,
			status: execution.status === 0 && !execution.error ? "passed" : execution.error?.code === "ENOENT" ? "missing" : "failed",
			exitCode: execution.status,
			durationMs: Date.now() - start,
			error: execution.error?.code,
		};
		results.push(result);
		save();
		console.log(`${id}: ${result.status} (${Math.round(result.durationMs / 1000)}s)`);
		return result;
	};
	const image = `symmio-rc:${commit.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
	try {
		if (
			command("archive", "git", ["archive", "--format=tar", `--output=${path.join(bundle, "source.tar")}`, commit], repository).status !==
			"passed"
		)
			return report;
		if (command("extract", "tar", ["-xf", path.join(bundle, "source.tar"), "-C", source]).status !== "passed") return report;
		const fileHash = file =>
			`sha256:${createHash("sha256")
				.update(fs.readFileSync(path.join(source, file)))
				.digest("hex")}`;
		report.inputs = {
			sourceHash: hashSourceTree(source),
			sourceArchiveHash: `sha256:${createHash("sha256")
				.update(fs.readFileSync(path.join(bundle, "source.tar")))
				.digest("hex")}`,
			lockHash: fileHash("package-lock.json"),
			configHash: fileHash("hardhat.config.ts"),
			dockerfileHash: fileHash("Dockerfile"),
			nodeVersion: fs.readFileSync(path.join(source, ".node-version"), "utf8").trim(),
		};
		// Tests read the checked-in public recipes, while the operator image must
		// exclude local recipes. Supply only validated archive inputs, read-only,
		// to check containers; never copy a developer's working recipe directory.
		const recipeMount = [];
		const recipes = path.join(source, "deployment-recipes");
		if (fs.existsSync(recipes)) {
			if (fs.lstatSync(recipes).isSymbolicLink()) throw new Error("Recipe fixtures cannot be symlinks");
			const fixtures = path.join(bundle, "recipe-fixtures");
			// These validated public inputs must be readable by image uid 1000 even
			// when the host CI user has another uid. The enclosing bundle is private.
			fs.mkdirSync(fixtures, { mode: 0o755 });
			report.inputs.recipeFixtures = [];
			for (const name of fs
				.readdirSync(recipes)
				.sort()
				.filter(name => name.endsWith(".json"))) {
				const file = path.join(recipes, name);
				if (!fs.lstatSync(file).isFile()) throw new Error("Recipe fixtures must be regular files");
				const bytes = fs.readFileSync(file);
				validateDeploymentRecipe(JSON.parse(bytes.toString("utf8")), "candidate recipe fixture");
				fs.writeFileSync(path.join(fixtures, name), bytes, { flag: "wx", mode: 0o444 });
				report.inputs.recipeFixtures.push({
					path: `deployment-recipes/${name}`,
					hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
				});
			}
			recipeMount.push("--mount", `type=bind,source=${fixtures},target=/app/symmio/deployment-recipes,readonly`);
		}
		// Synthetic tokens only. A canary cannot overwrite a tracked candidate input.
		for (const name of EXCLUSION_CANARIES) {
			const file = path.join(source, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "SYNTHETIC-RELEASE-EXCLUSION-CANARY", { flag: "wx", mode: 0o600 });
		}
		const built = command("image", "docker", [
			"build",
			"--no-cache",
			"--pull",
			"--build-arg",
			`COMMIT_ID=${commit}`,
			"--build-arg",
			`BUILD_DATE=${report.startedAt}`,
			"--iidfile",
			path.join(bundle, "image-id.txt"),
			"-t",
			image,
			".",
		]);
		if (built.status !== "passed") return report;
		const policy = `const fs=require('fs'),c=require('crypto');if(process.getuid()===0)throw Error('Root image');for(const p of ${JSON.stringify(EXCLUSION_CANARIES)})if(fs.existsSync(p))throw Error('Private context included: '+p);console.log(JSON.stringify({node:process.versions.node,npm:require('/usr/local/lib/node_modules/npm/package.json').version,uid:process.getuid(),lockHash:'sha256:'+c.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'),hardhat:require('./node_modules/hardhat/package.json').version,ethers:JSON.parse(fs.readFileSync('node_modules/ethers/package.json')).version}));if(process.versions.node!==fs.readFileSync('.node-version','utf8').trim())throw Error('Node baseline mismatch');if('sha256:'+c.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex')!==${JSON.stringify(report.inputs.lockHash)})throw Error('Lock mismatch');`;
		if (command("image-policy", "docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", image, "-e", policy]).status === "passed")
			report.toolchain = JSON.parse(fs.readFileSync(path.join(bundle, "image-policy.log"), "utf8").trim());
		for (const group of RELEASE_GROUPS) {
			const name = `symmio-rc-${randomUUID()}`;
			try {
				command(group.id, "docker", [
					"run",
					"--name",
					name,
					"--network",
					"none",
					...recipeMount,
					"-e",
					"DOTENV_CONFIG_PATH=/dev/null",
					"-e",
					"DEPLOY_LOG_LEVEL=silent",
					"-e",
					"PARALLEL_JOBS=4",
					"-e",
					`FUZZ_SEED=${seed}`,
					"-e",
					`FUZZ_ROOT_ACTIONS=${rootActions}`,
					"-e",
					"FUZZ_ACTION_TIMEOUT_MS=60000",
					"-e",
					`FUZZ_RUN_TIMEOUT_MS=${Math.max(1000, timeoutMs - 30000)}`,
					"-e",
					"FUZZ_DRAIN_TIMEOUT_MS=15000",
					"-e",
					"FUZZ_DASHBOARD_FILE=/app/symmio/.fuzz-dashboard/report.json",
					"-e",
					"FUZZ_DASHBOARD_ARCHIVE_DIR=/app/symmio/.fuzz-dashboard/runs",
					"--entrypoint",
					"npm",
					image,
					"run",
					group.script,
				]);
				if (group.id === "fuzz") command("fuzz-evidence", "docker", ["cp", `${name}:/app/symmio/.fuzz-dashboard`, path.join(bundle, "fuzz")]);
			} finally {
				execute("docker", ["rm", "-f", name], { env, stdio: "ignore", timeout: 30000, windowsHide: true });
			}
		}
		const holder = `symmio-rc-artifacts-${randomUUID()}`;
		try {
			if (command("artifact-container", "docker", ["create", "--name", holder, image]).status === "passed") {
				command("artifacts", "docker", ["cp", `${holder}:/app/symmio/artifacts`, path.join(bundle, "artifacts")]);
				const records = [];
				const walk = directory => {
					for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
						const file = path.join(directory, entry.name);
						if (entry.isDirectory()) walk(file);
						else
							records.push({
								path: path.relative(bundle, file).split(path.sep).join("/"),
								hash: `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`,
							});
					}
				};
				if (fs.existsSync(path.join(bundle, "artifacts"))) walk(path.join(bundle, "artifacts"));
				fs.writeFileSync(
					path.join(bundle, "artifact-manifest.json"),
					`${JSON.stringify({ commit, ...report.inputs, files: records }, null, 2)}\n`,
					{ mode: 0o600 },
				);
				command("image-metadata", "docker", ["image", "inspect", image]);
			}
		} finally {
			execute("docker", ["rm", "-f", holder], { env, stdio: "ignore", timeout: 30000, windowsHide: true });
		}
		return report;
	} catch (error) {
		report.error = error.message;
		return report;
	} finally {
		for (const id of ["image", "image-policy", ...RELEASE_GROUPS.map(group => group.id), "artifacts", "image-metadata", "fuzz-evidence"]) {
			if (!results.some(result => result.id === id)) results.push({ id, status: "not_run", reason: "Required prerequisite did not complete" });
		}
		report.status = releaseSucceeded(results) ? "passed" : "incomplete";
		if (results.some(result => result.status === "failed") || report.error) report.status = "failed";
		report.finishedAt = new Date().toISOString();
		save();
		execute("docker", ["image", "rm", image], { env, stdio: "ignore", timeout: 30000, windowsHide: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [commit, output, ...extra] = process.argv.slice(2);
	if (!commit || !output || extra.length)
		throw new Error("Usage: node scripts/release-candidate.mjs <immutable-commit-sha> <new-evidence-directory>");
	const result = await runCandidate(commit, output);
	console.log(`Release candidate ${result.status}`);
	process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
}
