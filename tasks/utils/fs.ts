import fs, { writeFileSync } from "fs"
import { dirname } from "path"

const BASE_PATH = "./tasks/data"

// Deployment records used to be written to a single unscoped path per contract type
// (tasks/data/deployed.json, instantlayer.json, ...) and APPENDED to on every run. Deploy
// to localhost and then to Arbitrum and both addresses ended up in the same file, so
// `verify:all --network arbitrum` would try to verify a localhost address on Arbiscan.
// Checkpoints were already chainId-scoped; these now are too.
let dataScope: string | null = null

/** Scope all subsequent readData/writeData calls to a chain. Call once per task run. */
export function setDataScope(chainId: number | bigint, options: { simulated?: boolean } = {}): void {
	// A forked network reports its upstream chainId — fork-arbitrum is 42161 — so without
	// this suffix a rehearsal writes its throwaway addresses into the same directory a real
	// Arbitrum deployment uses, and `verify:all --network arbitrum` would then submit fork
	// addresses to Arbiscan. Keep simulated runs in their own scope.
	dataScope = options.simulated ? `${Number(chainId)}-fork` : String(Number(chainId))
}

export function getDataDir(): string {
	return dataScope ? `${BASE_PATH}/${dataScope}` : BASE_PATH
}

function scopedPath(relativePath: string): string {
	return `${getDataDir()}/${relativePath}`
}

export function readData(fileName: string): any {
	const dir = getDataDir()
	createDirectory(dir)

	const scoped = scopedPath(fileName)
	if (fs.existsSync(scoped)) {
		return JSON.parse(fs.readFileSync(scoped, "utf8"))
	}

	// Fall back to the legacy unscoped location so existing deployment records stay
	// readable. Nothing is written back there — the next write lands in the scoped path.
	const legacy = `${BASE_PATH}/${fileName}`
	if (dataScope && fs.existsSync(legacy)) {
		return JSON.parse(fs.readFileSync(legacy, "utf8"))
	}

	return JSON.parse(fs.readFileSync(scoped, "utf8"))
}

export function writeData(relativePath: string, data: object): void {
	const target = scopedPath(relativePath)
	createDirectory(dirname(target))
	writeFileSync(target, JSON.stringify(data, null, 2))
}

export function createDirectory(path: string): void {
	if (!fs.existsSync(path)) {
		fs.mkdirSync(path, { recursive: true })
	}
}
