/**
 * Usage:
 * - Dry run:
 *   DRY_RUN=true OPEN_PATHS='[[sendQuote,allocate,lock],[sendQuote,lock]]' CLOSE_PATH='[requestClose,fillClose]' \
 *   DRY_RUN_OUTPUT_PATH=./tasks/data/my-template-dry-run.json INSTANT_LAYER_ADDRESS=0x... \
 *   npx hardhat run scripts/addSendAllocateLockOpenTemplate.ts --network <network>
 * - Real execution:
 *   OPEN_PATHS='[[sendQuote,allocate,lock,open],[sendQuote,lock,open]]' CLOSE_PATH='[requestClose,allocate,fillClose]' \
 *   INSTANT_LAYER_ADDRESS=0x... \
 *   npx hardhat run scripts/addSendAllocateLockOpenTemplate.ts --network <network>
 *
 * Full docs:
 * - docs/v0.8.5/scripts/instant-layer-template-script.md
 */
import fs from "node:fs"
import path from "node:path"

import { ethers } from "../test/helpers/hardhat-connection.js"

const DATA_FILE_PATH = "./tasks/data/instantlayer.json"
const DEFAULT_DRY_RUN_OUTPUT_PATH = "./tasks/data/instantlayer-template-dry-run.json"

const OPEN_CANONICAL_PATH = ["sendQuote", "allocate", "lock", "open"] as const
const CLOSE_CANONICAL_PATH = ["requestClose", "allocate", "fillClose"] as const

type InstantLayerDeploymentEntry = {
	address?: string
}

type PathKind = "open" | "close"
type OpenPathToken = (typeof OPEN_CANONICAL_PATH)[number]
type ClosePathToken = (typeof CLOSE_CANONICAL_PATH)[number]

type TemplateOperation = {
	sourceIndices: number[]
	insertionPoints: number[]
	sourceOffsets: number[]
}

type TemplatePlan = {
	kind: PathKind
	templateName: string
	description: string
	tokens: string[]
	operations: TemplateOperation[]
}

type TemplateResult = {
	kind: PathKind
	templateName: string
	description: string
	pathTokens: string[]
	existingTemplateId: string | null
	nextTemplateId: string | null
	predictedTemplateId: string | null
	wouldSubmitTransaction: boolean
	reason: string
	operations: TemplateOperation[]
	simulation: {
		ok: boolean
		error?: string
	}
}

type DryRunReport = {
	timestamp: string
	chainId: string
	executor: string
	instantLayerAddress: string
	contractCodePresent: boolean
	rpcHealth: {
		ok: boolean
		blockNumber?: string
		error?: string
	}
	allowDuplicateTemplate: boolean
	requestedPaths: {
		openPaths: string[][]
		closePath: string[] | null
	}
	templates: TemplateResult[]
	summary: {
		total: number
		addable: number
		blocked: number
	}
}

type InstantLayerLike = {
	getNextTemplateId: () => Promise<bigint>
	nextTemplateId: () => Promise<bigint>
	getTemplate: (templateId: bigint) => Promise<{ name: string }>
}

function getInstantLayerAddressFromFile(): string | undefined {
	if (!fs.existsSync(DATA_FILE_PATH)) {
		return undefined
	}

	const parsed = JSON.parse(fs.readFileSync(DATA_FILE_PATH, "utf8")) as InstantLayerDeploymentEntry[]
	if (!Array.isArray(parsed) || parsed.length === 0) {
		return undefined
	}

	return parsed[0]?.address
}

function ensureParentDirectory(filePath: string): void {
	const parent = path.dirname(filePath)
	if (!fs.existsSync(parent)) {
		fs.mkdirSync(parent, { recursive: true })
	}
}

function extractErrorMessage(error: unknown): string {
	const err = error as any
	const statusCode = err?.cause?.statusCode ?? err?.statusCode
	const bodyMessage = err?.cause?.body?.message
	const base = bodyMessage ?? err?.shortMessage ?? err?.reason ?? err?.message ?? "Unknown error"
	if (statusCode !== undefined) {
		return `${base} (status: ${statusCode})`
	}
	return base
}

function toPathItems(rawPath: string, kind: PathKind, label: string): string[] {
	const trimmed = rawPath.trim()
	const content = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
	const items = content
		.split(",")
		.map(v => v.trim())
		.filter(Boolean)

	if (items.length === 0) {
		throw new Error(`${label} is empty. Example: ${kind === "open" ? "[sendQuote,lock,open]" : "[requestClose,fillClose]"}`)
	}
	return items
}

