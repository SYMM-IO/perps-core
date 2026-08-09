import fs from "fs"
import { basename, dirname, join } from "path"

const BASE_PATH = "./tasks/data"

// Deployment records used to be written to a single unscoped path per contract type
// (tasks/data/deployed.json, instantlayer.json, ...) and APPENDED to on every run. Deploy
// to localhost and then to Arbitrum and both addresses ended up in the same file, so
// `verify:all --network arbitrum` would try to verify a localhost address on Arbiscan.
// Checkpoints were already chainId-scoped; these now are too.
let dataScope: string | null = null
let simulatedDataScope = false

/** Scope all subsequent readData/writeData calls to a chain. Call once per task run. */
export function setDataScope(chainId: number | bigint, options: { simulated?: boolean } = {}): void {
	// A forked network reports its upstream chainId — fork-arbitrum is 42161 — so without
	// this suffix a rehearsal writes its throwaway addresses into the same directory a real
	// Arbitrum deployment uses, and `verify:all --network arbitrum` would then submit fork
	// addresses to Arbiscan. Keep simulated runs in their own scope.
	simulatedDataScope = options.simulated === true
	dataScope = simulatedDataScope ? `${Number(chainId)}-fork` : String(Number(chainId))
}

/** Restore the legacy unscoped path after an isolated in-process test. */
export function resetDataScope(): void {
	dataScope = null
	simulatedDataScope = false
}

export function getDataDir(): string {
	return dataScope ? `${BASE_PATH}/${dataScope}` : BASE_PATH
}

function scopedPath(relativePath: string): string {
	return `${getDataDir()}/${relativePath}`
}

export function readData(fileName: string): any {
	const existing = resolveReadablePath(fileName)
	if (existing) return readJson(existing)
	throw new Error(`Deployment data file not found: ${scopedPath(fileName)}`)
}

/** Return null only when a record does not exist. Malformed recovery data still throws. */
export function readDataIfExists(fileName: string): any | null {
	const existing = resolveReadablePath(fileName)
	return existing ? readJson(existing) : null
}

export function writeData(relativePath: string, data: object): void {
	const target = scopedPath(relativePath)
	createDirectory(dirname(target))
	atomicWriteFile(target, `${JSON.stringify(data, null, 2)}\n`)
}

/**
 * Replace verification records for the same contract name/address while preserving the
 * unrelated entries that share a deployment file. This makes record repair idempotent on
 * checkpoint resume instead of appending duplicates on every attempt.
 */
export function upsertDeploymentRecords(relativePath: string, records: Array<{ name: string; address: string; constructorArguments: any[] }>): void {
	const existing = readDataIfExists(relativePath) ?? []
	if (!Array.isArray(existing)) throw new Error(`Deployment data ${relativePath} must contain a JSON array`)
	const names = new Set(records.map(record => record.name))
	const addresses = new Set(records.map(record => record.address.toLowerCase()))
	const preserved = existing.filter((record: any) => {
		if (!record || typeof record !== "object") return true
		return !names.has(record.name) && !(typeof record.address === "string" && addresses.has(record.address.toLowerCase()))
	})
	writeData(relativePath, [...preserved, ...records])
}

/**
 * Replace a file atomically in its own directory.
 *
 * Deployment records and checkpoints are recovery data. A process crash during a direct
 * write must not leave half a JSON document that destroys the only record of deployed
 * addresses. Writing, fsyncing, and then renaming a sibling temporary file gives readers
 * either the previous complete file or the new complete file.
 */
export function atomicWriteFile(target: string, contents: string, mode = 0o644): void {
	const dir = dirname(target)
	createDirectory(dir)
	const temp = join(dir, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`)
	let fd: number | undefined
	try {
		fd = fs.openSync(temp, "wx", mode)
		fs.writeFileSync(fd, contents, "utf8")
		fs.fsyncSync(fd)
		fs.closeSync(fd)
		fd = undefined
		fs.renameSync(temp, target)
		// Persist the directory entry where the platform permits it. Some filesystems reject
		// opening directories; the data file is still atomically replaced in that case.
		try {
			const dirFd = fs.openSync(dir, "r")
			try {
				fs.fsyncSync(dirFd)
			} finally {
				fs.closeSync(dirFd)
			}
		} catch {
			// Best effort only; rename already completed atomically.
		}
	} catch (error) {
		if (fd !== undefined) fs.closeSync(fd)
		if (fs.existsSync(temp)) fs.unlinkSync(temp)
		throw error
	}
}

function readJson(filePath: string): any {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch (error) {
		throw new Error(`Failed to read deployment data ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function resolveReadablePath(fileName: string): string | null {
	const scoped = scopedPath(fileName)
	if (fs.existsSync(scoped)) return scoped

	// A simulated fork must never consume a legacy live-chain record. For live scopes,
	// retain the one-way migration path: old records are readable, new writes are scoped.
	const legacy = `${BASE_PATH}/${fileName}`
	if (dataScope && !simulatedDataScope && fs.existsSync(legacy)) return legacy
	return null
}

export function createDirectory(path: string): void {
	if (!fs.existsSync(path)) {
		fs.mkdirSync(path, { recursive: true })
	}
}
