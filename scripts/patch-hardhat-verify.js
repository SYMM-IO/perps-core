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
import fs from "fs"
import path from "path"

const filePath = path.join(
	"node_modules",
	"@nomicfoundation",
	"hardhat-verify",
	"dist",
	"src",
	"internal",
	"artifacts.js",
)

const ORIGINAL = "const compilerInput = await compilationJob.get(rootFilePath)?.getSolcInput();"
const PATCHED = "const compilerInput = await (compilationJob.get(rootFilePath) ?? [...compilationJob.values()][0])?.getSolcInput();"

if (!fs.existsSync(filePath)) {
	console.log("[patch-hardhat-verify] artifacts.js not found, skipping")
	process.exit(0)
}

const content = fs.readFileSync(filePath, "utf-8")

if (content.includes(PATCHED)) {
	console.log("[patch-hardhat-verify] already patched")
	process.exit(0)
}

if (!content.includes(ORIGINAL)) {
	console.log("[patch-hardhat-verify] original line not found (plugin version changed?), skipping")
	process.exit(0)
}

fs.writeFileSync(filePath, content.replace(ORIGINAL, PATCHED))
console.log("[patch-hardhat-verify] patched getCompilerInput Map.get() fallback")