function normalizeOpenToken(value: string): OpenPathToken | null {
	const v = value.toLowerCase()
	if (v === "sendquote" || v === "send_quote" || v === "sendquotewithaffiliateanddata" || v === "send") return "sendQuote"
	if (v === "allocate" || v === "allocateforpartyb") return "allocate"
	if (v === "lock" || v === "lockquote") return "lock"
	if (v === "open" || v === "openposition") return "open"
	return null
}

function normalizeCloseToken(value: string): ClosePathToken | null {
	const v = value.toLowerCase()
	if (v === "requestclose" || v === "request_close" || v === "requesttocloseposition") return "requestClose"
	if (v === "allocate" || v === "allocateforpartyb") return "allocate"
	if (v === "fillclose" || v === "fill_close" || v === "fillcloserequest") return "fillClose"
	return null
}

function assertUnique(tokens: string[], label: string): void {
	const seen = new Set<string>()
	const duplicates: string[] = []
	for (const token of tokens) {
		if (seen.has(token)) duplicates.push(token)
		seen.add(token)
	}
	if (duplicates.length > 0) {
		throw new Error(`${label} has duplicate steps: ${duplicates.join(", ")}`)
	}
}

function assertSubsequenceOrder<T extends string>(tokens: T[], canonical: readonly T[], label: string): void {
	let canonicalIndex = 0
	for (const token of tokens) {
		while (canonicalIndex < canonical.length && canonical[canonicalIndex] !== token) {
			canonicalIndex++
		}
		if (canonicalIndex >= canonical.length) {
			throw new Error(`${label} order is invalid. Expected subsequence of [${canonical.join(", ")}], got [${tokens.join(", ")}]`)
		}
		canonicalIndex++
	}
}

function parseOpenPath(raw: string, label: string): OpenPathToken[] {
	const items = toPathItems(raw, "open", label)
	const tokens = items.map(v => {
		const normalized = normalizeOpenToken(v)
		if (!normalized) {
			throw new Error(`Invalid ${label} token "${v}". Allowed: sendQuote, allocate, lock, open`)
		}
		return normalized
	})

	assertUnique(tokens, label)
	assertSubsequenceOrder(tokens, OPEN_CANONICAL_PATH, label)
	if (tokens[0] !== "sendQuote") {
		throw new Error(`${label} must start with "sendQuote"`)
	}
	return tokens
}

function parseClosePath(raw: string | undefined): ClosePathToken[] | null {
	if (!raw || raw.trim() === "") return null
	const label = "CLOSE_PATH"
	const items = toPathItems(raw, "close", label)
	const tokens = items.map(v => {
		const normalized = normalizeCloseToken(v)
		if (!normalized) {
			throw new Error(`Invalid ${label} token "${v}". Allowed: requestClose, allocate, fillClose`)
		}
		return normalized
	})

	assertUnique(tokens, label)
	assertSubsequenceOrder(tokens, CLOSE_CANONICAL_PATH, label)
	if (tokens[0] !== "requestClose") {
		throw new Error(`${label} must start with "requestClose"`)
	}
	return tokens
}

function parseOpenPathsFromNested(rawNested: string, sourceLabel: string): OpenPathToken[][] {
	const matches = [...rawNested.matchAll(/\[([^[\]]+)\]/g)]
	if (matches.length === 0) {
		throw new Error(`${sourceLabel} format is invalid. Example: [[sendQuote,allocate,lock],[sendQuote,lock]]`)
	}
	return matches.map((m, idx) => parseOpenPath(`[${m[1]}]`, `${sourceLabel}[${idx}]`))
}

function parseOpenPaths(rawOpenPath: string | undefined, rawOpenPaths: string | undefined): OpenPathToken[][] {
	if (rawOpenPaths && rawOpenPaths.trim() !== "") {
		return parseOpenPathsFromNested(rawOpenPaths, "OPEN_PATHS")
	}

	if (rawOpenPath && rawOpenPath.trim() !== "") {
		const trimmed = rawOpenPath.trim()
		if (trimmed.startsWith("[[")) {
			return parseOpenPathsFromNested(trimmed, "OPEN_PATH")
		}
		return [parseOpenPath(trimmed, "OPEN_PATH")]
	}

	return [OPEN_CANONICAL_PATH.slice()]
}

