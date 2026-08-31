/**
 * Read an ordered source/target symbol catalog and write a digest-bound JSON snapshot.
 * The selected Hardhat network must be the target network declared by the config.
 * This script is read-only on-chain.
 *
 * SYMBOL_SYNC_CONFIG=scripts/symbols/config/hyperevm-to-arbitrum.json \
 *   ./node_modules/.bin/hardhat run --no-compile scripts/symbols/fetchSymbols.ts --network arbitrum
 */
import hre from "hardhat"
import path from "node:path"

import {
	SYMBOL_SYNC_SNAPSHOT_API,
	analyzeExactIdSync,
	atomicWriteJson,
	readSymbolSyncConfig,
	serializeSymbol,
	withDigest,
	type SerializedSymbol,
} from "../utils/symbolSync.js"

const SYMBOL_TUPLE =
	"tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime,uint256 symbolType)"
const CORE_ABI = [
	`function getSymbolsWithType(uint256 start,uint256 size) view returns (${SYMBOL_TUPLE}[])`,
	"function hasRole(address user,bytes32 role) view returns (bool)",
	"function isRoleAdmin(address user,bytes32 role) view returns (bool)",
]
const MANAGER_ABI = [
	"function symmioAddress() view returns (address)",
	"function paused() view returns (bool)",
	"function dailyLimits() view returns (uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio)",
	"function dailyOperations() view returns (uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio)",
	"function lastResetTimestamp() view returns (uint256)",
	"function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
	"function SYMBOL_ADDER_ROLE() view returns (bytes32)",
	"function SYMBOL_REMOVER_ROLE() view returns (bytes32)",
	"function getRoleMemberCount(bytes32 role) view returns (uint256)",
	"function getRoleMember(bytes32 role,uint256 index) view returns (address)",
]
const PAGE_SIZE = 200

