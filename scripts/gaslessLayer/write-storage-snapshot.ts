import { STORAGE_SNAPSHOT_PATH, writeStorageSnapshot } from "./storage-layout.js"

/**
 * Regenerate the committed GaslessLayer storage-layout snapshot.
 * Run via `npm run storage:gasless-layer:snapshot` only for a deliberate, reviewed layout change.
 */
const storage = writeStorageSnapshot()
console.log(`Wrote ${storage.length} storage entries to ${STORAGE_SNAPSHOT_PATH}`)