function buildOpenOperations(tokens: OpenPathToken[]): TemplateOperation[] {
	const sendQuoteIndex = tokens.indexOf("sendQuote")
	return tokens.map((token, index) => {
		if ((token === "lock" || token === "open") && sendQuoteIndex >= 0 && sendQuoteIndex < index) {
			return { sourceIndices: [sendQuoteIndex], insertionPoints: [0], sourceOffsets: [0] }
		}
		return { sourceIndices: [], insertionPoints: [], sourceOffsets: [] }
	})
}

function buildCloseOperations(tokens: ClosePathToken[]): TemplateOperation[] {
	return tokens.map(() => ({ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }))
}

function getDefaultTemplateName(kind: PathKind, tokens: string[]): string {
	return `${kind === "open" ? "OpenPath" : "ClosePath"}_${tokens.join("_")}`
}

function buildPlans(
	openPaths: OpenPathToken[][],
	closePath: ClosePathToken[] | null,
	templateNamePrefix: string | undefined,
	openTemplateNameOverride: string | undefined,
	closeTemplateNameOverride: string | undefined,
	singleTemplateNameOverride: string | undefined,
): TemplatePlan[] {
	const plans: TemplatePlan[] = []

	if (openTemplateNameOverride && openPaths.length !== 1) {
		throw new Error("OPEN_TEMPLATE_NAME can be used only when exactly one open path is provided.")
	}

	for (let i = 0; i < openPaths.length; i++) {
		const tokens = [...openPaths[i]]
		const defaultName = getDefaultTemplateName("open", tokens)
		const chosenName = openTemplateNameOverride ?? defaultName
		const baseName = openPaths.length > 1 ? `${chosenName}_${i + 1}` : chosenName
		const templateName = templateNamePrefix ? `${templateNamePrefix}_${baseName}` : baseName

		plans.push({
			kind: "open",
			templateName,
			description: tokens.join(" -> "),
			tokens,
			operations: buildOpenOperations(tokens),
		})
	}

	if (closePath) {
		const tokens = [...closePath]
		const closeDefaultName = getDefaultTemplateName("close", tokens)
		const closeName = closeTemplateNameOverride ?? closeDefaultName
		const templateName = templateNamePrefix ? `${templateNamePrefix}_${closeName}` : closeName
		plans.push({
			kind: "close",
			templateName,
			description: tokens.join(" -> "),
			tokens,
			operations: buildCloseOperations(tokens),
		})
	}

	if (plans.length === 1 && singleTemplateNameOverride) {
		plans[0].templateName = singleTemplateNameOverride
	}

	return plans
}

async function readNextTemplateId(instantLayer: InstantLayerLike): Promise<bigint> {
	try {
		return BigInt(await instantLayer.getNextTemplateId())
	} catch {
		return BigInt(await instantLayer.nextTemplateId())
	}
}

async function getTemplateIdMapByName(instantLayer: InstantLayerLike): Promise<Map<string, bigint>> {
	const nextTemplateId = await readNextTemplateId(instantLayer)
	const templateIdMap = new Map<string, bigint>()
	for (let i = 0n; i < nextTemplateId; i++) {
		const template = await instantLayer.getTemplate(i)
		if (!templateIdMap.has(template.name)) {
			templateIdMap.set(template.name, i)
		}
	}
	return templateIdMap
}

const instantLayerAddress = process.env.INSTANT_LAYER_ADDRESS ?? getInstantLayerAddressFromFile()
const allowDuplicateTemplate = process.env.ALLOW_DUPLICATE_TEMPLATE === "true"
const dryRun = process.env.DRY_RUN === "true"
const dryRunOutputPath = process.env.DRY_RUN_OUTPUT_PATH ?? DEFAULT_DRY_RUN_OUTPUT_PATH

const openPaths = parseOpenPaths(process.env.OPEN_PATH, process.env.OPEN_PATHS)
const closePath = parseClosePath(process.env.CLOSE_PATH)
const templateNamePrefix = process.env.TEMPLATE_NAME_PREFIX
const openTemplateNameOverride = process.env.OPEN_TEMPLATE_NAME
const closeTemplateNameOverride = process.env.CLOSE_TEMPLATE_NAME
const singleTemplateNameOverride = process.env.INSTANT_LAYER_TEMPLATE_NAME

const plans = buildPlans(openPaths, closePath, templateNamePrefix, openTemplateNameOverride, closeTemplateNameOverride, singleTemplateNameOverride)

