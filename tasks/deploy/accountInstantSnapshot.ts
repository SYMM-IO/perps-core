import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
	digest,
	flowDiscovery,
	GASLESS_UINTS,
	GASLESS_BOOLS,
	GASLESS_LIBRARIES,
	BASELINE_GASLESS_LIBRARIES,
	WALLET_CREATION_FEE_SLOT,
	FEE_QUOTE_STORAGE_NAMESPACE,
	verifyGaslessStorageLayout,
	IMPLEMENTATION_SLOT,
} from "../../deployment-tooling/account-instant-upgrade.js"
import { assertRoundingRuntime } from "./arbitrumRoundingUpgrade.js"
import { logger } from "./logger.js"

export const lower = (address: string) => address.toLowerCase()
export const unique = (values: string[]) => [...new Set(values.map(lower))].sort()
export const json = (value: any) => JSON.parse(JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry)))
const roleNames = ["DEFAULT_ADMIN_ROLE", "CONFIG_ADMIN_ROLE", "RELAYER_ROLE", "SETTER_ROLE", "OPERATOR_ROLE", "REVOKER_ROLE"]
export const roleHash = (ethers: any, name: string) => (name === "DEFAULT_ADMIN_ROLE" ? ethers.ZeroHash : ethers.id(name))
export const diamondABI = [
	"function getOwner() view returns(address)",
	"function pendingOwner() view returns(address)",
	"function hasRole(address,bytes32) view returns(bool)",
	"function grantRole(address,bytes32)",
	"function revokeRole(address,bytes32)",
]

// Classify nested ethers/provider errors without copying URLs, credentials or payloads
// into the task journal. Only controlled categories and restricted codes are emitted.
function historyRpcFailure(error: any) {
	const entries = [error, error?.error, error?.info, error?.info?.error, error?.cause, error?.response]
	const detail = entries.map(e => [e?.message, e?.shortMessage, e?.responseStatus, e?.status, e?.code].join(" ")).join(" ")
	const codes = unique(entries.map(e => String(e?.code ?? e?.status ?? "")).filter(code => /^(-?\d{1,6}|[A-Z][A-Z_]{1,31})$/.test(code)))
	let category = "RPC request failed",
		split = false
	if (/\b429\b|rate.?limit|too many requests|request quota/i.test(detail)) category = "RPC rate limited; retry after the provider limit resets"
	else if (/\b40[13]\b|unauthori[sz]ed|forbidden|authentication|invalid api.?key/i.test(detail))
		category = "RPC access denied; check the configured credential reference"
	else if (/missing trie|pruned|historical.*(unavailable|not available)|metadata is not found|missing.*historical/i.test(detail))
		category = "historical data unavailable; use an RPC retaining the required history"
	else if (
		codes.includes("-32005") ||
		/block.{0,40}(range|limit)|range.{0,40}(block|limit|large|wide|exceed)|too many (results|logs)|response.{0,40}(size|large|limit)|query.{0,40}(limit|large|size)|timeout|timed out/i.test(
			detail,
		)
	) {
		category = "RPC block-range, result-size or timeout limit"
		split = true
	}
	return { split, message: `${category}${codes.length ? ` (codes: ${codes.join(", ").toUpperCase()})` : ""}` }
}

