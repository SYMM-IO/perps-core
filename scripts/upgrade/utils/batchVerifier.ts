/**
 * Verify generated upgrade/migrate calldata against the local repo.
 *
 * For each generated JSON under scripts/upgrade/output/, reconstructs the
 * expected calldata using the same builders the generators use, then
 * byte-compares every transaction's `data`, `to`, and `value` against the
 * on-disk file. Any mismatch is reported with the specific tx index, method,
 * and the differing fields.
 *
 * Used by scripts/upgrade/verifyBatchCalldata.ts.
 */
import fs from "fs"
import path from "path"

import { FacetNames } from "../../../tasks/deploy/constants.js"
import { getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers } from "../../../test/helpers/hardhat-connection.js"
import { MUON_FUNCTION_NAMES, validateMuonVerifierConfig } from "./muonVerifierConfig.js"
import {
	buildSymbolManagerWiringTransactions,
	buildTemplateTransactions,
	buildWiringTransactions,
	filterUnregisteredPartyBs,
} from "./peripheralHelpers.js"
import {
	buildUpgradeTransactions,
	FacetLibraryDependencies,
	LibraryLinkReferences,
	type NewV085Parameters,
	type SafeTransaction,
	toHumanReadableSafeTxFromIface,
} from "./upgradeHelpers.js"

// ============================================================================
// Types
// ============================================================================

export type FileCheck = {
	file: string
	label: string
	ok: boolean
	issues: string[]
	skipped?: boolean
	skipReason?: string
}

export type VerifyContextInputs = {
	networkName: string
	outputDir: string
	configDir: string
	// Optional overrides: if set, use these file paths instead of default {outputDir}/{name}-{network}.json
	paths?: Partial<{
		pauseSafeBatch: string
		safeBatch: string
		diamondCutCalldata: string
		timelockScheduleDir: string // directory containing timelock-schedule-safe-batch-{network}-N.json
		timelockExecuteDir: string
		postMigrationSafeBatch: string
		postMigrationTransactions: string
		grantSymbolRoleSafeBatch: string
		revokeSymbolRoleSafeBatch: string
		addTemplatesSafeBatch: string
		deployedFacets: string
		deployedPeripherals: string
		upgradeConfig: string
		partyBListConfig: string
		instantLayerTemplatesConfig: string
	}>
	// Optional cross-check toggle: verify each facet's selectors in
	// deployed-facets-{network}.json match the locally compiled facet ABI.
	verifyFacetSelectorsAgainstArtifacts?: boolean
	// Optional optimization: checks that do not need generator-equivalent PartyB
	// registration filtering can avoid on-chain reads.
	skipPartyBStateFilter?: boolean
}

export type LoadedContext = {
	networkName: string
	outputDir: string
	// Config
	diamondAddress: string
	protocolAdmin: string
	safeAddress: string
	migrationRunner: string
	timelockAddress?: string
	symmioFeeReceiver?: string
	diamondCutChunkSize: number
	setupInstantLayerTemplates: boolean
	newParams: NewV085Parameters
	partyBsToRegister: string[]
	registerOnSymmioCore: boolean
	registerOnInstantLayer: boolean
	partyBsForDiamond: string[]
	partyBsForInstantLayer: string[]
	templates: unknown[]
	// Deploy outputs
	accountLayerAddress?: string
	instantLayerAddress?: string
	symbolManagerAddress?: string
	signatureVerifierAddress?: string
	deployedFacets: Record<string, { address: string; selectors: string[] }>
	selectorSignatures: Record<string, string>
	// Resolved file paths
	files: {
		pauseSafeBatch: string
		safeBatch: string
		diamondCutCalldata: string
		timelockSchedule: string[]
		timelockExecute: string[]
		postMigrationSafeBatch: string
		postMigrationTransactions: string
		grantSymbolRoleSafeBatch: string
		revokeSymbolRoleSafeBatch: string
		addTemplatesSafeBatch: string
	}
}

// ============================================================================
// File helpers
// ============================================================================

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf-8")) as T
}

function tryReadJson<T>(file: string): T | null {
	if (!fs.existsSync(file)) return null
	try {
		return readJson<T>(file)
	} catch {
		return null
	}
}

function eqAddr(a: string, b: string): boolean {
	try {
		return ethers.getAddress(a) === ethers.getAddress(b)
	} catch {
		return a.toLowerCase() === b.toLowerCase()
	}
}

function eqBytes(a: string, b: string): boolean {
	return (a ?? "").toLowerCase() === (b ?? "").toLowerCase()
}

// ============================================================================
// Load context (config + deploy outputs)
// ============================================================================

type UpgradeConfig = {
	diamondAddress?: string
	protocolAdmin?: string
	adminAddress?: string // legacy alias
	safeAddress?: string
	migrationRunner?: string
	timelockAddress?: string
	symmioFeeReceiver?: string
	diamondCutChunkSize?: number
	setupInstantLayerTemplates?: boolean
	accountLayerDiamondAddress?: string
	instantLayerAddress?: string
	symbolManagerAddress?: string
	newV085Parameters?: NewV085Parameters
}

type PartyBListConfig = {
	partyBs?: Record<string, string[]>
	registerOnSymmioCore?: boolean
	registerOnInstantLayer?: boolean
}

type TemplatesConfig = {
	templates: { name: string; operations: { insertionPoints: number[]; sourceIndices: number[]; sourceOffsets: number[] }[] }[]
}

