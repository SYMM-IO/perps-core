/**
 * Fetch Solver entities from configured chain subgraphs.
 *
 * Defaults to every scripts/upgrade/config/upgrade-<chain>.json file with a
 * subgraph endpoint. Narrow the run with SOLVER_CHAINS, CHAIN, or NETWORK.
 *
 * Run:
 *   node --import tsx scripts/upgrade/fetchSolverList.ts
 *   SOLVER_CHAINS=base,bsc node --import tsx scripts/upgrade/fetchSolverList.ts
 *
 * Output:
 *   scripts/upgrade/output/solver-list-<chain>.json
 *   scripts/upgrade/output/solver-list-all.json      (when multiple chains run)
 *   scripts/upgrade/config/partyBList-<chain>.json   (for generateSafeBatch.ts)
 */
import fs from "fs"
import path from "path"

const CONFIG_DIR = "./scripts/upgrade/config"
const OUTPUT_DIR = "./scripts/upgrade/output"
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 2000
const DEFAULT_REGISTER_ON_INSTANT_LAYER = true
const DEFAULT_REGISTER_ON_SYMMIO_CORE = true

type UpgradeConfig = {
	subgraphEndpoint?: string
	subgraphEndpoints?: string[]
}

type SubgraphEndpointInput = string | string[]

type SubgraphSymmioEntity = {
	id: string
	type: string
	name: string | null
}

type SubgraphSolver = {
	id: string
	type: "Solver"
	name: string
}

type ChainSolverOutput = {
	generatedAt: string
	chain: string
	subgraphEndpoints: string[]
	count: number
	solvers: SubgraphSolver[]
}

type AllChainsOutput = {
	generatedAt: string
	chains: Record<string, ChainSolverOutput>
}

type PartyBListOutput = {
	generatedAt: string
	source: {
		chain: string
		subgraphEndpoints: string[]
		solverCount: number
	}
	partyBs: Record<string, string[]>
	registerOnInstantLayer: boolean
	registerOnSymmioCore: boolean
}

class SubgraphRequestError extends Error {
	status?: number
	retriable: boolean

	constructor(message: string, status?: number, retriable = false) {
		super(message)
		this.name = "SubgraphRequestError"
		this.status = status
		this.retriable = retriable
	}
}

const log = {
	header(title: string): void {
		console.log("")
		console.log("=".repeat(64))
		console.log(`  ${title}`)
		console.log("=".repeat(64))
	},
	info(message: string): void {
		console.log(`  ${message}`)
	},
	ok(message: string): void {
		console.log(`  OK ${message}`)
	},
	warn(message: string): void {
		console.warn(`  WARN ${message}`)
	},
	detail(message: string): void {
		console.log(`    - ${message}`)
	},
	kv(key: string, value: string): void {
		console.log(`  ${key.padEnd(22)} ${value}`)
	},
	blank(): void {
		console.log("")
	},
}

function parseList(value: string | string[] | undefined): string[] | undefined {
	if (!value) return undefined
	const values = Array.isArray(value) ? value : value.split(",")
	const parsed = values.map(v => v.trim()).filter(Boolean)
	return parsed.length > 0 ? parsed : undefined
}

function discoverChains(): string[] {
	if (!fs.existsSync(CONFIG_DIR)) throw new Error(`Config directory not found: ${CONFIG_DIR}`)
	return fs
		.readdirSync(CONFIG_DIR)
		.map(file => file.match(/^upgrade-(.+)\.json$/)?.[1])
		.filter((chain): chain is string => !!chain)
		.sort()
}

function requestedChains(): string[] {
	const raw = process.env.SOLVER_CHAINS ?? process.env.CHAINS ?? process.env.CHAIN ?? process.env.NETWORK
	if (!raw || raw.trim().toLowerCase() === "all") return discoverChains()
	return parseList(raw) ?? []
}

function loadUpgradeConfig(chain: string): UpgradeConfig {
	const file = path.join(CONFIG_DIR, `upgrade-${chain}.json`)
	if (!fs.existsSync(file)) throw new Error(`Upgrade config not found for ${chain}: ${file}`)
	return JSON.parse(fs.readFileSync(file, "utf-8")) as UpgradeConfig
}

function resolveEndpoints(chain: string, config: UpgradeConfig, selectedChainCount: number): string[] | undefined {
	const envEndpoints = parseList(process.env.SUBGRAPH_ENDPOINTS) ?? parseList(process.env.SUBGRAPH_ENDPOINT)
	if (envEndpoints) {
		if (selectedChainCount !== 1) {
			throw new Error("SUBGRAPH_ENDPOINT(S) override requires exactly one selected chain. Set SOLVER_CHAINS=<chain>.")
		}
		log.warn(`Using SUBGRAPH_ENDPOINT override for ${chain}`)
		return envEndpoints
	}
	return parseList(config.subgraphEndpoints) ?? parseList(config.subgraphEndpoint)
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === "") return fallback
	const normalized = value.trim().toLowerCase()
	if (["true", "1", "yes", "y"].includes(normalized)) return true
	if (["false", "0", "no", "n"].includes(normalized)) return false
	throw new Error(`Invalid boolean value: ${value}`)
}