/** Never return partial history or move past a block range that could not be read. */
export async function discoverEvents(
	provider: any,
	address: string,
	topics: string[],
	block: number,
	deploymentTransaction?: string,
): Promise<any[]> {
	if (!Number.isSafeInteger(block) || block < 0) throw new Error("Invalid configuration snapshot block")
	let fromBlock = 0
	if (deploymentTransaction !== undefined) {
		if (!/^0x[0-9a-fA-F]{64}$/.test(deploymentTransaction)) throw new Error(`Invalid creation receipt transaction for ${address}`)
		let receipt, creationBlock
		try {
			receipt = await provider.getTransactionReceipt(deploymentTransaction)
			if (receipt && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= 0 && receipt.blockNumber <= block)
				creationBlock = await provider.getBlock(receipt.blockNumber)
		} catch (error) {
			throw new Error(`Cannot verify creation receipt for ${address}: ${historyRpcFailure(error).message}`)
		}
		if (
			!receipt ||
			receipt.status !== 1 ||
			receipt.to !== null ||
			lower(receipt.hash || "") !== lower(deploymentTransaction) ||
			lower(receipt.contractAddress || "") !== lower(address) ||
			!receipt.blockHash ||
			lower(creationBlock?.hash || "") !== lower(receipt.blockHash)
		)
			throw new Error(
				`Invalid or unavailable creation receipt for ${address}; discovery.deploymentTransactions must identify its successful direct creation on this chain before the snapshot`,
			)
		fromBlock = receipt.blockNumber
	}
	logger.info(`Reading configuration events for ${address}, blocks ${fromBlock}-${block}`)
	const logs: any[] = []
	let chunk = 50000
	while (fromBlock <= block) {
		const toBlock = Math.min(block, fromBlock + chunk - 1)
		try {
			logs.push(...(await provider.getLogs({ address, fromBlock, toBlock, topics: [topics] })))
		} catch (error) {
			const failure = historyRpcFailure(error)
			if (failure.split && toBlock > fromBlock) {
				chunk = Math.max(1, Math.floor((toBlock - fromBlock + 1) / 2))
				logger.info(`Reducing configuration event requests for ${address} to ${chunk} blocks`)
				continue
			}
			throw new Error(
				`Cannot read complete event history: eth_getLogs ${address}, blocks ${fromBlock}-${toBlock}: ${failure.message}. No empty or partial configuration was assumed`,
			)
		}
		fromBlock = toBlock + 1
	}
	return logs.sort((a: any, b: any) => a.blockNumber - b.blockNumber || a.index - b.index)
}

async function configurationEvents(ethers: any, address: string, topics: string[], block: number, discovery: any) {
	if (discovery.mode === "flow") return []
	let logs: any[]
	if (discovery._forkBlock !== undefined) {
		// EDR historical log scans can traverse the whole remote chain. Reuse the pinned
		// discovery evidence, then read every event produced by this isolated rehearsal.
		logs = [
			...(discovery._history[lower(address)] || []),
			...(block > discovery._forkBlock
				? await ethers.provider.getLogs({ address, topics: [topics], fromBlock: discovery._forkBlock + 1, toBlock: block })
				: []),
		]
	} else {
		const transaction = Object.entries(discovery.deploymentTransactions || {}).find(([target]) => lower(target) === lower(address))?.[1]
		logs = await discoverEvents(ethers.provider, address, topics, block, transaction as string | undefined)
	}
	discovery._recordEvents?.(lower(address), json(logs))
	return logs
}

async function roleSnapshot(
	ethers: any,
	contract: any,
	events: any[],
	block: number,
	enumerable: boolean,
	additionalRoles: string[] = [],
	explicitMembers?: string[],
) {
	const candidates = new Map<string, Set<string>>()
	for (const name of roleNames) candidates.set(roleHash(ethers, name), new Set((explicitMembers || []).map(lower)))
	for (const role of additionalRoles) candidates.set(role, new Set())
	for (const log of events) {
		let event
		try {
			event = contract.interface.parseLog(log)
		} catch {
			continue
		}
		if (!event || !["RoleGranted", "RoleRevoked", "RoleAdminChanged"].includes(event.name)) continue
		const role = lower(event.args.role)
		if (!candidates.has(role)) candidates.set(role, new Set())
		if (event.args.account) candidates.get(role)!.add(lower(event.args.account))
	}
	const result = []
	for (const [role, members] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
		if (enumerable && explicitMembers === undefined) {
			const count = Number(await contract.getRoleMemberCount(role, { blockTag: block }))
			for (let i = 0; i < count; i++) members.add(lower(await contract.getRoleMember(role, i, { blockTag: block })))
		}
		const active: string[] = []
		for (const member of [...members].sort()) if (await contract.hasRole(role, member, { blockTag: block })) active.push(member)
		const admin = lower(await contract.getRoleAdmin(role, { blockTag: block }))
		if (active.length || admin !== ethers.ZeroHash) result.push({ role, admin, members: active })
	}
	return result
}

