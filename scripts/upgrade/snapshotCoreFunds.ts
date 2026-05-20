import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, loadUpgradeConfigShared } from "./utils/sharedConfig.js"

/**
 * Snapshot live collateral held by a Symmio core diamond and the related core
 * accounting buckets. The subgraph is only used to discover account addresses;
 * balances are read from the chain.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/snapshotCoreFunds.ts --network coti
 *
 * Env vars:
 *   DIAMOND_ADDRESS              Override upgrade-<network>.json diamondAddress
 *   SUBGRAPH_ENDPOINT(S)         Override upgrade-<network>.json subgraphEndpoint(s)
 *   CORE_FUNDS_OUTPUT_FILE       Defaults to scripts/upgrade/output/core-funds-snapshot-<network>.json
 *   CORE_FUNDS_CONCURRENCY       On-chain read concurrency, default 6
 *   CORE_FUNDS_MAX_RETRIES       Retries per on-chain read, default 4
 *   CORE_FUNDS_PAGE_SIZE         Subgraph page size, default 1000
 *   CORE_FUNDS_SKIP_SUBGRAPH     Set true to only snapshot diamond + related address ERC20 balances
 *   ACCOUNT_LAYER_ADDRESS        Optional v8.5 AccountLayer override
 *   INSTANT_LAYER_ADDRESS        Optional v8.5 InstantLayer override
 */

const OUTPUT_DIR = "./scripts/upgrade/output"
const NETWORK_SUFFIX = baseNetworkName(connection.networkName)
const withSuffix = (baseName: string): string => (NETWORK_SUFFIX ? `${baseName}-${NETWORK_SUFFIX}.json` : `${baseName}.json`)
const DEFAULT_OUTPUT_FILE = path.join(OUTPUT_DIR, withSuffix("core-funds-snapshot"))

const ZERO_ADDRESS = ethers.ZeroAddress
const CORE_ACCOUNTING_DECIMALS = 18

type UpgradeConfig = ReturnType<typeof loadUpgradeConfigShared>
type BlockReadOptions = { blockTag: number }

type SubgraphAccount = {
	id: string
	account: string
	type: string | null
	isVirtual: boolean | null
}

type LatestAccountBalance = {
	id: string
	account: string
	accountType: "PARTY_A" | "PARTY_B" | string
	counterParty: string | null
}

type RelatedAddressBalance = {
	address: string
	labels: string[]
	isContract: boolean
	collateralRaw: string
	collateral: string
	nativeRaw: string
	native: string
}

type V085Snapshot = {
	accountLayerAddress?: string
	instantLayerAddress?: string
	accountLayerCollateral?: {
		raw: string
		formatted: string
	}
	instantLayerCollateral?: {
		raw: string
		formatted: string
	}
	coreWiring: {
		affiliateHookZero?: string
		isCallFromInstantLayer?: boolean
	}
	accountLayer?: {
		owner?: string
		pendingOwner?: string
		symmioFeeReceiver?: string
		coreWhitelisted?: boolean
	}
	instantLayer?: {
		accountLayer?: string
		coreWhitelisted?: boolean
		accountLayerWhitelisted?: boolean
	}
	note: string
}

type FormattedBucketTotals = {
	partyAAllocated: string
	partyBAllocated: string
	allocatedTotal: string
	partyALocked: string
	partyAPendingLocked: string
	partyBLocked: string
	partyBPendingLocked: string
	lockedAndPendingTotal: string
	freeWithdrawableKnownAccounts: string
	freePlusAllocatedTotal: string
}

type CollateralTotals = {
	diamond: {
		raw: string
		formatted: string
	}
	relatedExternal: {
		raw: string
		formatted: string
	}
	diamondPlusRelatedExternal: {
		raw: string
		formatted: string
	}
}

type BalanceSnapshot = {
	generatedAt: string
	network: {
		name: string
		suffix?: string
		chainId: number
		blockNumber: number
	}
	source: {
		diamondAddress: string
		upgradeConfigNetworkSuffix?: string
		subgraphEndpoints: string[]
	}
	collateral: {
		address: string
		symbol: string
		name: string
		decimals: number
	}
	actualCollateralInDiamond: {
		raw: string
		formatted: string
	}
	collateralTotals: CollateralTotals
	relatedAddressBalances: RelatedAddressBalance[]
	relatedNonZeroCollateralBalances: RelatedAddressBalance[]
	relatedExternalNonZeroCollateralBalances: RelatedAddressBalance[]
	v085?: V085Snapshot
	internalAccounting?: {
		unitDecimals: number
		unitNote: string
		accountCount: number
		latestAccountBalanceRows: {
			total: number
			partyA: number
			partyB: number
			partyBRowsRead: number
			partyBRowsUsedForLocked: number
		}
		totals: FormattedBucketTotals
		rawTotals: Record<keyof FormattedBucketTotals, string>
		topFreeBalances: Array<{ account: string; type: string | null; isVirtual: boolean | null; free: string; freeRaw: string }>
		topLockedBalances: Array<{
			account: string
			accountType: string
			counterParty: string | null
			lockedAndPending: string
			lockedAndPendingRaw: string
			allocated: string
			allocatedRaw: string
		}>
	}
}

