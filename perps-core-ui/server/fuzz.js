import { ROOT } from "./build.js";
import fs from "node:fs/promises";
import path from "node:path";

const SAFE_ARCHIVE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/;
const absent = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const configured = (cwd, value, fallback) => path.resolve(cwd, value?.trim() || fallback);
const etagOf = metadata => `"${metadata.mtimeNs.toString(36)}-${metadata.size.toString(36)}"`;

/** Where a fuzz run persists its report. The runner reads the same variables, so both sides agree on the files. */
export function fuzzPaths(env = process.env, cwd = ROOT) {
	return {
		reportFile: configured(cwd, env.FUZZ_DASHBOARD_FILE, ".fuzz-dashboard/report.json"),
		archiveDir: configured(cwd, env.FUZZ_DASHBOARD_ARCHIVE_DIR, ".fuzz-dashboard/runs"),
	};
}

/**
 * Reads a report as [status, body, headers]. The ETag comes from the same open file as the content, so a
 * report replaced between the two reads cannot pair new content with an old tag. A matching tag is a 304.
 */
async function readJson(file, missing, invalid, ifNoneMatch) {
	let handle;
	try {
		handle = await fs.open(file, "r");
	} catch (error) {
		if (absent(error)) return missing;
		throw error;
	}
	let content, etag;
	try {
		etag = etagOf(await handle.stat({ bigint: true }));
		if (ifNoneMatch && ifNoneMatch === etag) return [304, null, { ETag: etag }];
		content = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
	// The runner rewrites the live report while it runs; a half-written file is a retry, not a failure.
	try {
		return [200, JSON.parse(content), { ETag: etag }];
	} catch {
		return [503, { status: "error", message: invalid }];
	}
}

const shortText = (value, limit) => (typeof value === "string" ? (value.length > limit ? `${value.slice(0, limit - 1)}…` : value) : undefined);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The few fields the run picker shows. Anything missing or malformed is left out rather than guessed. */
export function archiveSummary(name, report) {
	const run = report?.run ?? {};
	const failures = Array.isArray(run.failures) ? run.failures.length : undefined;
	const summary = {
		name,
		status: shortText(run.status, 32),
		seed: shortText(run.seed, 64),
		startedAt: shortText(run.startedAt, 40),
		finishedAt: shortText(run.finishedAt, 40),
		cycles: finite(report?.latest?.root?.completed) ?? finite(report?.counters?.roots?.completed),
		failures,
	};
	return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

/** Read-only access to the live fuzz report and its archive. Each method returns [status, body, headers?]. */
export function createFuzzReports({ reportFile, archiveDir } = fuzzPaths()) {
	const notFound = [404, { status: "not_found" }];
	// Archives are written once, so a summary stays valid until the file's mtime or size changes.
	const summaries = new Map();
	async function summarize(name) {
		const file = path.join(archiveDir, name);
		let metadata;
		try {
			metadata = await fs.stat(file);
		} catch (error) {
			if (absent(error)) return { name };
			throw error;
		}
		const key = `${metadata.mtimeMs}:${metadata.size}`;
		const cached = summaries.get(name);
		if (cached?.key === key) return cached.summary;
		let summary;
		try {
			summary = archiveSummary(name, JSON.parse(await fs.readFile(file, "utf8")));
		} catch (error) {
			if (absent(error)) return { name };
			summary = { name };
		}
		summaries.set(name, { key, summary });
		return summary;
	}
	return {
		report: ({ ifNoneMatch } = {}) => readJson(reportFile, [200, { status: "waiting" }], "Live fuzz report is not valid JSON", ifNoneMatch),
		async runs() {
			let entries;
			try {
				entries = await fs.readdir(archiveDir, { withFileTypes: true });
			} catch (error) {
				if (absent(error)) return [200, { runs: [] }];
				throw error;
			}
			const names = entries
				.filter(entry => entry.isFile() && SAFE_ARCHIVE_FILENAME.test(entry.name))
				.map(entry => entry.name)
				.sort((left, right) => right.localeCompare(left));
			for (const name of summaries.keys()) if (!names.includes(name)) summaries.delete(name);
			return [200, { runs: await Promise.all(names.map(summarize)) }];
		},
		/** `encoded` is the single path segment after /runs/, still percent-encoded. */
		async run(encoded, { ifNoneMatch } = {}) {
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
			return readJson(candidate, notFound, "Archived fuzz report is not valid JSON", ifNoneMatch);
		},
	};
}