export async function readInstantConfiguration(ethers: any, address: string, block: number, discovery: any = {}) {
	const contract = await ethers.getContractAt("InstantLayer", address)
	const topics = ["RoleGranted", "RoleRevoked", "RoleAdminChanged", "TargetWhitelistUpdated", "PartyBRegistered", "PartyBUnregistered"].map(
		name => contract.interface.getEvent(name).topicHash,
	)
	const logs = await configurationEvents(ethers, address, topics, block, discovery)
	const symmio = lower(await contract.symmio({ blockTag: block })),
		accountLayer = lower(await contract.accountLayer({ blockTag: block }))
	const targets = [symmio, accountLayer, ...(discovery.instantTargets || [])],
		partyBs = [...(discovery.instantPartyBs || [])]
	for (const log of logs) {
		const event = contract.interface.parseLog(log)
		if (event?.name === "TargetWhitelistUpdated") targets.push(event.args.target)
		if (event && ["PartyBRegistered", "PartyBUnregistered"].includes(event.name)) partyBs.push(event.args[0])
	}
	const roles = await roleSnapshot(ethers, contract, logs, block, true, discovery.instantRoles, discovery.instantRoleMembers)
	partyBs.push(...roles.flatMap((entry: any) => entry.members))
	const whitelist = [],
		registeredPartyBs = [],
		templates = []
	for (const target of unique(targets)) if (await contract.whitelistedTargets(target, { blockTag: block })) whitelist.push(target)
	for (const partyB of unique(partyBs)) if (await contract.registeredPartyBs(partyB, { blockTag: block })) registeredPartyBs.push(partyB)
	const count = Number(await contract.nextTemplateId({ blockTag: block }))
	if (!Number.isSafeInteger(count) || count > 10000) throw new Error("Invalid InstantLayer template count")
	for (let id = 0; id < count; id++) {
		const template = await contract.getTemplate(id, { blockTag: block })
		templates.push({
			id,
			name: template.name,
			active: template.active,
			instantOpenMode: await contract.templateInstantOpenMode(id, { blockTag: block }),
			operations: template.operations.map((op: any) => ({
				insertionPoints: Array.from(op.insertionPoints, String),
				sourceIndices: Array.from(op.sourceIndices, String),
				sourceOffsets: Array.from(op.sourceOffsets, String),
			})),
		})
	}
	return {
		symmio,
		accountLayer,
		revocationCooldown: String(await contract.revocationCooldown({ blockTag: block })),
		transientContextEnabled: await contract.transientContextEnabled({ blockTag: block }),
		whitelist,
		registeredPartyBs,
		roles,
		templates,
	}
}

/** Slot 20 was reserved in the verified baseline; never activate a new fee through stale gap data.
 * Fee accounting uses a new four-slot namespace, empty outside an atomic quote/limited execution. */
export async function readGaslessUpgradeStorage(ethers: any, address: string, block: number) {
	const walletCreationFee = BigInt(await ethers.provider.getStorage(address, WALLET_CREATION_FEE_SLOT, block))
	if (walletCreationFee !== 0n)
		throw new Error(
			"Gasless walletCreationFee slot 20 must be zero to preserve existing charges; review the on-chain value before changing the upgrade input",
		)
	const namespace = BigInt(ethers.id(FEE_QUOTE_STORAGE_NAMESPACE))
	const feeQuoteContextSlots = await Promise.all([0n, 1n, 2n, 3n].map(offset => ethers.provider.getStorage(address, namespace + offset, block)))
	if (feeQuoteContextSlots.some(value => BigInt(value) !== 0n)) throw new Error("Gasless fee-quote storage namespace is not empty")
	return { walletCreationFee: String(walletCreationFee), feeQuoteContextSlots }
}

