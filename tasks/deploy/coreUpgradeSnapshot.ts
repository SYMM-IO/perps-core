import fs from "node:fs"

import { IMPLEMENTATION_SLOT } from "../../deployment-tooling/account-instant-upgrade.js"
import { digest } from "../../deployment-tooling/arbitrum-core-upgrade.js"
import { isStandardCoreInput, coreUpgradeAuthority, coreGovernanceKind, coreUpgradePolicies } from "../../deployment-tooling/core-upgrade-input.js"
import { captureMuonConfiguration } from "../../deployment-tooling/operations/muon-upgrade.js"
import { addFunding, calculateGroupFunding } from "../../scripts/utils/aggregateFundingResync.js"
import { json, lower, selectorsAt } from "./accountInstantSnapshot.js"
import { logger } from "./logger.js"

export const coreUpgradeABI = JSON.parse(fs.readFileSync(new URL("../../abis/symmio.json", import.meta.url), "utf8"))
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11"

/** getNextQuoteId() returns the last assigned ID; include it, and allow an empty Core. */
export function coreQuoteScanIds(lastId: bigint | number, maxQuotes: number) {
	const count = Number(lastId)
	if (!Number.isSafeInteger(count) || count < 0 || count > maxQuotes)
		throw new Error("Quote scan exceeds reviewed limit or has an invalid counter; no partial snapshot accepted")
	return Array.from({ length: count }, (_, i) => i + 1)
}

export function assertEmptySymbolAdjustment(returnData: string, upgraded: boolean, policy?: any) {
	const words = upgraded ? (policy?.upgradedAdjustmentWords ?? 17) : (policy?.legacyAdjustmentWords ?? 15)
	if (returnData.length !== 2 + words * 64 || !/^0x0+$/.test(returnData))
		throw new Error(
			`storage.symbolAdjustment: expected ${words} zero ABI words ${upgraded ? "after" : "before"} upgrade; nonzero or unexpected layout requires a separate storage migration`,
		)
}