function subgraphPageSize(): number {
	return parsePositiveInt(process.env.SUBGRAPH_PAGE_SIZE, DEFAULT_PAGE_SIZE)
}

function subgraphTimeoutMs(): number {
	return parsePositiveInt(process.env.SUBGRAPH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
}

function maxSubgraphRetries(): number {
	return parsePositiveInt(process.env.SUBGRAPH_MAX_RETRIES, DEFAULT_MAX_RETRIES)
}

function subgraphRetryDelayMs(): number {
	return parsePositiveInt(process.env.SUBGRAPH_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS)
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeSubgraphEndpoints(endpointInput: SubgraphEndpointInput): string[] {
	const rawEndpoints = Array.isArray(endpointInput) ? endpointInput : endpointInput.split(",")
	const endpoints = rawEndpoints.map(endpoint => endpoint.trim()).filter(Boolean)
	if (endpoints.length === 0) throw new Error("At least one subgraph endpoint is required.")
	return endpoints
}

function isRetriableStatus(status: number): boolean {
	return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function isRetriableGraphQLError(errors: unknown): boolean {
	const serialized = JSON.stringify(errors).toLowerCase()
	return (
		serialized.includes("store error") ||
		serialized.includes("database unavailable") ||
		serialized.includes("connection") ||
		serialized.includes("timeout") ||
		serialized.includes("temporarily unavailable")
	)
}

function isRetriableError(error: unknown): boolean {
	if (error instanceof SubgraphRequestError) return error.retriable
	if (error instanceof Error && error.name === "AbortError") return true
	return error instanceof TypeError
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message
	return String(error)
}

function asError(error: unknown): Error {
	if (error instanceof Error) return error
	return new Error(String(error))
}

async function requestGraphQL(endpoint: string, query: string): Promise<any> {
	const controller = new AbortController()
	const timeoutMs = subgraphTimeoutMs()
	const timeout = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
			signal: controller.signal,
		})
		if (!response.ok) {
			throw new SubgraphRequestError(
				`Subgraph request failed: ${response.status} ${response.statusText}`,
				response.status,
				isRetriableStatus(response.status),
			)
		}
		const json = await response.json()
		if (json.errors) {
			throw new SubgraphRequestError(`Subgraph query error: ${JSON.stringify(json.errors)}`, undefined, isRetriableGraphQLError(json.errors))
		}
		return json.data
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new SubgraphRequestError(`Subgraph request timed out after ${timeoutMs}ms: ${endpoint}`, undefined, true)
		}
		if (error instanceof TypeError) {
			throw new SubgraphRequestError(`Subgraph request failed before response from ${endpoint}: ${error.message}`, undefined, true)
		}
		throw error
	} finally {
		clearTimeout(timeout)
	}
}

async function fetchGraphQL(endpointInput: SubgraphEndpointInput, query: string): Promise<any> {
	const endpoints = normalizeSubgraphEndpoints(endpointInput)
	const maxAttempts = maxSubgraphRetries() + 1
	let lastError: unknown

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		for (let i = 0; i < endpoints.length; i++) {
			try {
				return await requestGraphQL(endpoints[i], query)
			} catch (error) {
				lastError = error
				if (!isRetriableError(error)) throw asError(error)
				if (i < endpoints.length - 1) {
					log.detail(`Subgraph endpoint ${i + 1}/${endpoints.length} failed: ${errorMessage(error)}; trying next endpoint`)
				}
			}
		}

		if (attempt >= maxAttempts) throw asError(lastError)

		const delayMs = subgraphRetryDelayMs() * attempt
		log.detail(`All subgraph endpoints failed (${attempt}/${maxAttempts - 1}): ${errorMessage(lastError)}; retrying in ${delayMs}ms`)
		await sleep(delayMs)
	}

	throw asError(lastError)
}

function isAddress(value: string): boolean {
	return /^0x[a-fA-F0-9]{40}$/.test(value)
}