export async function readGaslessConfiguration(ethers: any, address: string, block: number, discovery: any = {}) {
	const contract = await ethers.getContractAt("GaslessLayer", address)
	const topics = ["RoleGranted", "RoleRevoked", "RoleAdminChanged", "SelectorFeeConfigUpdated"].map(
		name => contract.interface.getEvent(name).topicHash,
	)
	const logs = await configurationEvents(ethers, address, topics, block, discovery)
	const { walletCreationFee, feeQuoteContextSlots } = await readGaslessUpgradeStorage(ethers, address, block)
	const fees: any = { walletCreationFee },
		references: any = {}
	for (const name of [...GASLESS_UINTS, ...GASLESS_BOOLS]) fees[name] = json(await contract[name]({ blockTag: block }))
	for (const name of ["core", "accountLayer", "instantLayer", "collateralToken", "treasury"])
		references[name] = lower(await contract[name]({ blockTag: block }))
	const selectors: string[] = [...(discovery.gaslessSelectors || [])]
	for (const log of logs) {
		const event = contract.interface.parseLog(log)
		if (event?.name === "SelectorFeeConfigUpdated") selectors.push(event.args.selector)
	}
	const selectorFees = []
	for (const selector of unique(selectors)) {
		const entry = await contract.selectorFeeConfigs(selector, { blockTag: block })
		selectorFees.push({ selector, configured: entry.configured, amount: String(entry.amount) })
	}
	return {
		...references,
		fees,
		selectorFees,
		feeQuoteContextSlots,
		roles: await roleSnapshot(ethers, contract, logs, block, false, discovery.gaslessRoles, discovery.gaslessRoleMembers),
	}
}

export async function selectorsAt(ethers: any, address: string, block?: number) {
	const loupe = await ethers.getContractAt("DiamondLoupeFacet", address)
	const map: Record<string, string> = {}
	for (const facet of await loupe.facets(block === undefined ? {} : { blockTag: block }))
		for (const selector of facet.functionSelectors) {
			if (map[selector]) throw new Error(`Duplicate installed selector ${selector}`)
			map[selector] = lower(facet.facetAddress)
		}
	return map
}

export async function readPartyBUpgradeAuthority(ethers: any, partyB: string, authority: string, block?: number) {
	const contract = await ethers.getContractAt("SymmioPartyB", partyB)
	const overrides = block === undefined ? {} : { blockTag: block }
	if (!(await contract.hasRole(ethers.ZeroHash, authority, overrides)))
		throw new Error(`PartyB authority ${authority} lacks DEFAULT_ADMIN_ROLE on ${partyB}`)
	const manager = await contract.hasRole(ethers.id("MANAGER_ROLE"), authority, overrides)
	for (const name of ["TRUSTED_ROLE", ...(!manager ? ["MANAGER_ROLE"] : [])]) {
		const roleAdmin = await contract.getRoleAdmin(ethers.id(name), overrides)
		if (!(await contract.hasRole(roleAdmin, authority, overrides)))
			throw new Error(`PartyB authority ${authority} cannot administer ${name} on ${partyB}; role admin is ${roleAdmin}`)
	}
	return { manager }
}

