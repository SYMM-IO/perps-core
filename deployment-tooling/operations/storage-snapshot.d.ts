export interface StorageSource {
	chainId: number
	address: string
	blockNumber: number
	blockHash: string
	stateRoot: string
	codeHash: string
	storageRoot: string
}
export interface StorageEntry {
	slot: string
	value: string
}
export interface StorageSnapshot {
	schemaVersion: number
	source: StorageSource
	accountProof: string[]
	entries: StorageEntry[]
}
export interface StorageImport {
	schemaVersion: number
	snapshotDigest: string
	source: StorageSource
	root: string
	count: number
	items: (StorageEntry & { index: number; proof: string[] })[]
}
export function verifyStorageAccount(source: StorageSource, accountProof: string[]): Promise<StorageSource>
export function buildStorageSnapshot(source: StorageSource, entries: StorageEntry[], accountProof: string[]): Promise<StorageSnapshot>
export function readStorageSnapshot(
	provider: { send(method: string, args: any[]): Promise<any> },
	checkpoint: Pick<StorageSource, "chainId" | "address" | "blockNumber" | "blockHash">,
	entries: StorageEntry[],
): Promise<StorageSnapshot>
export function storageImportLeaf(index: number, slot: string, value: string): string
export function buildStorageImport(snapshot: StorageSnapshot): Promise<StorageImport>