function ensureParentDir(filePath: string): void {
	const dir = path.dirname(filePath)
	if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseBoolean(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "y"].includes(value.toLowerCase())
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function withRetry<T>(label: string, maxRetries: number, read: () => Promise<T>): Promise<T> {
	let attempt = 0
	let delay = 500
	while (true) {
		try {
			return await read()
		} catch (error) {
			attempt += 1
			if (attempt > maxRetries) throw error
			const message = error instanceof Error ? error.message : String(error)
			log.warn(`${label} failed (${message}); retry ${attempt}/${maxRetries} in ${delay}ms`)
			await sleep(delay)
			delay = Math.min(delay * 2, 8_000)
		}
	}
}

function parseEndpointList(value: unknown): string[] {
	if (value === undefined || value === null || value === "") return []
	const raw = Array.isArray(value) ? value : String(value).split(",")
	return raw.map(item => String(item).trim()).filter(Boolean)
}

function firstNonEmptyList(...lists: string[][]): string[] {
	return lists.find(list => list.length > 0) ?? []
}

function normalizeAddress(address: string): string {
	return ethers.getAddress(address)
}

function isZeroAddress(address: string | null | undefined): boolean {
	return !address || address.toLowerCase() === ZERO_ADDRESS.toLowerCase()
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as { toString(): string }).toString())
}

function formatUnits(value: bigint, decimals: number, precision = 6): string {
	const formatted = ethers.formatUnits(value, decimals)
	const [whole, fraction = ""] = formatted.split(".")
	const trimmed = fraction.padEnd(precision, "0").slice(0, precision).replace(/0+$/, "")
	return trimmed ? `${whole}.${trimmed}` : `${whole}.0`
}

function addRelatedAddress(map: Map<string, Set<string>>, label: string, value: unknown): void {
	if (typeof value !== "string" || !ethers.isAddress(value)) return
	const address = normalizeAddress(value)
	if (!map.has(address)) map.set(address, new Set())
	map.get(address)!.add(label)
}

function collectAddressesFromObject(map: Map<string, Set<string>>, prefix: string, value: unknown): void {
	if (!value || typeof value !== "object") return
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const label = prefix ? `${prefix}.${key}` : key
		if (typeof child === "string" && ethers.isAddress(child)) {
			addRelatedAddress(map, label, child)
		} else if (child && typeof child === "object") {
			collectAddressesFromObject(map, label, child)
		}
	}
}

function loadJsonIfExists<T>(filePath: string): T | undefined {
	if (!fs.existsSync(filePath)) return undefined
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

function nestedAddress(value: unknown, pathParts: string[]): string | undefined {
	let current: unknown = value
	for (const part of pathParts) {
		if (!current || typeof current !== "object") return undefined
		current = (current as Record<string, unknown>)[part]
	}
	return typeof current === "string" && ethers.isAddress(current) ? normalizeAddress(current) : undefined
}

async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let nextIndex = 0
	const lanes: Promise<void>[] = []
	const lane = async () => {
		while (true) {
			const i = nextIndex++
			if (i >= items.length) return
			results[i] = await worker(items[i], i)
		}
	}
	for (let i = 0; i < Math.max(1, Math.min(concurrency, items.length)); i++) lanes.push(lane())
	await Promise.all(lanes)
	return results
}

async function requestGraphQL(endpoint: string, query: string): Promise<any> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
	})
	if (!response.ok) throw new Error(`Subgraph request failed: ${response.status} ${response.statusText}`)
	const json = await response.json()
	if (json.errors) throw new Error(`Subgraph query error: ${JSON.stringify(json.errors)}`)
	return json.data
}