export async function readPreservedState(ethers: any, target: any, block: number) {
	const core = await ethers.getContractAt(
		[
			...diamondABI,
			"function getCollateral() view returns(address)",
			"function getOperationalFeeReceiver(address) view returns(address)",
			"function isOperationalFeeCharger(address) view returns(bool)",
			"function pauseState() view returns(bool,bool,bool,bool,bool,bool,bool,bool,bool,bool)",
		],
		target.core,
	)
	const account = await ethers.getContractAt([...diamondABI, "function paused() view returns(bool)"], target.accountLayer)
	const safe = await ethers.getContractAt(
		["function getOwners() view returns(address[])", "function getThreshold() view returns(uint256)"],
		target.safe,
	)
	const timelockSlot = BigInt(ethers.id("diamond.standard.storage.accountlayer.timelock"))
	return {
		safeOwners: unique(await safe.getOwners({ blockTag: block })),
		safeThreshold: String(await safe.getThreshold({ blockTag: block })),
		corePauseState: Array.from(await core.pauseState({ blockTag: block })),
		accountPaused: await account.paused({ blockTag: block }),
		coreOwner: lower(await core.getOwner({ blockTag: block })),
		corePendingOwner: lower(await core.pendingOwner({ blockTag: block })),
		accountOwner: lower(await account.getOwner({ blockTag: block })),
		accountPendingOwner: lower(await account.pendingOwner({ blockTag: block })),
		collateral: lower(await core.getCollateral({ blockTag: block })),
		operationalFeeReceiver: lower(await core.getOperationalFeeReceiver(target.gaslessLayer, { blockTag: block })),
		operationalFeeCharger: await core.isOperationalFeeCharger(target.gaslessLayer, { blockTag: block }),
		accountGaslessCreator: await account.hasRole(target.gaslessLayer, ethers.id("ACCOUNT_CREATOR_ROLE"), { blockTag: block }),
		minTimelockDelayStorage: await ethers.provider.getStorage(target.accountLayer, timelockSlot + 4n, block),
		scheduleGracePeriodStorage: await ethers.provider.getStorage(target.accountLayer, timelockSlot + 5n, block),
	}
}

export async function captureAccountInstantSnapshot(ethers: any, config: any, blockNumber?: number) {
	const block = await ethers.provider.getBlock(blockNumber ?? "latest")
	if (!block?.hash) throw new Error("Cannot pin configuration to a canonical block")
	const target = config.target,
		at = block.number
	const discovery = flowDiscovery(config)
	const [instant, gasless, preserved, accountSelectors, coreSelectors] = await Promise.all([
		readInstantConfiguration(ethers, target.instantLayer, at, discovery),
		readGaslessConfiguration(ethers, target.gaslessLayer, at, discovery),
		readPreservedState(ethers, target, at),
		selectorsAt(ethers, target.accountLayer, at),
		selectorsAt(ethers, target.core, at),
	])
	for (const [value, expected, label] of [
		[instant.symmio, target.core, "InstantLayer Core"],
		[instant.accountLayer, target.accountLayer, "InstantLayer AccountLayer"],
		[gasless.core, target.core, "GaslessLayer Core"],
		[gasless.accountLayer, target.accountLayer, "GaslessLayer AccountLayer"],
		[gasless.instantLayer, target.instantLayer, "GaslessLayer InstantLayer"],
		[gasless.collateralToken, target.collateral, "Gasless collateral"],
		[preserved.coreOwner, target.safe, "Core owner"],
		[preserved.accountOwner, target.safe, "AccountLayer owner"],
	]) {
		if (lower(value) !== lower(expected)) throw new Error(`${label} differs from the reviewed target`)
	}
	const has = (roles: any[], name: string, member: string) => roles.some(r => r.role === roleHash(ethers, name) && r.members.includes(lower(member)))
	if (!has(gasless.roles, "DEFAULT_ADMIN_ROLE", target.safe))
		throw new Error(`Safe ${target.safe} lacks GaslessLayer DEFAULT_ADMIN_ROLE; provide an authorized administrator to grant it before upgrading`)
	for (const address of [target.core, target.accountLayer]) {
		const contract = await ethers.getContractAt(diamondABI, address)
		if (!(await contract.hasRole(target.safe, ethers.id("DEFAULT_ADMIN_ROLE"), { blockTag: at })))
			throw new Error(`Safe lacks default-admin authority on ${address}`)
	}
	const partyBAdmins: Record<string, string> = {}
	for (const partyB of unique([...instant.registeredPartyBs, ...config.discovery.instantPartyBs])) {
		const admin = Object.entries(target.partyBAdmins).find(([address]) => lower(address) === partyB)?.[1] as string | undefined
		if (!admin) throw new Error(`Missing input target.partyBAdmins[${partyB}]; supply its administrator in the JSON before deployment`)
		await readPartyBUpgradeAuthority(ethers, partyB, admin, at)
		partyBAdmins[partyB] = lower(admin)
	}
	const codeHashes: Record<string, string> = {}
	const implementation = lower(ethers.getAddress(`0x${(await ethers.provider.getStorage(target.gaslessLayer, IMPLEMENTATION_SLOT, at)).slice(-40)}`))
	for (const address of unique([
		target.core,
		target.accountLayer,
		target.instantLayer,
		target.gaslessLayer,
		...Object.keys(partyBAdmins),
		implementation,
		...Object.values(accountSelectors),
		...Object.values(coreSelectors),
	])) {
		const code = await ethers.provider.getCode(address, at)
		if (code === "0x") throw new Error(`No runtime code at ${address}`)
		codeHashes[address] = ethers.keccak256(code)
	}
	return {
		apiVersion: "operations.symm.io/account-instant-configuration-v1",
		chainId: Number((await ethers.provider.getNetwork()).chainId),
		blockNumber: at,
		blockHash: block.hash,
		instant,
		gasless,
		preserved,
		accountSelectors,
		coreSelectors,
		gaslessImplementation: implementation,
		partyBAdmins,
		codeHashes,
		discovery: flowDiscovery(config),
		flow: {
			safe: lower(target.safe),
			relayer: lower(target.relayer),
			gaslessLayer: lower(target.gaslessLayer),
			partyBs: unique(config.discovery.instantPartyBs),
		},
	}
}