if (!instantLayerAddress) {
	throw new Error("InstantLayer address not found. Set INSTANT_LAYER_ADDRESS or ensure tasks/data/instantlayer.json has a deployed address.")
}

const [signer] = await ethers.getSigners()
let chainId = "unknown"
let rpcHealth: DryRunReport["rpcHealth"] = { ok: false }

try {
	const network = await ethers.provider.getNetwork()
	const blockNumber = await ethers.provider.getBlockNumber()
	chainId = network.chainId.toString()
	rpcHealth = { ok: true, blockNumber: blockNumber.toString() }
} catch (error: unknown) {
	const rpcError = extractErrorMessage(error)

	if (dryRun) {
		const templates: TemplateResult[] = plans.map(plan => ({
			kind: plan.kind,
			templateName: plan.templateName,
			description: plan.description,
			pathTokens: plan.tokens,
			existingTemplateId: null,
			nextTemplateId: null,
			predictedTemplateId: null,
			wouldSubmitTransaction: false,
			reason: `RPC health check failed: ${rpcError}`,
			operations: plan.operations,
			simulation: { ok: false, error: rpcError },
		}))

		const report: DryRunReport = {
			timestamp: new Date().toISOString(),
			chainId,
			executor: signer.address,
			instantLayerAddress,
			contractCodePresent: false,
			rpcHealth: { ok: false, error: rpcError },
			allowDuplicateTemplate,
			requestedPaths: {
				openPaths: openPaths.map(p => [...p]),
				closePath: closePath ? [...closePath] : null,
			},
			templates,
			summary: { total: templates.length, addable: 0, blocked: templates.length },
		}

		ensureParentDirectory(dryRunOutputPath)
		fs.writeFileSync(dryRunOutputPath, JSON.stringify(report, null, 2))
		console.log(`Dry run report written to: ${dryRunOutputPath}`)
		process.exit(0)
	}

	throw new Error(`RPC health check failed: ${rpcError}`)
}

console.log(`Network chainId: ${chainId}`)
console.log(`Block number: ${rpcHealth.blockNumber}`)
console.log(`Executor: ${signer.address}`)
console.log(`InstantLayer: ${instantLayerAddress}`)
console.log(`Open paths: ${openPaths.map(p => `[${p.join(",")}]`).join(" , ")}`)
console.log(`Close path: ${closePath ? `[${closePath.join(",")}]` : "not set"}`)

const codeAtAddress = await ethers.provider.getCode(instantLayerAddress)
const hasCode = codeAtAddress !== "0x"

if (!hasCode) {
	const reason = `No contract bytecode found at ${instantLayerAddress} on chainId ${chainId}. Use the correct InstantLayer address for this network or run with --network <name>.`

	if (dryRun) {
		const templates: TemplateResult[] = plans.map(plan => ({
			kind: plan.kind,
			templateName: plan.templateName,
			description: plan.description,
			pathTokens: plan.tokens,
			existingTemplateId: null,
			nextTemplateId: null,
			predictedTemplateId: null,
			wouldSubmitTransaction: false,
			reason,
			operations: plan.operations,
			simulation: { ok: false, error: reason },
		}))

		const report: DryRunReport = {
			timestamp: new Date().toISOString(),
			chainId,
			executor: signer.address,
			instantLayerAddress,
			contractCodePresent: false,
			rpcHealth,
			allowDuplicateTemplate,
			requestedPaths: {
				openPaths: openPaths.map(p => [...p]),
				closePath: closePath ? [...closePath] : null,
			},
			templates,
			summary: { total: templates.length, addable: 0, blocked: templates.length },
		}

		ensureParentDirectory(dryRunOutputPath)
		fs.writeFileSync(dryRunOutputPath, JSON.stringify(report, null, 2))
		console.log(`Dry run report written to: ${dryRunOutputPath}`)
		process.exit(0)
	}

	throw new Error(reason)
}

const instantLayer: any = await ethers.getContractAt("InstantLayer", instantLayerAddress, signer)