/** Pin every read to one block and refuse incomplete scans. No signer is loaded. */
export async function captureCoreUpgradeSnapshot(ethers: any, config: any, upgraded = false, atBlock?: number, configurationOnly = false) {
	const t = config.target,
		owner = coreUpgradeAuthority(config),
		provider = ethers.provider
	const block = await provider.getBlock(atBlock ?? "latest")
	if (!block) throw new Error("Snapshot block unavailable")
	const assertCanonical = async () => {
		if ((await provider.getBlock(block.number))?.hash !== block.hash) throw new Error("Core snapshot block is no longer canonical")
	}
	const overrides = { blockTag: block.number }
	logger.info(`Core snapshot at block ${block.number}: checking ownership, roles and peripheral wiring`)
	const core = await ethers.getContractAt(coreUpgradeABI, t.core)
	const call = (name: string, args: any[] = []) => core[name](...args, overrides)
	const multicall = await ethers.getContractAt(
		["function aggregate3((address target,bool allowFailure,bytes callData)[]) payable returns ((bool success,bytes returnData)[])"],
		config.target.multicall || MULTICALL,
	)
	const batch = async (names: string[], args: any[][]) => {
		const results: any[] = []
		for (let offset = 0; offset < names.length; offset += 25) {
			const part = names.slice(offset, offset + 25)
			const rows = await multicall.aggregate3.staticCall(
				part.map((n, i) => [t.core, false, core.interface.encodeFunctionData(n, args[offset + i])]),
				overrides,
			)
			rows.forEach((row: any, i: number) => {
				if (!row.success) throw new Error(`Snapshot ${part[i]} failed`)
				const decoded = core.interface.decodeFunctionResult(part[i], row.returnData)
				results.push(decoded.length === 1 ? decoded[0] : decoded)
			})
		}
		return results
	}
	const preserved: any = {}
	for (const name of [
		"getOwner",
		"pendingOwner",
		"getCollateral",
		"getSignatureVerifier",
		"isAccumulatedFundingActivated",
		"isLegacyFundingDeprecated",
		"isLegacyPartyALiquidationDeprecated",
		"isLegacyDeallocateDeprecated",
	])
		preserved[name] = await call(name)
	for (const [name, expected] of [
		["getOwner", owner],
		["pendingOwner", ethers.ZeroAddress],
		["getCollateral", t.collateral],
		["getSignatureVerifier", t.signatureVerifier],
	])
		if (lower(preserved[name]) !== lower(expected)) throw new Error(`Unexpected Core ${name}`)
	if (!preserved.isAccumulatedFundingActivated) throw new Error("This upgrade requires accumulated funding already enabled")
	for (const role of ["DEFAULT_ADMIN_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE"])
		if (!(await call("hasRole", [owner, ethers.id(role)]))) throw new Error(`Core governance owner lacks ${role}`)
	const roles = {
		migration: await call("hasRole", [owner, ethers.id("MIGRATION_ROLE")]),
		listing: await call("hasRole", [t.symbolManager, ethers.id("SYMBOL_LISTING_ROLE")]),
	}
	if (!(await call("hasRole", [t.symbolManager, ethers.id("SYMBOL_MANAGER_ROLE")]))) throw new Error("Symbol Manager identity/role changed")
	const pause = Array.from(await call("pauseState"))
	const wiring: any = {}
	for (const [label, artifact, address, getters] of [
		["account", "AccountLayerViewFacet", t.accountLayer, ["getOwner", "pendingOwner", "paused"]],
		["instant", "InstantLayer", t.instantLayer, ["symmio", "accountLayer", "transientContextEnabled", "getNextTemplateId"]],
		["gasless", "GaslessLayer", t.gaslessLayer, ["core", "collateralToken", "accountLayer", "instantLayer", "treasury"]],
		["partyB", "SymmioPartyB", t.partyB, ["symmioAddress"]],
	] as any[]) {
		// The AccountLayer owner ABI lives on a different facet of the same diamond.
		const abi =
			label === "account"
				? ["function getOwner() view returns(address)", "function pendingOwner() view returns(address)", "function paused() view returns(bool)"]
				: artifact
		const contract = await ethers.getContractAt(abi, address)
		for (const name of getters) wiring[`${label}.${name}`] = await contract[name](overrides)
	}
	for (const [key, expected] of Object.entries({
		"account.getOwner": isStandardCoreInput(config) ? config.governance.accountLayerOwner : owner,
		"account.pendingOwner": ethers.ZeroAddress,
		"instant.symmio": t.core,
		"instant.accountLayer": t.accountLayer,
		"gasless.core": t.core,
		"gasless.collateralToken": t.collateral,
		"gasless.accountLayer": t.accountLayer,
		"gasless.instantLayer": t.instantLayer,
		"gasless.treasury": t.gaslessReceiver,
		"partyB.symmioAddress": t.core,
	}))
		if (lower(wiring[key]) !== lower(expected as string)) throw new Error(`Peripheral wiring changed: ${key}`)
	const account = await ethers.getContractAt(["function hasRole(address,bytes32) view returns(bool)"], t.accountLayer)
	const instant = await ethers.getContractAt("InstantLayer", t.instantLayer)
	const partyB = await ethers.getContractAt("SymmioPartyB", t.partyB)
	for (const name of ["SIGNER_SETTER_ROLE", "INSTANT_LAYER_ROLE"]) {
		const held = await account.hasRole(t.instantLayer, ethers.id(name), overrides)
		wiring[`account.instant.${name}`] = held
		// Signer methods are gated by SIGNER_SETTER_ROLE. The declared INSTANT_LAYER_ROLE
		// is not an execution prerequisite; preserve its observed value instead.
		if (name === "SIGNER_SETTER_ROLE" && !held) throw new Error(`AccountLayer missing ${name}`)
	}
	if (!(await account.hasRole(t.gaslessLayer, ethers.id("ACCOUNT_CREATOR_ROLE"), overrides))) throw new Error("Gasless lacks account creation role")
	for (const address of [t.gaslessLayer, t.partyB])
		if (!(await instant.hasRole(ethers.id("OPERATOR_ROLE"), address, overrides))) throw new Error("InstantLayer operator wiring changed")
	if (!(await partyB.hasRole(ethers.id("TRUSTED_ROLE"), t.instantLayer, overrides)) || !(await partyB.multicastWhitelist(t.instantLayer, overrides)))
		throw new Error("PartyB InstantLayer wiring changed")
	for (const [address, role] of [
		[t.instantLayer, "INSTANT_LAYER_ROLE"],
		[t.liquidator, "LIQUIDATOR_ROLE"],
	])
		if (!(await call("hasRole", [address, ethers.id(role)]))) throw new Error(`Core missing ${role}`)
	if (!(await call("isOperationalFeeCharger", [t.gaslessLayer]))) throw new Error("Gasless fee charger wiring changed")
	if (coreGovernanceKind(config) === "safe") {
		const safe = await ethers.getContractAt(["function getOwners() view returns(address[])", "function getThreshold() view returns(uint256)"], owner)
		wiring.safeOwners = Array.from(await safe.getOwners(overrides))
			.map(a => lower(a as string))
			.sort()
		wiring.safeThreshold = await safe.getThreshold(overrides)
	} else if ((await provider.getCode(owner, block.number)) !== "0x") throw new Error("Configured EOA owner has contract code")
	wiring.accountSelectors = await selectorsAt(ethers, t.accountLayer, block.number)
	const plannedRoles: any[] = []
	for (const grant of config.roleGrants || []) plannedRoles.push({ ...grant, held: await call("hasRole", [grant.holder, ethers.id(grant.role)]) })
	if (isStandardCoreInput(config)) {
		for (const [holder, role] of [
			[owner, "GLOBAL_PAUSER_ROLE"],
			[t.symbolManager, "SYMBOL_LISTING_ROLE"],
		])
			if (!(await call("hasRole", [holder, ethers.id(role)])) && !plannedRoles.some(g => lower(g.holder) === lower(holder) && g.role === role))
				throw new Error(`Input must explicitly plan the missing ${role} grant for ${holder}`)
	}
	const code: any = {}
	for (const [name, item] of Object.entries(config.inventory || {}) as [string, any][]) {
		if (item.kind === "subgraph") continue
		const runtime = await provider.getCode(item.address, block.number)
		if (item.kind === "contract" && runtime === "0x") throw new Error(`No code at inventory ${name}`)
		code[`inventory.${name}`] = ethers.keccak256(runtime)
	}
	for (const [name, address] of Object.entries(t) as [string, string][]) {
		if (name === "gaslessReceiver") continue
		const runtime = await provider.getCode(address, block.number)
		if (runtime === "0x") throw new Error(`No code at ${name}`)
		code[name] = ethers.keccak256(runtime)
	}
	for (const name of ["gaslessLayer", "liquidator", "partyB"]) {
		const value = await provider.getStorage(t[name], IMPLEMENTATION_SLOT, block.number)
		const impl = "0x" + value.slice(-40)
		if (impl === ethers.ZeroAddress) throw new Error(`Missing ${name} implementation`)
		code[`${name}.implementation`] = [impl, ethers.keccak256(await provider.getCode(impl, block.number))]
	}
	for (const address of new Set(Object.values(wiring.accountSelectors) as string[]))
		code[address] = ethers.keccak256(await provider.getCode(address, block.number))
	const selectors = await selectorsAt(ethers, t.core, block.number)
	const muon = await captureMuonConfiguration(
		provider,
		{
			schemaVersion: 1,
			kind: "symmio.muon-upgrade-profile",
			chainId: Number((await provider.getNetwork()).chainId),
			core: { address: t.core, codeHash: code.core },
			verifier: { address: t.signatureVerifier, codeHash: code.signatureVerifier },
			policy: config.muon || {},
		},
		{ blockNumber: block.number, blockHash: block.hash },
	)
	const facetCode: any = {}
	for (const address of new Set(Object.values(selectors))) facetCode[address] = ethers.keccak256(await provider.getCode(address, block.number))
	if (configurationOnly) {
		await assertCanonical()
		return json({ plannedRoles, blockNumber: block.number, blockHash: block.hash, preserved, wiring, code, facetCode, selectors, pause, roles, muon })
	}

	const next = Number(await call("getNextQuoteId"))
	const ids = coreQuoteScanIds(next, config.limits.maxQuotes)
	logger.info(`Reading all ${ids.length} historical quotes for storage and funding preservation`)
	const quotes = await batch(
		ids.map(() => "getQuote"),
		ids.map(id => [id]),
	)
	quotes.forEach((q, i) => {
		if (Number(q.id) !== ids[i]) throw new Error("Missing historical quote")
	})
	const symbols: any[] = []
	for (let start = 0; ; start += 100) {
		const page = await call("getSymbols", [start, 100])
		symbols.push(...page)
		if (symbols.length > config.limits.maxSymbols) throw new Error("Symbol scan exceeds reviewed limit")
		if (page.length < 100) break
	}
	// The old tuple is 15 static words; current is 17. Requiring every raw word
	// to be zero protects the inserted fields as well as the changed return ABI.
	for (let start = 0; start < symbols.length; start += 25) {
		const part = symbols.slice(start, start + 25)
		const rows = await multicall.aggregate3.staticCall(
			part.map(s => [t.core, false, core.interface.encodeFunctionData("getSymbolAdjustment", [s.symbolId])]),
			overrides,
		)
		for (const row of rows) {
			if (!row.success) throw new Error("SymbolAdjustment call failed")
			assertEmptySymbolAdjustment(row.returnData, upgraded, coreUpgradePolicies(config).storage.symbolAdjustment)
		}
	}
	const restatements = await batch(
		symbols.map(() => "getRestatementState"),
		symbols.map(s => [s.symbolId]),
	)
	if (restatements.some(r => r[0])) throw new Error("An active restatement blocks this upgrade")
	const parties = [...new Set(quotes.map(q => lower(q.partyA)))].sort()
	const liquidations = await batch(
		parties.map(() => "isPartyALiquidated"),
		parties.map(a => [a]),
	)
	if (liquidations.some(Boolean)) throw new Error("An active PartyA liquidation blocks this upgrade")
	const balances = await batch(
		parties.flatMap(() => ["balanceOf", "allocatedBalanceOfPartyA"]),
		parties.flatMap(a => [[a], [a]]),
	)
	const groups = new Map<string, any>(),
		pairs = new Map<string, any>()
	for (const q of quotes) {
		if (lower(q.partyB) === ethers.ZeroAddress) continue
		const group = { partyA: lower(q.partyA), partyB: lower(q.partyB), symbolId: q.symbolId, positionType: Number(q.positionType) }
		groups.set([group.partyA, group.partyB, group.symbolId, group.positionType].join(":"), group)
		pairs.set(`${group.partyA}:${group.partyB}`, { partyA: group.partyA, partyB: group.partyB })
	}
	const funding: any[] = [],
		globals = new Map<string, any>(),
		pairBalances: any[] = []
	const pairList = [...pairs.values()]
	const partyBLiquidations = await batch(
		pairList.map(() => "isPartyBLiquidated"),
		pairList.map(p => [p.partyB, p.partyA]),
	)
	const partyBs = [...new Set([lower(t.partyB), ...pairList.map(p => p.partyB)])]
	const crossLiquidations = await batch(
		partyBs.map(() => "getPartyBCrossLiquidationStatus"),
		partyBs.map(b => [b]),
	)
	if (partyBLiquidations.some(Boolean) || crossLiquidations.some(Boolean)) throw new Error("An active PartyB liquidation blocks this upgrade")
	logger.info(`Checking ${symbols.length} empty symbol adjustments and ${pairs.size} historical trading pairs`)
	for (const pair of pairs.values()) {
		const expectedOpen = quotes.filter(
			q => lower(q.partyA) === pair.partyA && lower(q.partyB) === pair.partyB && [4, 5, 6].includes(Number(q.quoteStatus)),
		)
		const count = Number(await call("partyBPositionsCount", [pair.partyB, pair.partyA]))
		if (count !== expectedOpen.length) throw new Error("Open position count disagrees with full quote scan")
		const open: any[] = []
		for (let start = 0; start < count; start += 50) open.push(...(await call("getPartyBOpenPositions", [pair.partyB, pair.partyA, start, 50])))
		if (digest(open.map(q => String(q.id)).sort()) !== digest(expectedOpen.map(q => String(q.id)).sort()))
			throw new Error("Open position enumeration differs")
		pairBalances.push([pair, await call("allocatedBalanceOfPartyB", [pair.partyB, pair.partyA])])
		for (const group of groups.values()) {
			if (group.partyA !== pair.partyA || group.partyB !== pair.partyB) continue
			const expected = calculateGroupFunding(open, group.symbolId, group.positionType)
			const a = await call("getPartyAAggregatedFundingPerPartyB", [group.partyA, group.partyB, group.symbolId, group.positionType])
			const b = await call("getPartyBAggregatedFundingPerPartyA", [group.partyB, group.partyA, group.symbolId, group.positionType])
			funding.push({ ...group, expected, a, b })
			const key = `${group.partyB}:${group.symbolId}:${group.positionType}`
			const global = globals.get(key) || {
				partyB: group.partyB,
				symbolId: group.symbolId,
				positionType: group.positionType,
				expected: 0n,
				pairTotal: 0n,
			}
			global.expected = addFunding(global.expected, expected)
			global.pairTotal = addFunding(global.pairTotal, b)
			globals.set(key, global)
		}
	}
	for (const g of globals.values()) {
		g.stored = await call("getPartyBAggregatedFunding", [g.partyB, g.symbolId, g.positionType])
		if (g.stored !== g.pairTotal) throw new Error("Global aggregate funding differs from pair totals; separate investigation required")
	}
	await assertCanonical()
	return json({
		plannedRoles,
		blockNumber: block.number,
		blockHash: block.hash,
		preserved,
		wiring,
		code,
		facetCode,
		selectors,
		pause,
		roles,
		muon,
		economy: { next, quotes, symbols, parties, balances, pairBalances, restatements },
		funding,
		globals: [...globals.values()],
	})
}