function requiredPath(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required`)
	return path.resolve(value)
}

async function readCatalog(ethers: any, coreAddress: string, blockNumber: number): Promise<SerializedSymbol[]> {
	const core = new ethers.Contract(coreAddress, CORE_ABI, ethers.provider)
	const result: SerializedSymbol[] = []
	for (let start = 0; ; start += PAGE_SIZE) {
		const page = await core.getSymbolsWithType(start, PAGE_SIZE, { blockTag: blockNumber })
		for (const symbol of page) result.push(serializeSymbol(symbol))
		if (page.length < PAGE_SIZE) break
	}
	return result
}

async function assertConnection(ethers: any, expectedChainId: string, coreAddress: string, label: string): Promise<number> {
	const network = await ethers.provider.getNetwork()
	if (network.chainId !== BigInt(expectedChainId)) {
		throw new Error(`${label} connection chainId ${network.chainId} does not match configured ${expectedChainId}`)
	}
	const blockNumber = await ethers.provider.getBlockNumber()
	if ((await ethers.provider.getCode(coreAddress, blockNumber)) === "0x") {
		throw new Error(`${label} Core ${coreAddress} has no bytecode at block ${blockNumber}`)
	}
	return blockNumber
}

async function roleMembers(manager: any, getter: string, blockNumber: number): Promise<{ hash: string; members: string[] }> {
	const hash = await manager[getter]({ blockTag: blockNumber })
	const count = await manager.getRoleMemberCount(hash, { blockTag: blockNumber })
	const members: string[] = []
	for (let index = 0n; index < count; index++) members.push(await manager.getRoleMember(hash, index, { blockTag: blockNumber }))
	return { hash, members }
}

function operationValues(value: any): Record<string, string> {
	return Object.fromEntries(
		["symbolAddition", "tradingFee", "validationState", "maxLeverage", "acceptableValues", "fundingState", "forceCloseGapRatio"].map(field => [
			field,
			BigInt(value[field]).toString(),
		]),
	)
}

async function readManagerState(ethers: any, coreAddress: string, managerAddress: string, blockNumber: number): Promise<Record<string, unknown>> {
	if ((await ethers.provider.getCode(managerAddress, blockNumber)) === "0x") {
		throw new Error(`Target Symbol Manager ${managerAddress} has no bytecode at block ${blockNumber}`)
	}
	const manager = new ethers.Contract(managerAddress, MANAGER_ABI, ethers.provider)
	const core = new ethers.Contract(coreAddress, CORE_ABI, ethers.provider)
	const [symmioAddress, paused, dailyLimits, dailyOperations, lastResetTimestamp, block, defaultAdmin, adder, remover] = await Promise.all([
		manager.symmioAddress({ blockTag: blockNumber }),
		manager.paused({ blockTag: blockNumber }),
		manager.dailyLimits({ blockTag: blockNumber }),
		manager.dailyOperations({ blockTag: blockNumber }),
		manager.lastResetTimestamp({ blockTag: blockNumber }),
		ethers.provider.getBlock(blockNumber),
		roleMembers(manager, "DEFAULT_ADMIN_ROLE", blockNumber),
		roleMembers(manager, "SYMBOL_ADDER_ROLE", blockNumber),
		roleMembers(manager, "SYMBOL_REMOVER_ROLE", blockNumber),
	])
	if (!block) throw new Error(`Target block ${blockNumber} is unavailable`)
	if (ethers.getAddress(symmioAddress) !== ethers.getAddress(coreAddress)) {
		throw new Error(`Target Symbol Manager points to ${symmioAddress}, not configured Core ${coreAddress}`)
	}
	const symbolManagerRole = ethers.id("SYMBOL_MANAGER_ROLE")
	const managerHasCoreRole = await core.hasRole(managerAddress, symbolManagerRole, { blockTag: blockNumber })
	const defaultAdminCoreAuthority = await Promise.all(
		defaultAdmin.members.map(async address => ({
			address,
			isRoleAdmin: await core.isRoleAdmin(address, symbolManagerRole, { blockTag: blockNumber }),
			hasSymbolManagerRole: await core.hasRole(address, symbolManagerRole, { blockTag: blockNumber }),
		})),
	)
	const removerSet = new Set(remover.members.map(address => address.toLowerCase()))
	const fullOperators = adder.members.filter(address => removerSet.has(address.toLowerCase()))
	const resetAt = BigInt(lastResetTimestamp) + 86_400n
	const resetDue = BigInt(block.timestamp) >= resetAt
	const effectiveAdditionUsed = resetDue ? 0n : BigInt(dailyOperations.symbolAddition)
	const effectiveValidationUsed = resetDue ? 0n : BigInt(dailyOperations.validationState)

	return {
		symmioAddress: ethers.getAddress(symmioAddress),
		paused,
		managerHasCoreRole,
		dailyLimits: operationValues(dailyLimits),
		dailyOperations: operationValues(dailyOperations),
		lastResetTimestamp: BigInt(lastResetTimestamp).toString(),
		nextResetTimestamp: resetAt.toString(),
		resetDue,
		effectiveRemaining: {
			symbolAddition: (BigInt(dailyLimits.symbolAddition) - effectiveAdditionUsed).toString(),
			validationState: (BigInt(dailyLimits.validationState) - effectiveValidationUsed).toString(),
		},
		roles: { DEFAULT_ADMIN_ROLE: defaultAdmin, SYMBOL_ADDER_ROLE: adder, SYMBOL_REMOVER_ROLE: remover },
		fullOperators,
		defaultAdminCoreAuthority,
	}
}

async function main(): Promise<void> {
	const configPath = requiredPath("SYMBOL_SYNC_CONFIG")
	const config = readSymbolSyncConfig(configPath)
	const targetConnection: any = await hre.network.getOrCreate()
	if (targetConnection.networkName && targetConnection.networkName !== config.target.network) {
		throw new Error(`Selected Hardhat network ${targetConnection.networkName} does not match target.network ${config.target.network}`)
	}
	const sourceConnection: any = await hre.network.connect(config.source.network)
	const sourceBlock = await assertConnection(sourceConnection.ethers, config.source.chainId, config.source.core, "Source")
	const targetBlock = await assertConnection(targetConnection.ethers, config.target.chainId, config.target.core, "Target")
	const [sourceBlockData, targetBlockData, sourceSymbols, targetSymbols, managerState] = await Promise.all([
		sourceConnection.ethers.provider.getBlock(sourceBlock),
		targetConnection.ethers.provider.getBlock(targetBlock),
		readCatalog(sourceConnection.ethers, config.source.core, sourceBlock),
		readCatalog(targetConnection.ethers, config.target.core, targetBlock),
		readManagerState(targetConnection.ethers, config.target.core, config.target.symbolManager, targetBlock),
	])
	if (!sourceBlockData || !targetBlockData) throw new Error("Could not load pinned source/target block metadata")
	const analysis = analyzeExactIdSync(sourceSymbols, targetSymbols)
	const unsignedSnapshot = {
		apiVersion: SYMBOL_SYNC_SNAPSHOT_API,
		createdAt: new Date().toISOString(),
		configPath: path.relative(process.cwd(), configPath),
		config,
		source: {
			network: config.source.network,
			chainId: config.source.chainId,
			core: config.source.core,
			blockNumber: sourceBlock,
			blockHash: sourceBlockData.hash,
			symbols: sourceSymbols,
		},
		target: {
			network: config.target.network,
			chainId: config.target.chainId,
			core: config.target.core,
			symbolManager: config.target.symbolManager,
			blockNumber: targetBlock,
			blockHash: targetBlockData.hash,
			symbols: targetSymbols,
			managerState,
		},
		analysis,
	}
	const snapshot = withDigest(unsignedSnapshot)
	const output = path.resolve(process.env.SYMBOL_SYNC_OUTPUT || config.output.snapshot)
	atomicWriteJson(output, snapshot)

	console.log(`Ordered symbol snapshot: ${config.name}`)
	console.log(`  Source: ${config.source.network} chain ${config.source.chainId}, Core ${config.source.core}, block ${sourceBlock}`)
	console.log(`  Target: ${config.target.network} chain ${config.target.chainId}, Core ${config.target.core}, block ${targetBlock}`)
	console.log(`  Counts: source ${sourceSymbols.length}, target ${targetSymbols.length}, exact ${analysis.exactCount}`)
	for (const symbol of sourceSymbols) {
		console.log(`  #${symbol.symbolId.padStart(2)} ${symbol.name} valid=${symbol.isValid} type=${symbol.symbolType}`)
	}
	console.log(
		`  Required: add ${analysis.additions.length}, activate ${analysis.activate.length}, deactivate ${analysis.deactivate.length}, conflicts ${analysis.conflicts.length}`,
	)
	if (analysis.conflicts.length) analysis.conflicts.forEach(conflict => console.log(`  BLOCKED: ${conflict}`))
	console.log(`  Snapshot: ${output}`)
	console.log(`  Digest: ${snapshot.digest}`)
	if (analysis.status === "blocked") throw new Error("Exact-ID symbol synchronization is blocked by target/source conflicts")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