async function fetchGraphQL(endpoints: string[], query: string): Promise<any> {
	let lastError: unknown
	for (const endpoint of endpoints) {
		try {
			return await requestGraphQL(endpoint, query)
		} catch (error) {
			lastError = error
			log.warn(`Subgraph endpoint failed: ${endpoint} (${error instanceof Error ? error.message : String(error)})`)
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function fetchAccounts(endpoints: string[], pageSize: number): Promise<SubgraphAccount[]> {
	const accounts: SubgraphAccount[] = []
	let lastId = ""
	while (true) {
		const where = lastId ? `{ id_gt: "${lastId}" }` : `{}`
		const query = `{
			accounts(first: ${pageSize}, where: ${where}, orderBy: id, orderDirection: asc) {
				id
				account
				type
				isVirtual
			}
		}`
		const page = (await fetchGraphQL(endpoints, query)).accounts as SubgraphAccount[]
		accounts.push(...page)
		if (page.length < pageSize) break
		lastId = page[page.length - 1].id
	}

	const unique = new Map<string, SubgraphAccount>()
	for (const account of accounts) {
		const address = normalizeAddress(account.account)
		if (!unique.has(address)) unique.set(address, { ...account, account: address })
	}
	return [...unique.values()]
}

async function fetchLatestAccountBalances(endpoints: string[], pageSize: number): Promise<LatestAccountBalance[]> {
	const rows: LatestAccountBalance[] = []
	let lastId = ""
	while (true) {
		const where = lastId ? `{ id_gt: "${lastId}" }` : `{}`
		const query = `{
			latestAccountBalances(first: ${pageSize}, where: ${where}, orderBy: id, orderDirection: asc) {
				id
				account
				accountType
				counterParty
			}
		}`
		const page = (await fetchGraphQL(endpoints, query)).latestAccountBalances as LatestAccountBalance[]
		rows.push(...page)
		if (page.length < pageSize) break
		lastId = page[page.length - 1].id
	}
	return rows.map(row => ({
		...row,
		account: normalizeAddress(row.account),
		counterParty: row.counterParty ? normalizeAddress(row.counterParty) : null,
	}))
}

function lockedTotalForPartyA(info: readonly unknown[]): bigint {
	return toBigInt(info[1]) + toBigInt(info[2]) + toBigInt(info[3])
}

function pendingLockedTotalForPartyA(info: readonly unknown[]): bigint {
	return toBigInt(info[5]) + toBigInt(info[6]) + toBigInt(info[7])
}

function lockedTotalForPartyB(info: readonly unknown[]): bigint {
	return toBigInt(info[1]) + toBigInt(info[2]) + toBigInt(info[4])
}

function pendingLockedTotalForPartyB(info: readonly unknown[]): bigint {
	return toBigInt(info[5]) + toBigInt(info[6]) + toBigInt(info[8])
}

function choosePartyBRows(rows: LatestAccountBalance[]): LatestAccountBalance[] {
	const byPartyB = new Map<string, LatestAccountBalance[]>()
	for (const row of rows) {
		if (!byPartyB.has(row.account)) byPartyB.set(row.account, [])
		byPartyB.get(row.account)!.push(row)
	}

	const chosen: LatestAccountBalance[] = []
	for (const partyBRows of byPartyB.values()) {
		const aggregateRows = partyBRows.filter(row => isZeroAddress(row.counterParty))
		chosen.push(...(aggregateRows.length > 0 ? aggregateRows : partyBRows))
	}
	return chosen
}

async function buildRelatedAddressBalances(
	relatedAddresses: Map<string, Set<string>>,
	collateral: any,
	collateralDecimals: number,
	maxRetries: number,
	blockOptions: BlockReadOptions,
): Promise<RelatedAddressBalance[]> {
	return runWithConcurrency([...relatedAddresses.entries()], 12, async ([address, labels]) => {
		const [collateralBalance, nativeBalance, code] = await Promise.all([
			withRetry<bigint>(`collateral.balanceOf(${address})`, maxRetries, async () => toBigInt(await collateral.balanceOf(address, blockOptions))),
			withRetry<bigint>(`native balance(${address})`, maxRetries, async () =>
				toBigInt(await ethers.provider.getBalance(address, blockOptions.blockTag)),
			),
			withRetry<string>(`code(${address})`, maxRetries, () => ethers.provider.getCode(address, blockOptions.blockTag)),
		])
		return {
			address,
			labels: [...labels].sort(),
			isContract: code !== "0x",
			collateralRaw: collateralBalance.toString(),
			collateral: formatUnits(collateralBalance, collateralDecimals),
			nativeRaw: nativeBalance.toString(),
			native: ethers.formatEther(nativeBalance),
		}
	})
}

function resolveV085Addresses(shared: UpgradeConfig, peripherals: unknown): { accountLayerAddress?: string; instantLayerAddress?: string } {
	const accountLayerAddress =
		(process.env.ACCOUNT_LAYER_ADDRESS && ethers.isAddress(process.env.ACCOUNT_LAYER_ADDRESS)
			? normalizeAddress(process.env.ACCOUNT_LAYER_ADDRESS)
			: undefined) ??
		(shared.accountLayerDiamondAddress && ethers.isAddress(shared.accountLayerDiamondAddress)
			? normalizeAddress(shared.accountLayerDiamondAddress)
			: undefined) ??
		nestedAddress(peripherals, ["accountLayer", "diamond"])

	const instantLayerAddress =
		(process.env.INSTANT_LAYER_ADDRESS && ethers.isAddress(process.env.INSTANT_LAYER_ADDRESS)
			? normalizeAddress(process.env.INSTANT_LAYER_ADDRESS)
			: undefined) ??
		(shared.instantLayerAddress && ethers.isAddress(shared.instantLayerAddress) ? normalizeAddress(shared.instantLayerAddress) : undefined) ??
		nestedAddress(peripherals, ["instantLayer", "address"])

	return { accountLayerAddress, instantLayerAddress }
}

async function maybeRead<T>(read: () => Promise<T>): Promise<T | undefined> {
	try {
		return await read()
	} catch {
		return undefined
	}
}

async function snapshotV085(
	diamondAddress: string,
	diamond: any,
	collateral: any,
	collateralDecimals: number,
	accountLayerAddress: string | undefined,
	instantLayerAddress: string | undefined,
	maxRetries: number,
	blockOptions: BlockReadOptions,
): Promise<V085Snapshot | undefined> {
	if (!accountLayerAddress && !instantLayerAddress) return undefined

	const accountLayer = accountLayerAddress
		? await ethers.getContractAt(
				[
					"function owner() view returns (address)",
					"function pendingOwner() view returns (address)",
					"function symmioFeeReceiver() view returns (address)",
					"function isWhitelistedSymmioCore(address) view returns (bool)",
				],
				accountLayerAddress,
			)
		: undefined
	const instantLayer = instantLayerAddress
		? await ethers.getContractAt(
				["function accountLayer() view returns (address)", "function whitelistedTargets(address) view returns (bool)"],
				instantLayerAddress,
			)
		: undefined

	const [accountLayerCollateralRaw, instantLayerCollateralRaw] = await Promise.all([
		accountLayerAddress
			? withRetry<bigint>(`collateral.balanceOf(${accountLayerAddress})`, maxRetries, async () =>
					toBigInt(await collateral.balanceOf(accountLayerAddress, blockOptions)),
				)
			: Promise.resolve(undefined),
		instantLayerAddress
			? withRetry<bigint>(`collateral.balanceOf(${instantLayerAddress})`, maxRetries, async () =>
					toBigInt(await collateral.balanceOf(instantLayerAddress, blockOptions)),
				)
			: Promise.resolve(undefined),
	])

	const affiliateHookZero = await maybeRead(async () =>
		normalizeAddress(
			await withRetry<string>("core.getAffiliateHook(address0)", maxRetries, () => diamond.getAffiliateHook(ZERO_ADDRESS, blockOptions)),
		),
	)
	const isCallFromInstantLayer = await maybeRead(async () =>
		Boolean(await withRetry<boolean>("core.isCallFromInstantLayer", maxRetries, () => diamond.isCallFromInstantLayer(blockOptions))),
	)

	return {
		accountLayerAddress,
		instantLayerAddress,
		accountLayerCollateral:
			accountLayerCollateralRaw !== undefined
				? {
						raw: accountLayerCollateralRaw.toString(),
						formatted: formatUnits(accountLayerCollateralRaw, collateralDecimals),
					}
				: undefined,
		instantLayerCollateral:
			instantLayerCollateralRaw !== undefined
				? {
						raw: instantLayerCollateralRaw.toString(),
						formatted: formatUnits(instantLayerCollateralRaw, collateralDecimals),
					}
				: undefined,
		coreWiring: {
			affiliateHookZero,
			isCallFromInstantLayer,
		},
		accountLayer: accountLayer
			? {
					owner: await maybeRead(async () => normalizeAddress(await accountLayer.owner(blockOptions))),
					pendingOwner: await maybeRead(async () => normalizeAddress(await accountLayer.pendingOwner(blockOptions))),
					symmioFeeReceiver: await maybeRead(async () => normalizeAddress(await accountLayer.symmioFeeReceiver(blockOptions))),
					coreWhitelisted: await maybeRead(async () => Boolean(await accountLayer.isWhitelistedSymmioCore(diamondAddress, blockOptions))),
				}
			: undefined,
		instantLayer: instantLayer
			? {
					accountLayer: await maybeRead(async () => normalizeAddress(await instantLayer.accountLayer(blockOptions))),
					coreWhitelisted: await maybeRead(async () => Boolean(await instantLayer.whitelistedTargets(diamondAddress, blockOptions))),
					accountLayerWhitelisted: accountLayerAddress
						? await maybeRead(async () => Boolean(await instantLayer.whitelistedTargets(accountLayerAddress, blockOptions)))
						: undefined,
				}
			: undefined,
		note: "AccountLayer and InstantLayer are peripheral routers. User/sub/virtual account margin is still accounted on the Symmio core diamond under those account addresses; this section reports peripheral contract balances and wiring separately to avoid double counting.",
	}
}

async function addRuntimeCoreRelatedAddresses(
	relatedAddresses: Map<string, Set<string>>,
	diamond: any,
	blockOptions: BlockReadOptions,
): Promise<void> {
	const runtimeReads: Array<[string, () => Promise<unknown>]> = [
		["core.getCollateral.token", () => diamond.getCollateral(blockOptions)],
		["core.getDefaultFeeCollector", () => diamond.getDefaultFeeCollector(blockOptions)],
		["core.getInvalidBridgedAmountsPool", () => diamond.getInvalidBridgedAmountsPool(blockOptions)],
		["core.getLiquidationInsuranceVaultParams.vault", async () => (await diamond.getLiquidationInsuranceVaultParams(blockOptions))[0]],
		["core.getAffiliateHook.address0", () => diamond.getAffiliateHook(ZERO_ADDRESS, blockOptions)],
		["core.owner", () => diamond.owner(blockOptions)],
		["core.pendingOwner", () => diamond.pendingOwner(blockOptions)],
	]

	for (const [label, read] of runtimeReads) {
		try {
			addRelatedAddress(relatedAddresses, label, await read())
		} catch {
			// Some pre-upgrade diamonds do not expose every view selector.
		}
	}
}

async function snapshotInternalAccounting(
	diamond: any,
	subgraphEndpoints: string[],
	pageSize: number,
	concurrency: number,
	maxRetries: number,
	accountingDecimals: number,
	blockOptions: BlockReadOptions,
): Promise<BalanceSnapshot["internalAccounting"]> {
	const [accounts, latestRows] = await Promise.all([
		fetchAccounts(subgraphEndpoints, pageSize),
		fetchLatestAccountBalances(subgraphEndpoints, pageSize),
	])

	let freeWithdrawableKnownAccounts = 0n
	const freeRows = await runWithConcurrency(accounts, concurrency, async account => {
		const free = await withRetry<bigint>(`core.balanceOf(${account.account})`, maxRetries, async () =>
			toBigInt(await diamond.balanceOf(account.account, blockOptions)),
		)
		freeWithdrawableKnownAccounts += free
		return { account: account.account, type: account.type, isVirtual: account.isVirtual, free }
	})

	let partyAAllocated = 0n
	let partyBAllocated = 0n
	let partyALocked = 0n
	let partyAPendingLocked = 0n
	let partyBLocked = 0n
	let partyBPendingLocked = 0n
	const lockedRows: Array<{ account: string; accountType: string; counterParty: string | null; lockedAndPending: bigint; allocated: bigint }> = []

	const partyARows = latestRows.filter(row => row.accountType === "PARTY_A")
	const partyBRows = latestRows.filter(row => row.accountType === "PARTY_B")
	const partyBRowsUsedForLocked = choosePartyBRows(partyBRows)
	const partyBLockedRowIds = new Set(partyBRowsUsedForLocked.map(row => row.id))

	await runWithConcurrency(partyARows, concurrency, async row => {
		const info = await withRetry<readonly unknown[]>(`core.balanceInfoOfPartyA(${row.account})`, maxRetries, async () =>
			diamond.balanceInfoOfPartyA(row.account, blockOptions),
		)
		const allocated = toBigInt(info[0])
		const locked = lockedTotalForPartyA(info)
		const pendingLocked = pendingLockedTotalForPartyA(info)
		partyAAllocated += allocated
		partyALocked += locked
		partyAPendingLocked += pendingLocked
		const lockedAndPending = locked + pendingLocked
		if (lockedAndPending > 0n)
			lockedRows.push({ account: row.account, accountType: row.accountType, counterParty: null, lockedAndPending, allocated })
	})

	await runWithConcurrency(partyBRows, concurrency, async row => {
		const info = await withRetry<readonly unknown[]>(
			`core.balanceInfoOfPartyB(${row.account},${row.counterParty ?? ZERO_ADDRESS})`,
			maxRetries,
			async () =>
				isZeroAddress(row.counterParty)
					? diamond.balanceInfoOfCrossPartyB(row.account, blockOptions)
					: diamond.balanceInfoOfPartyB(row.account, row.counterParty, blockOptions),
		)
		const allocated = toBigInt(info[0])
		partyBAllocated += allocated
		if (!partyBLockedRowIds.has(row.id)) return

		const locked = lockedTotalForPartyB(info)
		const pendingLocked = pendingLockedTotalForPartyB(info)
		partyBLocked += locked
		partyBPendingLocked += pendingLocked
		const lockedAndPending = locked + pendingLocked
		if (lockedAndPending > 0n) {
			lockedRows.push({ account: row.account, accountType: row.accountType, counterParty: row.counterParty, lockedAndPending, allocated })
		}
	})

	const rawTotals = {
		partyAAllocated,
		partyBAllocated,
		allocatedTotal: partyAAllocated + partyBAllocated,
		partyALocked,
		partyAPendingLocked,
		partyBLocked,
		partyBPendingLocked,
		lockedAndPendingTotal: partyALocked + partyAPendingLocked + partyBLocked + partyBPendingLocked,
		freeWithdrawableKnownAccounts,
		freePlusAllocatedTotal: freeWithdrawableKnownAccounts + partyAAllocated + partyBAllocated,
	}

	freeRows.sort((a, b) => (a.free > b.free ? -1 : a.free < b.free ? 1 : 0))
	lockedRows.sort((a, b) => (a.lockedAndPending > b.lockedAndPending ? -1 : a.lockedAndPending < b.lockedAndPending ? 1 : 0))

	return {
		unitDecimals: accountingDecimals,
		unitNote:
			"Core balanceOf, allocated, locked, and pending buckets are stored in 18-decimal accounting units. Direct ERC20 balances in this file use the collateral token decimals.",
		accountCount: accounts.length,
		latestAccountBalanceRows: {
			total: latestRows.length,
			partyA: partyARows.length,
			partyB: partyBRows.length,
			partyBRowsRead: partyBRows.length,
			partyBRowsUsedForLocked: partyBRowsUsedForLocked.length,
		},
		totals: Object.fromEntries(
			Object.entries(rawTotals).map(([key, value]) => [key, formatUnits(value, accountingDecimals)]),
		) as FormattedBucketTotals,
		rawTotals: Object.fromEntries(Object.entries(rawTotals).map(([key, value]) => [key, value.toString()])) as Record<
			keyof FormattedBucketTotals,
			string
		>,
		topFreeBalances: freeRows
			.filter(row => row.free > 0n)
			.slice(0, 10)
			.map(row => ({
				account: row.account,
				type: row.type,
				isVirtual: row.isVirtual,
				free: formatUnits(row.free, accountingDecimals),
				freeRaw: row.free.toString(),
			})),
		topLockedBalances: lockedRows.slice(0, 10).map(row => ({
			account: row.account,
			accountType: row.accountType,
			counterParty: row.counterParty,
			lockedAndPending: formatUnits(row.lockedAndPending, accountingDecimals),
			lockedAndPendingRaw: row.lockedAndPending.toString(),
			allocated: formatUnits(row.allocated, accountingDecimals),
			allocatedRaw: row.allocated.toString(),
		})),
	}
}

async function main() {
	const scriptTimer = log.timer()
	await verifyRpc()

	const network = await ethers.provider.getNetwork()
	const chainId = Number(network.chainId)
	const block = await ethers.provider.getBlock("latest")
	if (!block) throw new Error("Failed to read latest block")
	const blockOptions: BlockReadOptions = { blockTag: block.number }

	const shared = loadUpgradeConfigShared(NETWORK_SUFFIX)
	const diamondAddress = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	if (!diamondAddress || !ethers.isAddress(diamondAddress)) throw new Error("DIAMOND_ADDRESS or upgrade config diamondAddress is required")

	const subgraphEndpoints = firstNonEmptyList(
		parseEndpointList(process.env.SUBGRAPH_ENDPOINTS),
		parseEndpointList(process.env.SUBGRAPH_ENDPOINT),
		parseEndpointList(shared.subgraphEndpoints),
		parseEndpointList(shared.subgraphEndpoint),
	)
	const outputFile = process.env.CORE_FUNDS_OUTPUT_FILE ?? DEFAULT_OUTPUT_FILE
	const concurrency = parsePositiveInt(process.env.CORE_FUNDS_CONCURRENCY, 6)
	const maxRetries = parsePositiveInt(process.env.CORE_FUNDS_MAX_RETRIES, 4)
	const pageSize = parsePositiveInt(process.env.CORE_FUNDS_PAGE_SIZE, 1000)
	const skipSubgraph = parseBoolean(process.env.CORE_FUNDS_SKIP_SUBGRAPH)

	log.header("Snapshot Symmio Core Funds")
	log.kv("Network", connection.networkName)
	log.kv("Network suffix", NETWORK_SUFFIX ?? "(none)")
	log.kv("Diamond", log.addr(diamondAddress))
	log.kv("Output", outputFile)
	log.kv("Concurrency", String(concurrency))
	log.kv("Max retries", String(maxRetries))
	if (!skipSubgraph) log.kv("Subgraph endpoints", subgraphEndpoints.length > 0 ? String(subgraphEndpoints.length) : "(none)")

	const diamond = await ethers.getContractAt(
		[
			"function getCollateral() view returns (address)",
			"function getDefaultFeeCollector() view returns (address)",
			"function getInvalidBridgedAmountsPool() view returns (address)",
			"function getLiquidationInsuranceVaultParams() view returns (address,uint256)",
			"function owner() view returns (address)",
			"function pendingOwner() view returns (address)",
			"function getAffiliateHook(address) view returns (address)",
			"function isCallFromInstantLayer() view returns (bool)",
			"function balanceOf(address) view returns (uint256)",
			"function balanceInfoOfPartyA(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
			"function balanceInfoOfPartyB(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
			"function balanceInfoOfCrossPartyB(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
		],
		diamondAddress,
	)

	const collateralAddress = normalizeAddress(await diamond.getCollateral(blockOptions))
	const collateral = await ethers.getContractAt(
		[
			"function balanceOf(address) view returns (uint256)",
			"function decimals() view returns (uint8)",
			"function symbol() view returns (string)",
			"function name() view returns (string)",
		],
		collateralAddress,
	)
	const [collateralBalance, collateralDecimals, collateralSymbol, collateralName] = await Promise.all([
		collateral.balanceOf(diamondAddress, blockOptions).then(toBigInt),
		collateral.decimals().then((value: bigint | number) => Number(value)),
		collateral.symbol().catch(() => "TOKEN"),
		collateral.name().catch(() => ""),
	])

	const relatedAddresses = new Map<string, Set<string>>()
	collectAddressesFromObject(relatedAddresses, "upgradeConfig", shared as UpgradeConfig)
	addRelatedAddress(relatedAddresses, "core.diamondAddress", diamondAddress)

	const peripheralsFile = path.join(OUTPUT_DIR, withSuffix("deployed-peripherals"))
	const peripherals = loadJsonIfExists<unknown>(peripheralsFile)
	if (peripherals) collectAddressesFromObject(relatedAddresses, "deployedPeripherals", peripherals)
	const { accountLayerAddress, instantLayerAddress } = resolveV085Addresses(shared, peripherals)
	addRelatedAddress(relatedAddresses, "v085.accountLayer", accountLayerAddress)
	addRelatedAddress(relatedAddresses, "v085.instantLayer", instantLayerAddress)
	await addRuntimeCoreRelatedAddresses(relatedAddresses, diamond, blockOptions)

	const relatedAddressBalances = await buildRelatedAddressBalances(relatedAddresses, collateral, collateralDecimals, maxRetries, blockOptions)
	const relatedNonZeroCollateralBalances = relatedAddressBalances.filter(row => BigInt(row.collateralRaw) > 0n)
	const externalCollateralTotalExclusions = new Set([normalizeAddress(diamondAddress).toLowerCase(), ZERO_ADDRESS.toLowerCase()])
	const relatedExternalNonZeroCollateralBalances = relatedNonZeroCollateralBalances.filter(
		row => !externalCollateralTotalExclusions.has(row.address.toLowerCase()),
	)
	const relatedExternalCollateralRaw = relatedExternalNonZeroCollateralBalances.reduce((sum, row) => sum + BigInt(row.collateralRaw), 0n)
	const v085 = await snapshotV085(
		diamondAddress,
		diamond,
		collateral,
		collateralDecimals,
		accountLayerAddress,
		instantLayerAddress,
		maxRetries,
		blockOptions,
	)

	let internalAccounting: BalanceSnapshot["internalAccounting"]
	if (!skipSubgraph && subgraphEndpoints.length > 0) {
		internalAccounting = await snapshotInternalAccounting(
			diamond,
			subgraphEndpoints,
			pageSize,
			concurrency,
			maxRetries,
			CORE_ACCOUNTING_DECIMALS,
			blockOptions,
		)
	} else if (!skipSubgraph) {
		log.warn("No subgraph endpoint configured; skipping internal account bucket snapshot.")
	}

	const snapshot: BalanceSnapshot = {
		generatedAt: new Date().toISOString(),
		network: {
			name: connection.networkName,
			suffix: NETWORK_SUFFIX,
			chainId,
			blockNumber: block.number,
		},
		source: {
			diamondAddress: normalizeAddress(diamondAddress),
			upgradeConfigNetworkSuffix: NETWORK_SUFFIX,
			subgraphEndpoints,
		},
		collateral: {
			address: collateralAddress,
			symbol: collateralSymbol,
			name: collateralName,
			decimals: collateralDecimals,
		},
		actualCollateralInDiamond: {
			raw: collateralBalance.toString(),
			formatted: formatUnits(collateralBalance, collateralDecimals),
		},
		collateralTotals: {
			diamond: {
				raw: collateralBalance.toString(),
				formatted: formatUnits(collateralBalance, collateralDecimals),
			},
			relatedExternal: {
				raw: relatedExternalCollateralRaw.toString(),
				formatted: formatUnits(relatedExternalCollateralRaw, collateralDecimals),
			},
			diamondPlusRelatedExternal: {
				raw: (collateralBalance + relatedExternalCollateralRaw).toString(),
				formatted: formatUnits(collateralBalance + relatedExternalCollateralRaw, collateralDecimals),
			},
		},
		relatedAddressBalances: relatedAddressBalances.sort((a, b) => a.address.localeCompare(b.address)),
		relatedNonZeroCollateralBalances: relatedNonZeroCollateralBalances.sort((a, b) =>
			BigInt(b.collateralRaw) === BigInt(a.collateralRaw) ? 0 : BigInt(b.collateralRaw) > BigInt(a.collateralRaw) ? 1 : -1,
		),
		relatedExternalNonZeroCollateralBalances: relatedExternalNonZeroCollateralBalances.sort((a, b) =>
			BigInt(b.collateralRaw) === BigInt(a.collateralRaw) ? 0 : BigInt(b.collateralRaw) > BigInt(a.collateralRaw) ? 1 : -1,
		),
		v085,
		internalAccounting,
	}

	ensureParentDir(outputFile)
	fs.writeFileSync(outputFile, JSON.stringify(snapshot, null, 2))

	log.stats([
		["Collateral", `${collateralSymbol} ${collateralAddress}`],
		["Diamond collateral", `${snapshot.actualCollateralInDiamond.formatted} ${collateralSymbol}`],
		["External related collateral", `${snapshot.collateralTotals.relatedExternal.formatted} ${collateralSymbol}`],
		["Diamond + external related", `${snapshot.collateralTotals.diamondPlusRelatedExternal.formatted} ${collateralSymbol}`],
		["Related non-zero balances", relatedNonZeroCollateralBalances.length],
	])
	if (internalAccounting) {
		log.stats([
			["Known accounts", internalAccounting.accountCount],
			["Free withdrawable", `${internalAccounting.totals.freeWithdrawableKnownAccounts} ${collateralSymbol}`],
			["Allocated total", `${internalAccounting.totals.allocatedTotal} ${collateralSymbol}`],
			["Locked + pending", `${internalAccounting.totals.lockedAndPendingTotal} ${collateralSymbol}`],
		])
	}
	if (v085) {
		log.stats([
			["AccountLayer", v085.accountLayerAddress ?? "(unset)"],
			["AccountLayer collateral", `${v085.accountLayerCollateral?.formatted ?? "(unread)"} ${collateralSymbol}`],
			["InstantLayer", v085.instantLayerAddress ?? "(unset)"],
			["InstantLayer collateral", `${v085.instantLayerCollateral?.formatted ?? "(unread)"} ${collateralSymbol}`],
		])
	}

	log.success("Core funds snapshot completed", [
		["Output", outputFile],
		["Duration", scriptTimer.fmt()],
	])
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