export function assertCoreSnapshotPreserved(before: any, after: any, upgraded = false, unpaused = false) {
	if (!before.muon?.configuration || !after.muon?.configuration) throw new Error("Missing Muon configuration evidence")
	if (digest(before.muon?.configuration) !== digest(after.muon?.configuration)) throw new Error("Core upgrade changed Muon configuration")
	for (const key of ["preserved", "wiring", "code", "economy"])
		if (digest(before[key]) !== digest(after[key])) throw new Error(`Core upgrade changed preserved ${key}`)
	const expectedPause = [...before.pause]
	expectedPause[0] = !unpaused
	if (digest(expectedPause) !== digest(after.pause)) throw new Error("Unexpected Core pause flags")
	if (after.roles.migration !== before.roles.migration) throw new Error("Temporary migration role was not restored")
	if (upgraded) {
		if ((after.plannedRoles || []).some((g: any) => !g.held)) throw new Error("Input role grants are incomplete")
		if (!after.roles.listing) throw new Error("Symbol Manager listing role missing")
		if (after.funding.some((g: any) => g.a !== g.expected || g.b !== g.expected) || after.globals.some((g: any) => g.stored !== g.expected))
			throw new Error("Aggregate funding reconciliation incomplete")
	} else
		for (const key of ["roles", "plannedRoles", "funding", "globals", "selectors", "facetCode"])
			if (digest(before[key] ?? []) !== digest(after[key] ?? [])) throw new Error(`Paused snapshot ${key} changed`)
}