/** Restore the historical project dependency graph, using the deployment compiler/settings.
 * Live runtime parity also verifies that the installed external dependencies reproduce the baseline. */
export async function compileGaslessCompatibility(hre: any, baselineCommit: string) {
	if (!/^[a-f0-9]{40}$/.test(baselineCommit)) throw new Error("Expected an exact Gasless baseline commit")
	const artifact = await hre.artifacts.readArtifact("GaslessLayer")
	const build = JSON.parse(fs.readFileSync(path.join(hre.config.paths.artifacts, "build-info", `${artifact.buildInfoId}.json`), "utf8"))
	const artifacts = Object.fromEntries(
		await Promise.all(["GaslessLayer", ...GASLESS_LIBRARIES].map(async name => [name, await hre.artifacts.readArtifact(name)])),
	)
	const historical = structuredClone(build.input)
	// New fee-quote sources did not exist in the baseline. Restore its actual import closure,
	// including historical project dependencies no longer imported by the current implementation.
	for (const source of Object.keys(historical.sources)) if (source.startsWith("project/")) delete historical.sources[source]
	const restore = (source: string) => {
		if (historical.sources[source]) return
		if (!source.startsWith("project/contracts/") || !source.endsWith(".sol")) throw new Error(`Unexpected baseline import ${source}`)
		const content = execFileSync("git", ["show", `${baselineCommit}:${source.slice("project/".length)}`], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		})
		historical.sources[source] = { content }
		for (const match of content.matchAll(/\bimport\s+(?:[^;]*?\bfrom\s*)?["']([^"']+)["']\s*;/g)) {
			if (match[1].startsWith(".")) restore(path.posix.normalize(path.posix.join(path.posix.dirname(source), match[1])))
		}
	}
	for (const name of ["GaslessLayer", ...BASELINE_GASLESS_LIBRARIES]) restore(artifacts[name].inputSourceName)
	const modulePath = path.join(process.cwd(), "node_modules/hardhat/dist/src/internal/builtin-plugins/solidity/build-system/compiler/index.js")
	const { getCompiler } = await import(pathToFileURL(modulePath).href)
	const compiler = await getCompiler(build.solcVersion, { preferWasm: false })
	const compile = async (original: any, names: readonly string[]) => {
		const input = structuredClone(original)
		input.settings.outputSelection = Object.fromEntries(
			names.map(name => [artifacts[name].inputSourceName, { [name]: ["abi", "storageLayout", "evm.deployedBytecode", "evm.bytecode"] }]),
		)
		const output = await compiler.compile(input)
		const errors = output.errors?.filter((e: any) => e.severity === "error") || []
		if (errors.length) throw new Error(errors.map((e: any) => e.formattedMessage).join("\n"))
		return Object.fromEntries(names.map(name => [name, output.contracts[artifacts[name].inputSourceName][name]]))
	}
	const [old, current] = await Promise.all([
		compile(historical, ["GaslessLayer", ...BASELINE_GASLESS_LIBRARIES]),
		compile(build.input, ["GaslessLayer", ...GASLESS_LIBRARIES]),
	])
	const asArtifact = (name: string) => ({
		...artifacts[name],
		abi: old[name].abi,
		bytecode: `0x${old[name].evm.bytecode.object}`,
		linkReferences: old[name].evm.bytecode.linkReferences,
		deployedBytecode: `0x${old[name].evm.deployedBytecode.object}`,
		deployedLinkReferences: old[name].evm.deployedBytecode.linkReferences,
		immutableReferences: old[name].evm.deployedBytecode.immutableReferences,
	})
	return {
		baselineCommit,
		baselineSourcesDigest: digest(historical.sources),
		...verifyGaslessStorageLayout(old.GaslessLayer.storageLayout, current.GaslessLayer.storageLayout),
		layouts: { baseline: old.GaslessLayer.storageLayout, current: current.GaslessLayer.storageLayout },
		artifact: asArtifact("GaslessLayer"),
		libraryArtifacts: Object.fromEntries(BASELINE_GASLESS_LIBRARIES.map(name => [name, asArtifact(name)])),
	}
}

