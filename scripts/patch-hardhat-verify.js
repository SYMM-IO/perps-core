/**
 * Patches a Map key lookup bug in @nomicfoundation/hardhat-verify's getCompilerInput().
 *
 * Bug: getCompilationJobs() returns a Map with 1 entry, but the key doesn't
 * match the rootFilePath used for .get(), causing .get() to return undefined
 * and triggering HHE100 ("compiler input for the contract source was not found").
 *
 * Fix: fall back to the first (and only) Map value when .get() misses.
 *
 * Run automatically via the "postinstall" script in package.json.
 */
import fs from "fs";
import { fileURLToPath } from "node:url";
import path from "path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const filePath = path.join(projectRoot, "node_modules", "@nomicfoundation", "hardhat-verify", "dist", "src", "internal", "artifacts.js");

const ORIGINAL = "const compilerInput = await compilationJob.get(rootFilePath)?.getSolcInput();";
const PATCHED = "const compilerInput = await (compilationJob.get(rootFilePath) ?? [...compilationJob.values()][0])?.getSolcInput();";
const allowUnpatched = process.env.ALLOW_UNPATCHED_HARDHAT_VERIFY === "true";

function fail(message) {
	if (allowUnpatched) {
		console.warn(`[patch-hardhat-verify] WARNING: ${message}`);
		console.warn("[patch-hardhat-verify] continuing because ALLOW_UNPATCHED_HARDHAT_VERIFY=true");
		process.exit(0);
	}
	console.error(`[patch-hardhat-verify] ERROR: ${message}`);
	console.error(
		"[patch-hardhat-verify] refusing a partially configured install; inspect the plugin or explicitly set ALLOW_UNPATCHED_HARDHAT_VERIFY=true",
	);
	process.exit(1);
}

if (!fs.existsSync(filePath)) {
	fail(`required target not found: ${filePath}`);
}

const content = fs.readFileSync(filePath, "utf-8");

if (content.includes(PATCHED)) {
	console.log("[patch-hardhat-verify] already patched");
	process.exit(0);
}

if (!content.includes(ORIGINAL)) {
	fail("expected source line not found (the plugin version or implementation changed)");
}

const occurrences = content.split(ORIGINAL).length - 1;
if (occurrences !== 1) fail(`expected exactly one patch target, found ${occurrences}`);

fs.writeFileSync(filePath, content.replace(ORIGINAL, PATCHED));
if (!fs.readFileSync(filePath, "utf8").includes(PATCHED)) fail("write completed but patched source could not be verified");
console.log("[patch-hardhat-verify] patched getCompilerInput Map.get() fallback");
