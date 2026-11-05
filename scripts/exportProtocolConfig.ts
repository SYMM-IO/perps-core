import fs from "fs"

import { validateProtocolConfig } from "../tasks/deploy/protocolConfig.js"
import { ethers } from "../test/helpers/hardhat-connection.js"

// Reads one coherent block from a live deployment and writes a validated
// tasks/config/protocol-<chainId>.json that deploy:system can consume.
//
// Usage:
//   SYMMIO=0x... INSTANT_LAYER=0x... TARGET_CHAIN_ID=42161 \
//     ./node_modules/.bin/hardhat run scripts/exportProtocolConfig.ts --network hyperevm

const MA_STORAGE_BASE = BigInt(ethers.id("diamond.standard.storage.masteragreement"))
const TEMPLATE_PAGE_SIZE = 50

const MA_LAYOUT = [
	"withdrawCooldownPeriod",
	"forceCancelCooldown",
	"forceCancelCloseCooldown",
	"forceCloseFirstCooldown",
	"liquidationTimeout",
	"liquidatorShare",
	"pendingQuotesValidLength",
	"deprecatedForceCloseGapRatio",
	"partyBStatus",
	"liquidationStatus",
	"partyBLiquidationStatus",
	"partyBLiquidationTimestamp",
	"partyBPositionLiquidatorsShare",
	"partyBList",
	"forceCloseSecondCooldown",
	"forceClosePricePenalty",
	"forceCloseMinSigPeriod",
	"deallocateDebounceTime",
	"affiliateStatus",
	"settlementCooldown",
	"lastUpnlSettlementTimestamp",
	"liquidationInsuranceVault",
	"maxLiquidationProfitPerPosition",
	"entitiesMetadata",
	"maxPartyAConnectionLimit",
] as const

const NEEDED_FROM_STORAGE = [
	"withdrawCooldownPeriod",
	"forceCancelCooldown",
	"forceCancelCloseCooldown",
	"forceCloseFirstCooldown",
	"forceCloseSecondCooldown",
	"liquidationTimeout",
	"liquidatorShare",
	"pendingQuotesValidLength",
	"settlementCooldown",
	"maxPartyAConnectionLimit",
	"deallocateDebounceTime",
] as const

const VIEW_ABI = [
	"function getBalanceLimitPerUser() view returns (uint256)",
	"function getMaxWithdrawParts() view returns (uint256)",
	"function getDeallocateDebounceTime() view returns (uint256)",
	"function getMuonConfig() view returns (uint256,uint256)",
	"function getMuonIds() view returns (uint256)",
	"function getCollateral() view returns (address)",
	"function getSignatureVerifier() view returns (address)",
	"function getDefaultFeeCollector() view returns (address)",
	"function getInvalidBridgedAmountsPool() view returns (address)",
]

const INSTANT_LAYER_ABI = [
	"function nextTemplateId() view returns (uint256)",
	"function templateInstantOpenMode(uint256) view returns (bool)",
	"function getTemplates(uint256,uint256) view returns (tuple(string name, tuple(uint256[] insertionPoints, uint256[] sourceIndices, uint256[] sourceOffsets)[] operations, bool active)[])",
]

function requiredAddress(name: string, raw: string | undefined): string {
	if (!raw) throw new Error(`Set ${name} to the deployed contract address`)
	try {
		return ethers.getAddress(raw)
	} catch {
		throw new Error(`${name} is not a valid address: ${raw}`)
	}
}

function safeInteger(name: string, value: bigint, minimum = 0): number {
	if (value < BigInt(minimum) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`${name}=${value} is outside the supported safe-integer range (${minimum}..${Number.MAX_SAFE_INTEGER})`)
	}
	return Number(value)
}

function targetChainId(raw: string | undefined, sourceChainId: bigint): number {
	if (raw === undefined) return safeInteger("source chainId", sourceChainId, 1)
	if (!/^\d+$/.test(raw)) throw new Error(`TARGET_CHAIN_ID must be a positive base-10 integer, received ${raw}`)
	return safeInteger("TARGET_CHAIN_ID", BigInt(raw), 1)
}

function summarizeError(error: unknown): string {
	if (!error || typeof error !== "object") return String(error)
	const candidate = error as { shortMessage?: string; message?: string }
	return candidate.shortMessage ?? candidate.message ?? String(error)
}