export async function verifyGaslessCompatibility(hre: any, ethers: any, snapshot: any, compiled: any) {
	const code = (await ethers.provider.getCode(snapshot.gaslessImplementation)).slice(2)
	const libraries: Record<string, string> = {}
	for (const [source, names] of Object.entries(compiled.artifact.deployedLinkReferences) as any)
		for (const [name, refs] of Object.entries(names) as any) {
			const addresses = unique(refs.map((r: any) => `0x${code.slice(r.start * 2, (r.start + r.length) * 2)}`))
			if (addresses.length !== 1 || !BASELINE_GASLESS_LIBRARIES.includes(name)) throw new Error(`Invalid baseline library ${name}`)
			libraries[`${source}:${name}`] = addresses[0]
		}
	if (Object.keys(libraries).length !== BASELINE_GASLESS_LIBRARIES.length) throw new Error("Incomplete baseline GaslessLayer library graph")
	for (const [qualifiedName, address] of Object.entries(libraries))
		await assertRoundingRuntime(ethers, compiled.libraryArtifacts[qualifiedName.split(":").at(-1)!], address, libraries)
	await assertRoundingRuntime(ethers, compiled.artifact, snapshot.gaslessImplementation, libraries)
	return {
		baselineCommit: compiled.baselineCommit,
		baselineSourcesDigest: compiled.baselineSourcesDigest,
		layoutDigest: compiled.layoutDigest,
		baselineLayoutDigest: compiled.baselineLayoutDigest,
		implementation: snapshot.gaslessImplementation,
		libraries,
		reusedLibraries: {},
	}
}