let templateIdMap: Map<string, bigint>
let startNextTemplateId: bigint
try {
	startNextTemplateId = await readNextTemplateId(instantLayer as InstantLayerLike)
	templateIdMap = await getTemplateIdMapByName(instantLayer as InstantLayerLike)
} catch (error: unknown) {
	const readError = extractErrorMessage(error)
	const reason = `Failed to read template metadata from InstantLayer at ${instantLayerAddress}: ${readError}`

	if (dryRun) {
		const templates: TemplateResult[] = plans.map(plan => ({
			kind: plan.kind,
			templateName: plan.templateName,
			description: plan.description,
			pathTokens: plan.tokens,
			existingTemplateId: null,
			nextTemplateId: null,
			predictedTemplateId: null,
			wouldSubmitTransaction: false,
			reason,
			operations: plan.operations,
			simulation: { ok: false, error: readError },
		}))

		const report: DryRunReport = {
			timestamp: new Date().toISOString(),
			chainId,
			executor: signer.address,
			instantLayerAddress,
			contractCodePresent: true,
			rpcHealth,
			allowDuplicateTemplate,
			requestedPaths: {
				openPaths: openPaths.map(p => [...p]),
				closePath: closePath ? [...closePath] : null,
			},
			templates,
			summary: { total: templates.length, addable: 0, blocked: templates.length },
		}

		ensureParentDirectory(dryRunOutputPath)
		fs.writeFileSync(dryRunOutputPath, JSON.stringify(report, null, 2))
		console.log(`Dry run report written to: ${dryRunOutputPath}`)
		process.exit(0)
	}

	throw new Error(reason)
}

let predictedTemplateIdCursor = startNextTemplateId
const templateResults: TemplateResult[] = []

for (const plan of plans) {
	const existingTemplateId = templateIdMap.get(plan.templateName) ?? null
	const duplicateBlocked = existingTemplateId !== null && !allowDuplicateTemplate
	const predictedTemplateId = duplicateBlocked ? null : predictedTemplateIdCursor.toString()
	if (!duplicateBlocked) predictedTemplateIdCursor++

	const result: TemplateResult = {
		kind: plan.kind,
		templateName: plan.templateName,
		description: plan.description,
		pathTokens: plan.tokens,
		existingTemplateId: existingTemplateId === null ? null : existingTemplateId.toString(),
		nextTemplateId: startNextTemplateId.toString(),
		predictedTemplateId,
		wouldSubmitTransaction: !duplicateBlocked,
		reason: duplicateBlocked ? `Template "${plan.templateName}" already exists and duplicates are not allowed` : "No duplicate conflict detected",
		operations: plan.operations,
		simulation: { ok: false },
	}

	if (!duplicateBlocked) {
		try {
			await instantLayer.addTemplate.staticCall(plan.templateName, plan.operations)
			result.simulation.ok = true
		} catch (error: unknown) {
			const simError = extractErrorMessage(error)
			result.simulation.ok = false
			result.simulation.error = simError
			result.wouldSubmitTransaction = false
			result.reason = `Simulation failed: ${simError}`
		}
	} else {
		result.simulation.ok = false
		result.simulation.error = result.reason
	}

	templateResults.push(result)
}

if (dryRun) {
	const addable = templateResults.filter(r => r.wouldSubmitTransaction).length
	const report: DryRunReport = {
		timestamp: new Date().toISOString(),
		chainId,
		executor: signer.address,
		instantLayerAddress,
		contractCodePresent: true,
		rpcHealth,
		allowDuplicateTemplate,
		requestedPaths: {
			openPaths: openPaths.map(p => [...p]),
			closePath: closePath ? [...closePath] : null,
		},
		templates: templateResults,
		summary: {
			total: templateResults.length,
			addable,
			blocked: templateResults.length - addable,
		},
	}

	ensureParentDirectory(dryRunOutputPath)
	fs.writeFileSync(dryRunOutputPath, JSON.stringify(report, null, 2))
	console.log(`Dry run report written to: ${dryRunOutputPath}`)
	process.exit(0)
}

for (const plan of plans) {
	const runInfo = templateResults.find(r => r.kind === plan.kind && r.templateName === plan.templateName)!
	console.log(`${plan.kind.toUpperCase()} template "${plan.templateName}"`)
	console.log(`Path: ${plan.description}`)

	if (!runInfo.wouldSubmitTransaction) {
		console.log(`Skipping "${plan.templateName}": ${runInfo.reason}`)
		continue
	}

	const tx = await instantLayer.addTemplate(plan.templateName, plan.operations)
	console.log(`Submitted tx for "${plan.templateName}": ${tx.hash}`)
	await tx.wait()

	const createdTemplateId = (await readNextTemplateId(instantLayer as InstantLayerLike)) - 1n
	console.log(`Template "${plan.templateName}" added successfully. templateId=${createdTemplateId}`)
}
