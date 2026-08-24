import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * Storage-layout guard for the upgradeable GaslessLayer proxy.
 *
 * GaslessLayer is UUPS and live: its storage layout is append-only. Changing an EXISTING slot's
 * (slot, offset, label, type) remaps live fee/nonce/quota/sponsor state onto the wrong slot and
 * corrupts funds on the next upgrade — silently, with no test catching it. This module extracts the
 * current layout from Hardhat's build-info and diffs it against a committed snapshot so an
 * accidental mutation blocks the upgrade (see test/GaslessLayerInvariants.behavior.ts and
 * scripts/gaslessLayer/upgrade-gasless-layer.ts). Appends are allowed; the trailing __gap may only shrink.
 *
 * Requires solc storageLayout output — enabled via `outputSelection` in hardhat.config.ts.
 */

const BUILD_INFO_DIR = "artifacts/build-info"
const LAYER_SOURCE_KEY = "project/contracts/gaslessLayer/GaslessLayer.sol"
const LAYER_CONTRACT = "GaslessLayer"
export const STORAGE_SNAPSHOT_PATH = "storage-layout/gaslessLayer/GaslessLayer.json"

export type StorageEntry = {
	slot: number
	offset: number
	label: string
	type: string
	bytes: number
}

export type LayoutDiff = {
	breaking: string[]
	appended: StorageEntry[]
}

type RawStorage = { slot: string; offset: number; label: string; type: string }
type RawLayout = { storage: RawStorage[]; types: Record<string, { label: string; numberOfBytes: string }> }

function findGaslessLayerRawLayout(): RawLayout {
	if (!existsSync(BUILD_INFO_DIR)) {
		throw new Error(`No ${BUILD_INFO_DIR}. Run "npx hardhat compile" first.`)
	}

	const outputs = readdirSync(BUILD_INFO_DIR)
		.filter(file => file.endsWith(".output.json"))
		.map(file => resolve(BUILD_INFO_DIR, file))
		.map(path => ({ path, mtime: statSync(path).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)

	for (const { path } of outputs) {
		const parsed = JSON.parse(readFileSync(path, "utf8"))
		const layout = parsed?.output?.contracts?.[LAYER_SOURCE_KEY]?.[LAYER_CONTRACT]?.storageLayout
		if (layout?.storage) return layout as RawLayout
	}

	throw new Error(
		`No storageLayout for ${LAYER_SOURCE_KEY}:${LAYER_CONTRACT} in ${BUILD_INFO_DIR}. ` +
			`Ensure hardhat.config.ts solidity settings include outputSelection { "*": { "*": ["storageLayout"] } }, then recompile.`,
	)
}

/** The current GaslessLayer storage layout, normalized to human-readable, diff-stable entries. */
export function getGaslessLayerStorageLayout(): StorageEntry[] {
	const layout = findGaslessLayerRawLayout()
	return layout.storage.map(entry => ({
		slot: Number(entry.slot),
		offset: entry.offset,
		label: entry.label,
		type: layout.types[entry.type].label,
		bytes: Number(layout.types[entry.type].numberOfBytes),
	}))
}

export function loadStorageSnapshot(): StorageEntry[] {
	if (!existsSync(STORAGE_SNAPSHOT_PATH)) {
		throw new Error(`Missing storage snapshot at ${STORAGE_SNAPSHOT_PATH}. Generate it with "npm run storage:gasless-layer:snapshot".`)
	}
	return JSON.parse(readFileSync(STORAGE_SNAPSHOT_PATH, "utf8")).storage as StorageEntry[]
}

export function writeStorageSnapshot(): StorageEntry[] {
	const storage = getGaslessLayerStorageLayout()
	const payload = {
		contract: `${LAYER_SOURCE_KEY}:${LAYER_CONTRACT}`,
		note:
			"Committed storage-layout guard for the live UUPS proxy. Existing slots are append-only: never change a " +
			"slot's (slot, offset, label, type); only append new fields and shrink the trailing __gap by the same " +
			"number of slots. Regenerate ONLY for a deliberate, reviewed layout change with `npm run storage:gasless-layer:snapshot`.",
		storage,
	}
	mkdirSync(dirname(STORAGE_SNAPSHOT_PATH), { recursive: true })
	writeFileSync(STORAGE_SNAPSHOT_PATH, `${JSON.stringify(payload, null, 2)}\n`)
	return storage
}

/**
 * Diff a candidate layout against the committed snapshot. Every snapshot slot except the trailing
 * __gap append buffer must be reproduced identically. New fields may be appended into what used to be
 * the __gap, and the __gap may shrink — but the total reserved region (gap start + gap length) must
 * stay constant, which catches the classic "added a field but forgot to shrink __gap" miscount.
 */
export function diffStorageLayout(snapshot: StorageEntry[], current: StorageEntry[]): LayoutDiff {
	const breaking: string[] = []
	const key = (entry: StorageEntry) => `${entry.slot}:${entry.offset}`
	const currentByKey = new Map(current.map(entry => [key(entry), entry]))

	const snapGapIndex = snapshot.length > 0 && snapshot[snapshot.length - 1].label === "__gap" ? snapshot.length - 1 : -1

	snapshot.forEach((entry, index) => {
		if (index === snapGapIndex) return
		const match = currentByKey.get(key(entry))
		if (!match) {
			breaking.push(`slot ${entry.slot} (offset ${entry.offset}) "${entry.label}" (${entry.type}) was removed or moved`)
			return
		}
		if (match.label !== entry.label || match.type !== entry.type || match.bytes !== entry.bytes) {
			breaking.push(`slot ${entry.slot} (offset ${entry.offset}) changed: was "${entry.label}" (${entry.type}), now "${match.label}" (${match.type})`)
		}
	})

	let appended: StorageEntry[] = []
	if (snapGapIndex >= 0) {
		const snapGap = snapshot[snapGapIndex]
		const snapReservedEnd = snapGap.slot + snapGap.bytes / 32
		appended = current.filter(entry => entry.slot >= snapGap.slot && entry.label !== "__gap")

		const currentGap = current.length > 0 && current[current.length - 1].label === "__gap" ? current[current.length - 1] : undefined
		if (!currentGap) {
			breaking.push(`trailing __gap append buffer was removed (was uint256[${snapGap.bytes / 32}] at slot ${snapGap.slot})`)
		} else {
			const currentReservedEnd = currentGap.slot + currentGap.bytes / 32
			if (currentReservedEnd !== snapReservedEnd) {
				breaking.push(
					`trailing __gap reserved region changed (was through slot ${snapReservedEnd}, now ${currentReservedEnd}); ` +
						`each appended field must be matched by an equal shrink of __gap so the total reserved slots stay constant`,
				)
			}
		}
	}

	return { breaking, appended }
}

/** Throws if the current layout breaks append-only compatibility with the committed snapshot. */
export function assertGaslessLayerStorageLayoutStable(): LayoutDiff {
	const diff = diffStorageLayout(loadStorageSnapshot(), getGaslessLayerStorageLayout())
	if (diff.breaking.length > 0) {
		throw new Error(
			"GaslessLayer storage layout is NOT append-only vs the committed snapshot — upgrading would corrupt live state:\n" +
				diff.breaking.map(line => `  - ${line}`).join("\n") +
				`\n\nIf this change is intentional and reviewed, regenerate the snapshot with "npm run storage:gasless-layer:snapshot".`,
		)
	}
	return diff
}
