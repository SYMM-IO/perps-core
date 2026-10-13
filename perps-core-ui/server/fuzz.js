import { ROOT } from "./build.js";
import fs from "node:fs/promises";
import path from "node:path";

const SAFE_ARCHIVE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/;
const absent = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const configured = (cwd, value, fallback) => path.resolve(cwd, value?.trim() || fallback);

/** Where a fuzz run persists its report. The runner reads the same variables, so both sides agree on the files. */
export function fuzzPaths(env = process.env, cwd = ROOT) {
	return {
		reportFile: configured(cwd, env.FUZZ_DASHBOARD_FILE, ".fuzz-dashboard/report.json"),
		archiveDir: configured(cwd, env.FUZZ_DASHBOARD_ARCHIVE_DIR, ".fuzz-dashboard/runs"),
	};
}

async function readJson(file, missing, invalid) {
	let content;
	try {
		content = await fs.readFile(file, "utf8");
	} catch (error) {
		if (absent(error)) return missing;
		throw error;
	}
	// The runner rewrites the live report while it runs; a half-written file is a retry, not a failure.
	try {
		return [200, JSON.parse(content)];
	} catch {
		return [503, { status: "error", message: invalid }];
	}
}

/** Read-only access to the live fuzz report and its archive. Each method returns [status, body]. */
export function createFuzzReports({ reportFile, archiveDir } = fuzzPaths()) {
	const notFound = [404, { status: "not_found" }];
	return {
		report: () => readJson(reportFile, [200, { status: "waiting" }], "Live fuzz report is not valid JSON"),
		async runs() {
			let entries;
			try {
				entries = await fs.readdir(archiveDir, { withFileTypes: true });
			} catch (error) {
				if (absent(error)) return [200, { runs: [] }];
				throw error;
			}
			const runs = entries
				.filter(entry => entry.isFile() && SAFE_ARCHIVE_FILENAME.test(entry.name))
				.map(entry => entry.name)
				.sort((left, right) => right.localeCompare(left));
			return [200, { runs }];
		},
		/** `encoded` is the single path segment after /runs/, still percent-encoded. */
		async run(encoded) {
			if (!encoded || encoded.includes("/")) return notFound;
			let filename;
			try {
				filename = decodeURIComponent(encoded);
			} catch {
				return notFound;
			}
			if (!SAFE_ARCHIVE_FILENAME.test(filename)) return notFound;
			const root = path.resolve(archiveDir),
				candidate = path.resolve(root, filename);
			if (path.dirname(candidate) !== root) return notFound;
			try {
				const metadata = await fs.lstat(candidate);
				if (!metadata.isFile() || metadata.isSymbolicLink()) return notFound;
			} catch (error) {
				if (absent(error)) return notFound;
				throw error;
			}
			return readJson(candidate, notFound, "Archived fuzz report is not valid JSON");
		},
	};
}