async function requireCode(name: string, address: string, blockTag: number): Promise<void> {
	const code = await ethers.provider.getCode(address, blockTag)
	if (code === "0x") throw new Error(`${name} has no contract code at ${address} (block ${blockTag})`)
}

async function callRequired(contract: any, fn: string, blockTag: number): Promise<any> {
	try {
		return await contract[fn]({ blockTag })
	} catch (error) {
		throw new Error(`Required on-chain read ${fn}() failed: ${summarizeError(error)}`)
	}
}

function templateInteger(value: bigint, field: string): number {
	return safeInteger(field, value, 0)
}

async function readTemplates(instantLayer: any, total: number, blockTag: number): Promise<any[]> {
	const templates: any[] = []
	for (let start = 0; start < total; start += TEMPLATE_PAGE_SIZE) {
		const limit = Math.min(TEMPLATE_PAGE_SIZE, total - start)
		let page: any[]
		try {
			page = await instantLayer.getTemplates(start, limit, { blockTag })
		} catch (error) {
			throw new Error(`Required template page ${start}..${start + limit - 1} failed: ${summarizeError(error)}`)
		}
		if (page.length !== limit) {
			throw new Error(`Template page ${start} returned ${page.length} entries; expected ${limit}`)
		}

		for (const [pageIndex, template] of page.entries()) {
			const templateId = start + pageIndex
			if (!template.active) {
				throw new Error(`Template ${templateId} (${template.name}) is inactive; deploy:system cannot reproduce inactive source templates safely`)
			}
			const instantOpenMode = await instantLayer.templateInstantOpenMode(templateId, { blockTag })
			templates.push({
				name: template.name,
				instantOpenMode,
				operations: template.operations.map((operation: any, operationIndex: number) => ({
					insertionPoints: operation.insertionPoints.map((value: bigint, index: number) =>
						templateInteger(value, `template[${templateId}].operations[${operationIndex}].insertionPoints[${index}]`),
					),
					sourceIndices: operation.sourceIndices.map((value: bigint, index: number) =>
						templateInteger(value, `template[${templateId}].operations[${operationIndex}].sourceIndices[${index}]`),
					),
					sourceOffsets: operation.sourceOffsets.map((value: bigint, index: number) =>
						templateInteger(value, `template[${templateId}].operations[${operationIndex}].sourceOffsets[${index}]`),
					),
				})),
			})
		}
	}
	if (templates.length !== total) throw new Error(`Read ${templates.length} templates; expected ${total}`)
	return templates
}