type DeployedPeripherals = {
	accountLayer?: { diamond?: string }
	instantLayer?: { address?: string }
	symbolManager?: { address?: string }
	signatureVerifier?: string
}

type DeployedFacets = {
	facets: Record<string, { address: string; selectors: string[] }>
	selectorSignatures: Record<string, string>
}

export async function loadVerifyContext(inputs: VerifyContextInputs): Promise<LoadedContext> {
	const { networkName, outputDir, configDir, paths = {} } = inputs

	const upgradeFile = paths.upgradeConfig ?? resolveNetworkConfigFile(configDir, "upgrade", networkName)
	const partyBListFile = paths.partyBListConfig ?? resolveNetworkConfigFile(configDir, "partyBList", networkName)
	const templatesFile = paths.instantLayerTemplatesConfig ?? path.join(configDir, "instantLayerTemplates.json")
	const deployedFacetsFile = paths.deployedFacets ?? path.join(outputDir, `deployed-facets-${networkName}.json`)
	const deployedPeripheralsFile = paths.deployedPeripherals ?? path.join(outputDir, `deployed-peripherals-${networkName}.json`)

	const upgradeConfig = tryReadJson<UpgradeConfig>(upgradeFile) ?? {}
	const partyBListConfig = tryReadJson<PartyBListConfig>(partyBListFile) ?? {}
	const templatesConfig = tryReadJson<TemplatesConfig>(templatesFile) ?? { templates: [] }
	const deployedPeripherals = tryReadJson<DeployedPeripherals>(deployedPeripheralsFile) ?? {}
	const deployedFacetsJson = tryReadJson<DeployedFacets>(deployedFacetsFile)

	if (!deployedFacetsJson) {
		throw new Error(`Deployed facets file not found: ${deployedFacetsFile}`)
	}

	const protocolAdmin = (upgradeConfig.protocolAdmin ?? upgradeConfig.adminAddress ?? "").trim()
	const diamondAddress = (upgradeConfig.diamondAddress ?? "").trim()
	const safeAddress = (upgradeConfig.safeAddress ?? "").trim()
	const migrationRunner = (upgradeConfig.migrationRunner ?? protocolAdmin).trim()

	if (!ethers.isAddress(diamondAddress)) throw new Error(`Invalid diamondAddress in ${upgradeFile}: ${diamondAddress}`)
	if (!ethers.isAddress(protocolAdmin)) throw new Error(`Invalid protocolAdmin/adminAddress in ${upgradeFile}`)
	if (safeAddress && !ethers.isAddress(safeAddress)) throw new Error(`Invalid safeAddress in ${upgradeFile}`)
	if (!ethers.isAddress(migrationRunner)) throw new Error(`Invalid migrationRunner in ${upgradeFile}`)

	const accountLayerAddress = upgradeConfig.accountLayerDiamondAddress ?? deployedPeripherals.accountLayer?.diamond
	const instantLayerAddress = upgradeConfig.instantLayerAddress ?? deployedPeripherals.instantLayer?.address
	const symbolManagerAddress = upgradeConfig.symbolManagerAddress ?? deployedPeripherals.symbolManager?.address
	const signatureVerifierAddress = upgradeConfig.newV085Parameters?.signatureVerifierAddress ?? deployedPeripherals.signatureVerifier

	// Load full partyB list; per-target gates (registerOnSymmioCore,
	// registerOnInstantLayer) default to true when the list file exists.
	const partyBsToRegister: string[] = Object.values(partyBListConfig.partyBs ?? {})
		.flat()
		.filter(a => ethers.isAddress(a))
		.map(a => ethers.getAddress(a))
	const registerOnSymmioCore: boolean = partyBListConfig.registerOnSymmioCore !== false
	const registerOnInstantLayer: boolean = partyBListConfig.registerOnInstantLayer !== false

	// Mirror the generator's pre-filter: compute which PartyBs actually need
	// registration against current on-chain state. Verifier and generator must
	// agree; if one filters and the other doesn't, byte-compare drifts.
	let partyBsForDiamond: string[] = []
	let partyBsForInstantLayer: string[] = []
	if (partyBsToRegister.length > 0 && !inputs.skipPartyBStateFilter) {
		const filtered = await filterUnregisteredPartyBs(
			ethers.provider,
			ethers.getAddress(diamondAddress),
			instantLayerAddress && ethers.isAddress(instantLayerAddress) ? ethers.getAddress(instantLayerAddress) : undefined,
			partyBsToRegister,
			{ registerOnSymmioCore, registerOnInstantLayer },
		)
		partyBsForDiamond = filtered.partyBsForDiamond
		partyBsForInstantLayer = filtered.partyBsForInstantLayer
	}

	// Resolve file paths (network-qualified defaults, override via paths)
	const files = {
		pauseSafeBatch: paths.pauseSafeBatch ?? path.join(outputDir, `pause-safe-batch-${networkName}.json`),
		safeBatch: paths.safeBatch ?? path.join(outputDir, `safe-batch-${networkName}.json`),
		diamondCutCalldata: paths.diamondCutCalldata ?? path.join(outputDir, `diamondcut-calldata-${networkName}.json`),
		timelockSchedule: collectChunked(paths.timelockScheduleDir ?? outputDir, `timelock-schedule-safe-batch-${networkName}`),
		timelockExecute: collectChunked(paths.timelockExecuteDir ?? outputDir, `timelock-execute-safe-batch-${networkName}`),
		postMigrationSafeBatch: paths.postMigrationSafeBatch ?? path.join(outputDir, `post-migration-safe-batch-${networkName}.json`),
		postMigrationTransactions: paths.postMigrationTransactions ?? path.join(outputDir, `post-migration-transactions-${networkName}.json`),
		grantSymbolRoleSafeBatch: paths.grantSymbolRoleSafeBatch ?? path.join(outputDir, `grant-symbol-role-safe-batch-${networkName}.json`),
		revokeSymbolRoleSafeBatch: paths.revokeSymbolRoleSafeBatch ?? path.join(outputDir, `revoke-symbol-role-safe-batch-${networkName}.json`),
		addTemplatesSafeBatch: paths.addTemplatesSafeBatch ?? path.join(outputDir, `add-templates-safe-batch-${networkName}.json`),
	}

	return {
		networkName,
		outputDir,
		diamondAddress: ethers.getAddress(diamondAddress),
		protocolAdmin: ethers.getAddress(protocolAdmin),
		safeAddress: safeAddress ? ethers.getAddress(safeAddress) : "",
		migrationRunner: ethers.getAddress(migrationRunner),
		timelockAddress:
			upgradeConfig.timelockAddress && ethers.isAddress(upgradeConfig.timelockAddress) ? ethers.getAddress(upgradeConfig.timelockAddress) : undefined,
		symmioFeeReceiver: upgradeConfig.symmioFeeReceiver,
		diamondCutChunkSize: Number(upgradeConfig.diamondCutChunkSize ?? 6),
		setupInstantLayerTemplates: upgradeConfig.setupInstantLayerTemplates !== false,
		newParams: upgradeConfig.newV085Parameters ?? {},
		partyBsToRegister,
		registerOnSymmioCore,
		registerOnInstantLayer,
		partyBsForDiamond,
		partyBsForInstantLayer,
		templates: templatesConfig.templates ?? [],
		accountLayerAddress: accountLayerAddress && ethers.isAddress(accountLayerAddress) ? ethers.getAddress(accountLayerAddress) : undefined,
		instantLayerAddress: instantLayerAddress && ethers.isAddress(instantLayerAddress) ? ethers.getAddress(instantLayerAddress) : undefined,
		symbolManagerAddress: symbolManagerAddress && ethers.isAddress(symbolManagerAddress) ? ethers.getAddress(symbolManagerAddress) : undefined,
		signatureVerifierAddress:
			signatureVerifierAddress && ethers.isAddress(signatureVerifierAddress) ? ethers.getAddress(signatureVerifierAddress) : undefined,
		deployedFacets: deployedFacetsJson.facets,
		selectorSignatures: deployedFacetsJson.selectorSignatures ?? {},
		files,
	}
}

