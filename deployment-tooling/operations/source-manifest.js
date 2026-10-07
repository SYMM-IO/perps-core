import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Shared recovery input policy. Mutable recipes, journals and generated outputs
// intentionally do not participate in a deployment source fingerprint.
export const SOURCE_PATHS = Object.freeze([
	"cli",
	"contracts",
	"deployment",
	"deployment-tooling",
	"scripts",
	"tasks",
	"utils",
	"hardhat.config.ts",
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.operations.json",
	"Dockerfile",
	".dockerignore",
	".node-version",
]);
const mutablePaths = ["tasks/data", "scripts/output", "scripts/upgrade/output", "scripts/upgrade/config", "scripts/liquidator/output"];

export function hashSourceTree(root, entries = SOURCE_PATHS, { requireEntries = false } = {}) {
	const files = new Set();
	const visit = entry => {
		const relative = path.relative(root, entry).split(path.sep).join("/");
		if (mutablePaths.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))) return;
		if (!fs.existsSync(entry)) {
			if (requireEntries) throw new Error(`Deployment manifest source is missing: ${relative}`);
			return;
		}
		const stat = fs.lstatSync(entry);
		if (stat.isSymbolicLink()) throw new Error(`Manifest source must not be a symlink: ${relative}`);
		if (stat.isDirectory()) for (const child of fs.readdirSync(entry).sort()) visit(path.join(entry, child));
		else if (stat.isFile()) files.add(relative);
	};
	for (const entry of entries) {
		const target = path.resolve(root, entry);
		if (path.relative(root, target).startsWith("..") || path.isAbsolute(path.relative(root, target)))
			throw new Error("Manifest path escapes source root");
		visit(target);
	}
	const hash = createHash("sha256");
	for (const file of [...files].sort())
		hash.update(file)
			.update("\0")
			.update(fs.readFileSync(path.join(root, file)))
			.update("\0");
	return `sha256:${hash.digest("hex")}`;
}