async function fetchSolvers(endpointInput: SubgraphEndpointInput): Promise<SubgraphSolver[]> {
	const allEntities: SubgraphSymmioEntity[] = []
	let lastId = ""
	let page = 0
	const pageSize = subgraphPageSize()

	while (true) {
		page++
		const cursor = lastId || "<start>"
		const whereClause = lastId ? `{ id_gt: "${lastId}" }` : `{}`
		log.detail(`symmioEntities page ${page}: cursor>${cursor}, pageSize=${pageSize}`)

		const data = await fetchGraphQL(
			endpointInput,
			`{
				symmioEntities(
					first: ${pageSize}
					where: ${whereClause}
					orderBy: id
					orderDirection: asc
				) {
					id
					type
					name
				}
			}`,
		)
		const entities = (data.symmioEntities ?? []) as SubgraphSymmioEntity[]
		allEntities.push(...entities)

		const nextCursor = entities.length > 0 ? entities[entities.length - 1].id : cursor
		log.detail(`symmioEntities page ${page}: fetched=${entities.length}, total=${allEntities.length}, nextCursor=${nextCursor}`)
		if (entities.length < pageSize) break
		lastId = nextCursor
	}

	return allEntities
		.filter(entity => entity.type === "Solver")
		.map(entity => ({
			id: entity.id,
			type: "Solver" as const,
			name: entity.name ?? "",
		}))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

function groupSolversForPartyBList(chain: string, solvers: SubgraphSolver[]): Record<string, string[]> {
	const grouped: Record<string, string[]> = {}
	const seen = new Set<string>()

	for (const solver of solvers) {
		if (!isAddress(solver.id)) {
			log.warn(`${chain}: skipping Solver with non-address id for partyBList: ${solver.id}`)
			continue
		}
		const address = solver.id
		const normalized = address.toLowerCase()
		if (seen.has(normalized)) continue
		seen.add(normalized)

		const label = solver.name?.trim() || "Unnamed Solver"
		grouped[label] = grouped[label] ?? []
		grouped[label].push(address)
	}

	return Object.fromEntries(Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)))
}

function ensureOutputDir(): void {
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
}

function writeJson(file: string, value: unknown): void {
	ensureOutputDir()
	fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function writePartyBList(chain: string, endpoints: string[], solvers: SubgraphSolver[]): string {
	const partyBs = groupSolversForPartyBList(chain, solvers)
	const output: PartyBListOutput = {
		generatedAt: new Date().toISOString(),
		source: {
			chain,
			subgraphEndpoints: endpoints,
			solverCount: solvers.length,
		},
		partyBs,
		registerOnInstantLayer: parseBool(process.env.REGISTER_ON_INSTANT_LAYER, DEFAULT_REGISTER_ON_INSTANT_LAYER),
		registerOnSymmioCore: parseBool(process.env.REGISTER_ON_SYMMIO_CORE, DEFAULT_REGISTER_ON_SYMMIO_CORE),
	}
	const outputFile = path.join(CONFIG_DIR, `partyBList-${chain}.json`)
	fs.writeFileSync(outputFile, JSON.stringify(output, null, 2))
	return outputFile
}

async function fetchChainSolvers(chain: string, selectedChainCount: number): Promise<ChainSolverOutput | undefined> {
	const config = loadUpgradeConfig(chain)
	const endpoints = resolveEndpoints(chain, config, selectedChainCount)
	if (!endpoints || endpoints.length === 0) {
		log.warn(`${chain}: no subgraph endpoint configured; skipping`)
		return undefined
	}

	log.header(`Fetch Solver Entities: ${chain}`)
	log.kv("Subgraph endpoints", String(endpoints.length))
	endpoints.forEach((endpoint, i) => log.detail(`${i + 1}. ${endpoint}`))

	const solvers = await fetchSolvers(endpoints as SubgraphEndpointInput)
	const output: ChainSolverOutput = {
		generatedAt: new Date().toISOString(),
		chain,
		subgraphEndpoints: endpoints,
		count: solvers.length,
		solvers,
	}

	const outputFile = path.join(OUTPUT_DIR, `solver-list-${chain}.json`)
	writeJson(outputFile, output)
	const partyBListFile = writePartyBList(chain, endpoints, solvers)

	log.ok(`Fetched ${solvers.length} Solver entities`)
	for (const solver of solvers) log.info(`  ${solver.name || "(unnamed)"}: ${solver.id}`)
	log.ok(`Output: ${outputFile}`)
	log.ok(`PartyB list: ${partyBListFile}`)
	log.info("generateSafeBatch.ts will pre-filter addresses that are already registered on Core or InstantLayer.")
	log.blank()

	return output
}

async function main() {
	const chains = requestedChains()
	if (chains.length === 0) throw new Error("No chains selected")

	log.info(`Chains: ${chains.join(", ")}`)
	log.blank()

	const all: AllChainsOutput = {
		generatedAt: new Date().toISOString(),
		chains: {},
	}

	for (const chain of chains) {
		const output = await fetchChainSolvers(chain, chains.length)
		if (output) all.chains[chain] = output
	}

	if (Object.keys(all.chains).length > 1) {
		const allFile = path.join(OUTPUT_DIR, "solver-list-all.json")
		writeJson(allFile, all)
		log.ok(`All-chain output: ${allFile}`)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