function resolveNetworkConfigFile(configDir: string, baseName: string, networkName: string): string {
	const networkSpecific = path.join(configDir, `${baseName}-${networkName}.json`)
	if (fs.existsSync(networkSpecific)) return networkSpecific
	return path.join(configDir, `${baseName}.json`)
}

function collectChunked(dir: string, prefix: string): string[] {
	if (!fs.existsSync(dir)) return []
	const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-(\\d+))?\\.json$`)
	return fs
		.readdirSync(dir)
		.filter(f => regex.test(f))
		.sort()
		.map(f => path.join(dir, f))
}

// ============================================================================
// Common tx-list compare helpers
// ============================================================================

type TxLike = { to: string; value?: string; data: string }

function compareTxLists(label: string, expected: TxLike[], actual: TxLike[], issues: string[]): void {
	if (expected.length !== actual.length) {
		issues.push(`${label}: transaction count mismatch — expected ${expected.length}, got ${actual.length}`)
	}
	const min = Math.min(expected.length, actual.length)
	for (let i = 0; i < min; i++) {
		const e = expected[i]
		const a = actual[i]
		if (!eqAddr(e.to, a.to)) {
			issues.push(`${label} tx[${i}]: to mismatch — expected ${e.to}, got ${a.to}`)
		}
		const eVal = e.value ?? "0"
		const aVal = a.value ?? "0"
		if (BigInt(eVal) !== BigInt(aVal)) {
			issues.push(`${label} tx[${i}]: value mismatch — expected ${eVal}, got ${aVal}`)
		}
		if (!eqBytes(e.data, a.data)) {
			issues.push(`${label} tx[${i}]: data mismatch`)
			issues.push(`  expected: ${e.data.slice(0, 74)}${e.data.length > 74 ? "..." : ""}`)
			issues.push(`  actual:   ${a.data.slice(0, 74)}${a.data.length > 74 ? "..." : ""}`)
		}
	}
	if (expected.length > min) {
		for (let i = min; i < expected.length; i++) {
			issues.push(`${label} tx[${i}]: missing — expected call to ${expected[i].to} (selector ${expected[i].data.slice(0, 10)})`)
		}
	}
	if (actual.length > min) {
		for (let i = min; i < actual.length; i++) {
			issues.push(`${label} tx[${i}]: extra — actual call to ${actual[i].to} (selector ${actual[i].data.slice(0, 10)})`)
		}
	}
}

// ============================================================================
// Expected-tx builders (mirror the generators)
// ============================================================================

function buildExpectedSafeTxs(ctx: LoadedContext): { pauseSafeTxs: SafeTransaction[]; safeTxs: SafeTransaction[] } {
	// Non-diamondCut portion is independent of the live diamond state:
	// feed diamondCut=[] so we get the same pause/post-diamondCut txs.
	const result = buildUpgradeTransactions(ctx.diamondAddress, ctx.protocolAdmin, ctx.migrationRunner, [], [], ctx.diamondCutChunkSize, ctx.newParams)

	const safeTxs = [...result.safeTxs]

	// Wiring (only if both AL and IL addresses are known)
	if (ctx.accountLayerAddress && ctx.instantLayerAddress) {
		const wiring = buildWiringTransactions(
			ctx.diamondAddress,
			ctx.accountLayerAddress,
			ctx.instantLayerAddress,
			ctx.protocolAdmin,
			ctx.partyBsForDiamond,
			ctx.partyBsForInstantLayer,
		)
		for (const tx of wiring) {
			safeTxs.push(toHumanReadableSafeTxFromIface(tx.iface, tx.to, tx.methodName, tx.args))
		}
		if (ctx.setupInstantLayerTemplates) {
			const templates = buildTemplateTransactions(ctx.instantLayerAddress)
			for (const tx of templates) {
				safeTxs.push(toHumanReadableSafeTxFromIface(tx.iface, tx.to, tx.methodName, tx.args))
			}
		}
		if (ctx.safeAddress) {
			const acceptOwnershipIface = new ethers.Interface(["function acceptOwnership()"])
			safeTxs.push(toHumanReadableSafeTxFromIface(acceptOwnershipIface, ctx.accountLayerAddress, "acceptOwnership", []))
		}
	}

	// SymbolManager wiring is independent of AccountLayer/InstantLayer.
	if (ctx.symbolManagerAddress) {
		const symbolManagerWiring = buildSymbolManagerWiringTransactions(ctx.diamondAddress, ctx.symbolManagerAddress)
		for (const tx of symbolManagerWiring) {
			safeTxs.push(toHumanReadableSafeTxFromIface(tx.iface, tx.to, tx.methodName, tx.args))
		}
	}

	return { pauseSafeTxs: result.pauseSafeTxs, safeTxs }
}

// ============================================================================
// Per-file verifiers
// ============================================================================

type SafeBatchFile = {
	version?: string
	chainId?: string
	meta?: { createdFromSafeAddress?: string }
	transactions: TxLike[]
}

export function verifyPauseSafeBatch(ctx: LoadedContext): FileCheck {
	const check: FileCheck = { file: ctx.files.pauseSafeBatch, label: "pause-safe-batch", ok: true, issues: [] }
	if (!fs.existsSync(ctx.files.pauseSafeBatch)) {
		check.skipped = true
		check.skipReason = "file not found"
		return check
	}
	const batch = readJson<SafeBatchFile>(ctx.files.pauseSafeBatch)
	const expected = buildExpectedSafeTxs(ctx).pauseSafeTxs
	compareTxLists("pause-safe-batch", expected, batch.transactions, check.issues)
	checkSafeHeader(batch, ctx.safeAddress, check.issues)
	check.ok = check.issues.length === 0
	return check
}

export function verifySafeBatch(ctx: LoadedContext): FileCheck {
	const check: FileCheck = { file: ctx.files.safeBatch, label: "safe-batch", ok: true, issues: [] }
	if (!fs.existsSync(ctx.files.safeBatch)) {
		check.skipped = true
		check.skipReason = "file not found"
		return check
	}
	const batch = readJson<SafeBatchFile>(ctx.files.safeBatch)
	const expected = buildExpectedSafeTxs(ctx).safeTxs
	compareTxLists("safe-batch", expected, batch.transactions, check.issues)
	checkSafeHeader(batch, ctx.safeAddress, check.issues)
	check.ok = check.issues.length === 0
	return check
}

const MUON_VERIFIER_IFACE = new ethers.Interface([
	"function addPublicKey(tuple(uint256 x, uint8 parity) pubKey)",
	"function addGatewaySigner(address signer)",
	"function setPublicKeyPermissions(tuple(uint256 x, uint8 parity) pubKey, uint8[] functions, bool allowed)",
	"function setGatewaySignerPermissions(address signer, uint8[] functions, bool allowed)",
])

function hasExactCall(batch: SafeBatchFile, to: string, methodName: string, args: unknown[]): boolean {
	const data = MUON_VERIFIER_IFACE.encodeFunctionData(methodName, args)
	return batch.transactions.some(tx => eqAddr(tx.to, to) && eqBytes(tx.data, data))
}

export function verifyMuonVerifierSafeBatch(ctx: LoadedContext): FileCheck {
	const check: FileCheck = { file: ctx.files.safeBatch, label: "muon-verifier-safe-batch", ok: true, issues: [] }
	const params = ctx.newParams
	const publicKeys = params.muonPublicKeys ?? []
	const gatewaySigners = params.muonGatewaySigners ?? []
	const permissionNames = params.muonFunctionPermissions ?? []

	const configProblems = validateMuonVerifierConfig(params)
	for (const problem of configProblems) {
		check.issues.push(`upgrade config: ${problem}`)
	}

	if (publicKeys.length === 0 && gatewaySigners.length === 0) {
		;(check as FileCheck & { summary?: string }).summary = "no Muon keys/gateways configured"
		check.ok = check.issues.length === 0
		return check
	}

	const verifierAddress = params.signatureVerifierAddress ?? ctx.signatureVerifierAddress
	if (!verifierAddress || !ethers.isAddress(verifierAddress)) {
		check.issues.push("signatureVerifierAddress is required when Muon public keys or gateway signers are configured")
		check.ok = false
		return check
	}
	const verifier = ethers.getAddress(verifierAddress)

	if (!fs.existsSync(ctx.files.safeBatch)) {
		check.issues.push(`missing generated safe batch: ${ctx.files.safeBatch}`)
		check.ok = false
		return check
	}

	const batch = readJson<SafeBatchFile>(ctx.files.safeBatch)
	const permissionIndices = permissionNames.map(name => MUON_FUNCTION_NAMES.indexOf(name))
	const canCheckPermissions = permissionIndices.length > 0 && permissionIndices.every(index => index >= 0)

	for (const key of publicKeys) {
		const pubKeyTuple = { x: key.x, parity: key.parity }
		if (!hasExactCall(batch, verifier, "addPublicKey", [pubKeyTuple])) {
			check.issues.push(`missing addPublicKey(x=${key.x.slice(0, 10)}..., parity=${key.parity}) on ${verifier}`)
		}
		if (canCheckPermissions && !hasExactCall(batch, verifier, "setPublicKeyPermissions", [pubKeyTuple, permissionIndices, true])) {
			check.issues.push(
				`missing setPublicKeyPermissions(x=${key.x.slice(0, 10)}..., parity=${key.parity}, [${permissionNames.join(", ")}], true) on ${verifier}`,
			)
		}
	}

	for (const signer of gatewaySigners) {
		const gateway = ethers.isAddress(signer) ? ethers.getAddress(signer) : signer
		if (!ethers.isAddress(gateway)) continue
		if (!hasExactCall(batch, verifier, "addGatewaySigner", [gateway])) {
			check.issues.push(`missing addGatewaySigner(${gateway}) on ${verifier}`)
		}
		if (canCheckPermissions && !hasExactCall(batch, verifier, "setGatewaySignerPermissions", [gateway, permissionIndices, true])) {
			check.issues.push(`missing setGatewaySignerPermissions(${gateway}, [${permissionNames.join(", ")}], true) on ${verifier}`)
		}
	}

	;(check as FileCheck & { summary?: string }).summary =
		`${publicKeys.length} public key(s), ${gatewaySigners.length} gateway signer(s), ${permissionNames.length} function permission(s)`
	check.ok = check.issues.length === 0
	return check
}

function checkSafeHeader(batch: SafeBatchFile, expectedSafe: string, issues: string[]): void {
	if (expectedSafe && batch.meta?.createdFromSafeAddress && !eqAddr(batch.meta.createdFromSafeAddress, expectedSafe)) {
		issues.push(`createdFromSafeAddress mismatch — expected ${expectedSafe}, got ${batch.meta.createdFromSafeAddress}`)
	}
}

// ---- Diamond cut calldata ---------------------------------------------------

type DiamondCutFile = {
	diamondAddress: string
	chunks: { calldata: string; description?: string }[]
}

const DIAMOND_CUT_IFACE = new ethers.Interface([
	"function diamondCut(tuple(address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)",
])

export async function verifyDiamondCutCalldata(ctx: LoadedContext, opts: { verifySelectorsAgainstArtifacts: boolean }): Promise<FileCheck> {
	const check: FileCheck = { file: ctx.files.diamondCutCalldata, label: "diamondcut-calldata", ok: true, issues: [] }
	if (!fs.existsSync(ctx.files.diamondCutCalldata)) {
		check.skipped = true
		check.skipReason = "file not found"
		return check
	}

	const data = readJson<DiamondCutFile>(ctx.files.diamondCutCalldata)
	if (!eqAddr(data.diamondAddress, ctx.diamondAddress)) {
		check.issues.push(`diamondAddress mismatch — expected ${ctx.diamondAddress}, got ${data.diamondAddress}`)
	}

	// address -> facet name (for readable errors)
	const addrToName: Record<string, string> = {}
	// address -> expected selectors set (from deployed-facets)
	const addrToSelectors: Record<string, Set<string>> = {}
	for (const [name, info] of Object.entries(ctx.deployedFacets)) {
		const key = info.address.toLowerCase()
		addrToName[key] = name
		addrToSelectors[key] = new Set(info.selectors.map(s => s.toLowerCase()))
	}

	const seenSelectors = new Set<string>()
	let totalAdd = 0
	let totalReplace = 0
	let totalRemove = 0

	for (let chunkIdx = 0; chunkIdx < data.chunks.length; chunkIdx++) {
		const chunk = data.chunks[chunkIdx]
		let decoded
		try {
			decoded = DIAMOND_CUT_IFACE.decodeFunctionData("diamondCut", chunk.calldata)
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			check.issues.push(`chunk[${chunkIdx}]: failed to decode — ${msg}`)
			continue
		}
		const [cuts, initAddr, initCalldata] = decoded as [Array<[string, number, string[]]>, string, string]

		if (!eqAddr(initAddr, ethers.ZeroAddress)) {
			check.issues.push(`chunk[${chunkIdx}]: _init must be zero address, got ${initAddr}`)
		}
		if (!eqBytes(initCalldata, "0x")) {
			check.issues.push(`chunk[${chunkIdx}]: _calldata must be 0x, got ${initCalldata}`)
		}

		for (let cutIdx = 0; cutIdx < cuts.length; cutIdx++) {
			const [facetAddress, actionRaw, selectors] = cuts[cutIdx]
			// decodeFunctionData returns uint8 as bigint — normalize to number for comparisons
			const action = Number(actionRaw)
			const location = `chunk[${chunkIdx}] cut[${cutIdx}]`
			for (const sel of selectors) {
				const lower = sel.toLowerCase()
				if (seenSelectors.has(lower)) {
					check.issues.push(`${location}: duplicate selector ${sel} across chunks`)
				}
				seenSelectors.add(lower)
			}

			if (action === 0 || action === 1) {
				// Add / Replace — facetAddress must be one of our deployed facets
				const key = facetAddress.toLowerCase()
				if (!addrToSelectors[key]) {
					check.issues.push(`${location}: facet address ${facetAddress} not found in deployed-facets-${ctx.networkName}.json`)
					continue
				}
				const expectedSels = addrToSelectors[key]
				for (const sel of selectors) {
					if (!expectedSels.has(sel.toLowerCase())) {
						check.issues.push(`${location}: selector ${sel} not declared by ${addrToName[key]} (${facetAddress})`)
					}
				}
				if (action === 0) totalAdd += selectors.length
				else totalReplace += selectors.length
			} else if (action === 2) {
				// Remove
				if (!eqAddr(facetAddress, ethers.ZeroAddress)) {
					check.issues.push(`${location}: remove action must target zero address, got ${facetAddress}`)
				}
				totalRemove += selectors.length
			} else {
				check.issues.push(`${location}: invalid action ${action} (expected 0/1/2)`)
			}
		}
	}

	// Optional cross-check: deployed-facets.json selectors match local compiled artifacts
	if (opts.verifySelectorsAgainstArtifacts) {
		await verifyDeployedFacetsAgainstArtifacts(ctx, check.issues)
	}

	check.ok = check.issues.length === 0
	// Stash the decoded totals so the caller can print a human summary
	;(check as FileCheck & { summary?: string }).summary =
		`add=${totalAdd}, replace=${totalReplace}, remove=${totalRemove}, chunks=${data.chunks.length}`
	return check
}

async function verifyDeployedFacetsAgainstArtifacts(ctx: LoadedContext, issues: string[]): Promise<void> {
	const DUMMY_LIB = "0x0000000000000000000000000000000000000001"

	for (const facetName of FacetNames) {
		const shortName = facetName.includes(":") ? facetName.split(":").pop()! : facetName
		const entry = ctx.deployedFacets[shortName]
		if (!entry) {
			issues.push(`deployed-facets: missing facet ${shortName}`)
			continue
		}
		const requiredLibs = FacetLibraryDependencies[shortName]
		let factory
		if (requiredLibs && requiredLibs.length > 0) {
			const linked: Record<string, string> = {}
			for (const lib of requiredLibs) {
				linked[LibraryLinkReferences[lib]] = DUMMY_LIB
			}
			factory = await ethers.getContractFactory(facetName, { libraries: linked })
		} else {
			factory = await ethers.getContractFactory(facetName)
		}
		const expected = new Set<string>(getSelectors(ethers, factory).selectors.map((s: string) => s.toLowerCase()))
		const actual = new Set<string>(entry.selectors.map(s => s.toLowerCase()))

		for (const sel of expected) {
			if (!actual.has(sel)) {
				const sig = factory.interface.getFunction(sel)?.format("sighash") ?? sel
				issues.push(`deployed-facets/${shortName}: missing selector ${sig} (${sel}) declared in compiled ABI`)
			}
		}
		for (const sel of actual) {
			if (!expected.has(sel)) {
				issues.push(`deployed-facets/${shortName}: selector ${sel} not found in compiled ABI`)
			}
		}
	}
}

// ---- Timelock batches (schedule + execute) ---------------------------------

const TIMELOCK_IFACE = new ethers.Interface([
	"function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
	"function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
])

function expectedTimelockSalt(chainId: bigint, diamondAddress: string, index: number): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(
			["uint256", "address", "string", "uint256"],
			[chainId, diamondAddress, "diamondCut-v0.8.5", BigInt(index)],
		),
	)
}

function timelockOperationId(target: string, value: bigint, data: string, predecessor: string, salt: string): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes", "bytes32", "bytes32"], [target, value, data, predecessor, salt]),
	)
}

export function verifyTimelockBatches(ctx: LoadedContext, kind: "schedule" | "execute", opts: { minDelay?: bigint }): FileCheck {
	const files = kind === "schedule" ? ctx.files.timelockSchedule : ctx.files.timelockExecute
	const label = `timelock-${kind}-safe-batch`
	const check: FileCheck = { file: files.join(", ") || `(${label}-*.json)`, label, ok: true, issues: [] }

	if (files.length === 0) {
		check.skipped = true
		check.skipReason = "no files found"
		return check
	}
	if (!ctx.timelockAddress) {
		check.issues.push("timelockAddress not configured in upgrade.json but timelock files exist")
		check.ok = false
		return check
	}
	if (!fs.existsSync(ctx.files.diamondCutCalldata)) {
		check.issues.push(`missing ${ctx.files.diamondCutCalldata} — required to cross-check timelock inner calldata`)
		check.ok = false
		return check
	}

	const diamondCut = readJson<DiamondCutFile>(ctx.files.diamondCutCalldata)
	if (files.length !== diamondCut.chunks.length) {
		check.issues.push(`${label}: file count (${files.length}) does not match diamondcut-calldata chunks (${diamondCut.chunks.length})`)
	}

	// Collect chain id from the first file (and verify all files agree)
	const firstBatch = readJson<SafeBatchFile>(files[0])
	const chainIdStr = firstBatch.chainId ?? ""
	if (!chainIdStr) {
		check.issues.push(`${files[0]}: missing chainId in file header`)
	}
	const chainId = chainIdStr ? BigInt(chainIdStr) : 0n

	let predecessor: string = ethers.ZeroHash

	const n = Math.min(files.length, diamondCut.chunks.length)
	for (let i = 0; i < n; i++) {
		const batch = readJson<SafeBatchFile>(files[i])
		if (batch.chainId !== chainIdStr) {
			check.issues.push(`${files[i]}: chainId ${batch.chainId} differs from first file ${chainIdStr}`)
		}
		if (batch.transactions.length !== 1) {
			check.issues.push(`${files[i]}: expected exactly one transaction, got ${batch.transactions.length}`)
			continue
		}
		const tx = batch.transactions[0]
		if (!eqAddr(tx.to, ctx.timelockAddress)) {
			check.issues.push(`${files[i]}: to ${tx.to} != timelockAddress ${ctx.timelockAddress}`)
		}

		const expectedChunkCalldata = diamondCut.chunks[i].calldata
		const expectedSalt = chainId > 0n ? expectedTimelockSalt(chainId, ctx.diamondAddress, i) : null

		let decoded
		try {
			decoded = TIMELOCK_IFACE.decodeFunctionData(kind, tx.data)
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			check.issues.push(`${files[i]}: failed to decode ${kind}() — ${msg}`)
			continue
		}

		if (kind === "schedule") {
			const [target, value, data, predecessorArg, saltArg, delayArg] = decoded as [string, bigint, string, string, string, bigint]
			if (!eqAddr(target, ctx.diamondAddress)) {
				check.issues.push(`${files[i]}: schedule.target ${target} != diamondAddress ${ctx.diamondAddress}`)
			}
			if (value !== 0n) check.issues.push(`${files[i]}: schedule.value != 0 (got ${value})`)
			if (!eqBytes(data, expectedChunkCalldata)) {
				check.issues.push(`${files[i]}: schedule.data does not match diamondcut-calldata.chunks[${i}]`)
			}
			if (!eqBytes(predecessorArg, predecessor)) {
				check.issues.push(`${files[i]}: predecessor ${predecessorArg} != expected ${predecessor}`)
			}
			if (expectedSalt && !eqBytes(saltArg, expectedSalt)) {
				check.issues.push(`${files[i]}: salt ${saltArg} != expected ${expectedSalt}`)
			}
			if (opts.minDelay !== undefined && delayArg !== opts.minDelay) {
				check.issues.push(`${files[i]}: delay ${delayArg} != timelock.getMinDelay() ${opts.minDelay}`)
			}

			// Advance predecessor chain
			predecessor = timelockOperationId(target, value, data, predecessorArg, saltArg)
		} else {
			const [target, value, data, predecessorArg, saltArg] = decoded as [string, bigint, string, string, string]
			if (!eqAddr(target, ctx.diamondAddress)) {
				check.issues.push(`${files[i]}: execute.target ${target} != diamondAddress ${ctx.diamondAddress}`)
			}
			if (value !== 0n) check.issues.push(`${files[i]}: execute.value != 0 (got ${value})`)
			if (!eqBytes(data, expectedChunkCalldata)) {
				check.issues.push(`${files[i]}: execute.payload does not match diamondcut-calldata.chunks[${i}]`)
			}
			if (!eqBytes(predecessorArg, predecessor)) {
				check.issues.push(`${files[i]}: predecessor ${predecessorArg} != expected ${predecessor}`)
			}
			if (expectedSalt && !eqBytes(saltArg, expectedSalt)) {
				check.issues.push(`${files[i]}: salt ${saltArg} != expected ${expectedSalt}`)
			}
			predecessor = timelockOperationId(target, value, data, predecessorArg, saltArg)
		}
	}

	check.ok = check.issues.length === 0
	return check
}

// ---- Post-migration --------------------------------------------------------

const POST_MIGRATION_IFACE = new ethers.Interface([
	"function revokeRole(address user, bytes32 role)",
	"function unpauseGlobal()",
	"function setCrossPartyBModeActivated(bool activated)",
	"function setCrossPartyB(address partyB, bool enabled)",
])

function buildExpectedPostMigrationTxs(ctx: LoadedContext, partyBs: string[]): SafeTransaction[] {
	const txs: SafeTransaction[] = []
	const push = (method: string, args: unknown[]) => {
		txs.push(toHumanReadableSafeTxFromIface(POST_MIGRATION_IFACE, ctx.diamondAddress, method, args))
	}
	push("revokeRole", [ctx.migrationRunner, ethers.id("MIGRATION_ROLE")])
	push("revokeRole", [ctx.migrationRunner, ethers.id("SYMBOL_MANAGER_ROLE")])
	push("unpauseGlobal", [])
	if (partyBs.length > 0) {
		push("setCrossPartyBModeActivated", [true])
		for (const pb of partyBs) push("setCrossPartyB", [pb, true])
	}
	return txs
}

function readPostMigrationPartyBsFromConfig(ctx: LoadedContext): string[] {
	// post-migration batch partyBs live in postMigration.json — not upgrade.json.
	// Resolve via env first, then config file alongside other configs.
	const configFile =
		process.env.POST_MIGRATION_CONFIG_FILE ?? path.join(path.dirname(ctx.files.postMigrationSafeBatch), "..", "config", "postMigration.json")
	const configPath = path.resolve(configFile)
	const cfg = tryReadJson<{ partyBs?: string[] }>(configPath) ?? {}
	return (cfg.partyBs ?? []).filter(a => ethers.isAddress(a)).map(a => ethers.getAddress(a))
}

export function verifyPostMigrationSafeBatch(ctx: LoadedContext): FileCheck {
	const check: FileCheck = { file: ctx.files.postMigrationSafeBatch, label: "post-migration-safe-batch", ok: true, issues: [] }
	if (!fs.existsSync(ctx.files.postMigrationSafeBatch)) {
		check.skipped = true
		check.skipReason = "file not found"
		return check
	}
	const batch = readJson<SafeBatchFile>(ctx.files.postMigrationSafeBatch)
	const partyBs = readPostMigrationPartyBsFromConfig(ctx)
	const expected = buildExpectedPostMigrationTxs(ctx, partyBs)
	compareTxLists("post-migration-safe-batch", expected, batch.transactions, check.issues)
	checkSafeHeader(batch, ctx.safeAddress, check.issues)
	check.ok = check.issues.length === 0
	return check
}

export function verifyPostMigrationTransactions(ctx: LoadedContext): FileCheck {
	const check: FileCheck = { file: ctx.files.postMigrationTransactions, label: "post-migration-transactions", ok: true, issues: [] }
	if (!fs.existsSync(ctx.files.postMigrationTransactions)) {
		check.skipped = true
		check.skipReason = "file not found"
		return check
	}
	const rawTxs = readJson<{ to: string; value: string; calldata: string; description: string }[]>(ctx.files.postMigrationTransactions)
	const partyBs = readPostMigrationPartyBsFromConfig(ctx)
	const expected = buildExpectedPostMigrationTxs(ctx, partyBs)
	const actual: TxLike[] = rawTxs.map(t => ({ to: t.to, value: t.value, data: t.calldata }))
	compareTxLists("post-migration-transactions", expected, actual, check.issues)
	check.ok = check.issues.length === 0
	return check
}

// ---- Grant / revoke symbol role --------------------------------------------

const ROLE_IFACE = new ethers.Interface(["function grantRole(address user, bytes32 role)", "function revokeRole(address user, bytes32 role)"])

export function verifySingleRoleBatch(ctx: LoadedContext, kind: "grant" | "revoke"): FileCheck {
	const file = kind === "grant" ? ctx.files.grantSymbolRoleSafeBatch : ctx.files.revokeSymbolRoleSafeBatch
	const label = `${kind}-symbol-role-safe-batch`
	const check: FileCheck = { file, label, ok: true, issues: [] }
	if (!fs.existsSync(file)) {
		check.skipped = true
		check.skipReason = "file not found"
		return check
	}
	const batch = readJson<SafeBatchFile>(file)
	const method = kind === "grant" ? "grantRole" : "revokeRole"
	const expected = [toHumanReadableSafeTxFromIface(ROLE_IFACE, ctx.diamondAddress, method, [ctx.migrationRunner, ethers.id("SYMBOL_MANAGER_ROLE")])]
	compareTxLists(label, expected, batch.transactions, check.issues)
	checkSafeHeader(batch, ctx.safeAddress, check.issues)
	check.ok = check.issues.length === 0
	return check
}

// ---- Add-templates batch ---------------------------------------------------

const IL_ADD_TEMPLATE_IFACE = new ethers.Interface([
	"function addTemplate(string name, tuple(uint256[] insertionPoints, uint256[] sourceIndices, uint256[] sourceOffsets)[] operations)",
])

export function verifyAddTemplatesBatch(ctx: LoadedContext): FileCheck {
	const check: FileCheck = { file: ctx.files.addTemplatesSafeBatch, label: "add-templates-safe-batch", ok: true, issues: [] }
	if (!fs.existsSync(ctx.files.addTemplatesSafeBatch)) {
		check.skipped = true
		check.skipReason = "file not found"
		return check
	}
	if (!ctx.instantLayerAddress) {
		check.issues.push("instantLayerAddress not resolved from config or deployed-peripherals — cannot verify addTemplate targets")
		check.ok = false
		return check
	}
	const batch = readJson<SafeBatchFile>(ctx.files.addTemplatesSafeBatch)
	const expected: SafeTransaction[] = (ctx.templates as { name: string; operations: unknown[] }[]).map(t =>
		toHumanReadableSafeTxFromIface(IL_ADD_TEMPLATE_IFACE, ctx.instantLayerAddress!, "addTemplate", [t.name, t.operations]),
	)
	compareTxLists("add-templates-safe-batch", expected, batch.transactions, check.issues)
	checkSafeHeader(batch, ctx.safeAddress, check.issues)
	check.ok = check.issues.length === 0
	return check
}