async function main(): Promise<void> {
	const symmio = requiredAddress("SYMMIO", process.env.SYMMIO)
	const instantLayerAddress = requiredAddress("INSTANT_LAYER", process.env.INSTANT_LAYER)
	const network = await ethers.provider.getNetwork()
	const sourceChainId = network.chainId
	const target = targetChainId(process.env.TARGET_CHAIN_ID, sourceChainId)
	const blockTag = await ethers.provider.getBlockNumber()

	await requireCode("SYMMIO", symmio, blockTag)
	await requireCode("INSTANT_LAYER", instantLayerAddress, blockTag)
	console.log(`Reading ${symmio} on chainId ${sourceChainId} at block ${blockTag}`)

	const view = await ethers.getContractAt(VIEW_ABI, symmio)
	const getterNames = [
		"getBalanceLimitPerUser",
		"getMaxWithdrawParts",
		"getDeallocateDebounceTime",
		"getMuonIds",
		"getCollateral",
		"getSignatureVerifier",
		"getDefaultFeeCollector",
		"getInvalidBridgedAmountsPool",
	] as const
	const readable: Record<string, string> = {}
	for (const fn of getterNames) readable[fn] = (await callRequired(view, fn, blockTag)).toString()
	const [muonUpnlValidTime, muonPriceValidTime] = await callRequired(view, "getMuonConfig", blockTag)

	const storage: Record<string, bigint> = {}
	for (const name of NEEDED_FROM_STORAGE) {
		const index = MA_LAYOUT.indexOf(name)
		if (index === -1) throw new Error(`${name} is not in MA_LAYOUT`)
		const slot = `0x${(MA_STORAGE_BASE + BigInt(index)).toString(16).padStart(64, "0")}`
		try {
			storage[name] = BigInt(await ethers.provider.getStorage(symmio, slot, blockTag))
		} catch (error) {
			throw new Error(`Required MAStorage read ${name} failed: ${summarizeError(error)}`)
		}
	}

	if (storage.deallocateDebounceTime.toString() !== readable.getDeallocateDebounceTime) {
		throw new Error(
			`MAStorage layout mismatch: deallocateDebounceTime storage=${storage.deallocateDebounceTime}, getter=${readable.getDeallocateDebounceTime}`,
		)
	}

	const instantLayer = await ethers.getContractAt(INSTANT_LAYER_ABI, instantLayerAddress)
	const templateCount = safeInteger("nextTemplateId", await callRequired(instantLayer, "nextTemplateId", blockTag), 1)
	const templates = await readTemplates(instantLayer, templateCount, blockTag)

	const output = {
		description: `Exported from ${symmio} on chainId ${sourceChainId} at block ${blockTag}`,
		_provenance: {
			source: symmio,
			sourceChainId: safeInteger("source chainId", sourceChainId, 1),
			readAtBlock: blockTag,
			instantLayer: instantLayerAddress,
			muonAppId: readable.getMuonIds,
			muonUpnlValidTime: muonUpnlValidTime.toString(),
			muonPriceValidTime: muonPriceValidTime.toString(),
			observedAddresses: {
				collateral: ethers.getAddress(readable.getCollateral),
				signatureVerifier: ethers.getAddress(readable.getSignatureVerifier),
				defaultFeeCollector: ethers.getAddress(readable.getDefaultFeeCollector),
				invalidBridgedAmountsPool: ethers.getAddress(readable.getInvalidBridgedAmountsPool),
			},
			allValuesVerifiedAgainstChain: true,
			readVia: "one fixed block: getters, validated MAStorage slots, and all InstantLayer template IDs",
			note: "Muon validity times are deployment environment inputs; compare them explicitly before deploying the target chain",
		},
		parameters: {
			balanceLimitPerUser: readable.getBalanceLimitPerUser,
			maxWithdrawParts: safeInteger("getMaxWithdrawParts", BigInt(readable.getMaxWithdrawParts), 1),
			deallocateCooldown: safeInteger("withdrawCooldownPeriod", storage.withdrawCooldownPeriod, 1),
			settlementCooldown: safeInteger("settlementCooldown", storage.settlementCooldown, 1),
			deallocateDebounceTime: safeInteger("deallocateDebounceTime", storage.deallocateDebounceTime),
			liquidatorShare: storage.liquidatorShare.toString(),
			liquidationTimeout: safeInteger("liquidationTimeout", storage.liquidationTimeout, 1),
			forceCloseCooldowns: [
				safeInteger("forceCloseFirstCooldown", storage.forceCloseFirstCooldown, 1),
				safeInteger("forceCloseSecondCooldown", storage.forceCloseSecondCooldown, 1),
			],
			forceCancelCooldown: safeInteger("forceCancelCooldown", storage.forceCancelCooldown, 1),
			forceCancelCloseCooldown: safeInteger("forceCancelCloseCooldown", storage.forceCancelCloseCooldown, 1),
			pendingQuotesValidLength: safeInteger("pendingQuotesValidLength", storage.pendingQuotesValidLength, 1),
			maxPartyAConnectionLimit: safeInteger("maxPartyAConnectionLimit", storage.maxPartyAConnectionLimit, 1),
		},
		instantLayerTemplates: templates,
	}

	const outPath = `./tasks/config/protocol-${target}.json`
	validateProtocolConfig(output, outPath)
	if (fs.existsSync(outPath) && process.env.OVERWRITE !== "true") {
		throw new Error(`${outPath} already exists; refusing to overwrite a reviewed deployment config. Set OVERWRITE=true after diffing the export.`)
	}
	fs.mkdirSync("./tasks/config", { recursive: true })
	const temporaryPath = `${outPath}.${process.pid}.tmp`
	fs.writeFileSync(temporaryPath, `${JSON.stringify(output, null, "\t")}\n`)
	fs.renameSync(temporaryPath, outPath)
	console.log(`Validated ${templates.length} templates and wrote ${outPath}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
