/**
 * Print ownership/admin holders for the core diamond and upgrade peripherals.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/checkOwners.ts --network coti
 *
 * Env overrides:
 *   DIAMOND_ADDRESS
 *   ACCOUNT_LAYER_ADDRESS
 *   INSTANT_LAYER_ADDRESS
 *   SIGNATURE_VERIFIER_ADDRESS
 *   SYMBOL_MANAGER_ADDRESS
 *   SYMMIO_PARTYB_IMPLEMENTATION
 *   PERIPHERALS_FILE
 *   UPGRADE_OPERATOR
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { loadDeploymentState } from "./utils/deploymentState.js"
import { logUpgradeOwnershipSummary } from "./utils/ownership.js"
import { baseNetworkName, loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"

type UpgradeConfig = {
	diamondAddress?: string
	protocolAdmin?: string
	safeAddress?: string
	migrationRunner?: string
	upgradeOperator?: string
	symmioFeeReceiver?: string
	instantLayerAddress?: string
	accountLayerDiamondAddress?: string
	newV085Parameters?: {
		signatureVerifierAddress?: string
	}
}

type PeripheralsState = {
	signatureVerifier?: string
	accountLayer?: { diamond?: string }
	instantLayer?: { address?: string }
	symmioPartyBImplementation?: string
	symbolManager?: { address?: string }
}

const OUTPUT_DIR = "./scripts/upgrade/output"
const ROLES = {
	SIGNER_ADMIN_ROLE: ethers.id("SIGNER_ADMIN_ROLE"),
	AFFILIATE_MANAGER_ROLE: ethers.id("AFFILIATE_MANAGER_ROLE"),
	BALANCE_SETTLER_ROLE: ethers.id("BALANCE_SETTLER_ROLE"),
	INSTANT_LAYER_ROLE: ethers.id("INSTANT_LAYER_ROLE"),
	SIGNER_SETTER_ROLE: ethers.id("SIGNER_SETTER_ROLE"),
	SYMBOL_MANAGER_ROLE: ethers.id("SYMBOL_MANAGER_ROLE"),
	FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE: ethers.id("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"),
}

function loadRawUpgradeConfig(networkName: string | undefined): UpgradeConfig {
	const configFile = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(configFile)) return {}
	return JSON.parse(fs.readFileSync(configFile, "utf-8")) as UpgradeConfig
}

function mergeState(target: PeripheralsState, source: PeripheralsState): PeripheralsState {
	return {
		signatureVerifier: target.signatureVerifier ?? source.signatureVerifier,
		accountLayer: target.accountLayer?.diamond ? target.accountLayer : source.accountLayer,
		instantLayer: target.instantLayer?.address ? target.instantLayer : source.instantLayer,
		symmioPartyBImplementation: target.symmioPartyBImplementation ?? source.symmioPartyBImplementation,
		symbolManager: target.symbolManager?.address ? target.symbolManager : source.symbolManager,
	}
}

function loadStateFile(filePath: string, networkName: string | undefined, chainId: number, diamondAddress: string | undefined): PeripheralsState {
	if (!fs.existsSync(filePath)) return {}
	try {
		return loadDeploymentState<PeripheralsState>(filePath, { networkName, chainId, diamondAddress })
	} catch (error) {
		try {
			console.warn(`Warning: reading legacy state without metadata validation: ${filePath}`)
			return JSON.parse(fs.readFileSync(filePath, "utf-8")) as PeripheralsState
		} catch (parseError) {
			console.warn(`Warning: skipped ${filePath}: ${(parseError as Error).message}`)
			return {}
		}
	}
}

function loadJsonFile(filePath: string): any | undefined {
	if (!fs.existsSync(filePath)) return undefined
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"))
	} catch {
		return undefined
	}
}

function getInputAddress(tx: any, key: string): string | undefined {
	const value = tx?.contractInputsValues?.[key]
	return typeof value === "string" && ethers.isAddress(value) ? ethers.getAddress(value) : undefined
}

function setAddress(target: PeripheralsState, key: keyof PeripheralsState, address: string | undefined): void {
	if (!address || !ethers.isAddress(address)) return
	const normalized = ethers.getAddress(address)
	if (key === "signatureVerifier" || key === "symmioPartyBImplementation") {
		if (!target[key]) target[key] = normalized
	} else if (key === "accountLayer") {
		if (!target.accountLayer?.diamond) target.accountLayer = { diamond: normalized }
	} else if (key === "instantLayer") {
		if (!target.instantLayer?.address) target.instantLayer = { address: normalized }
	} else if (key === "symbolManager") {
		if (!target.symbolManager?.address) target.symbolManager = { address: normalized }
	}
}

function extractAddressAfter(text: string | undefined, label: string): string | undefined {
	if (!text) return undefined
	const pattern = new RegExp(`${label}\\s+(0x[a-fA-F0-9]{40})`)
	const match = text.match(pattern)
	return match?.[1] && ethers.isAddress(match[1]) ? ethers.getAddress(match[1]) : undefined
}

function extractStateFromOutputArtifact(filePath: string): PeripheralsState {
	const json = loadJsonFile(filePath)
	const state: PeripheralsState = {}
	if (!json) return state

	const description = typeof json?.meta?.description === "string" ? json.meta.description : undefined
	setAddress(state, "instantLayer", extractAddressAfter(description, "InstantLayer"))
	setAddress(state, "symbolManager", extractAddressAfter(description, "SymmioSymbolManager"))

	const transactions = Array.isArray(json.transactions) ? json.transactions : []
	for (const tx of transactions) {
		const to = typeof tx.to === "string" && ethers.isAddress(tx.to) ? ethers.getAddress(tx.to) : undefined
		const method = tx?.contractMethod?.name
		if (!to || !method) continue

		if (method === "setAccountLayer") {
			setAddress(state, "instantLayer", to)
			setAddress(state, "accountLayer", getInputAddress(tx, "accountLayer"))
		} else if (method === "setWhitelistedSymmioCore" || method === "acceptOwnership") {
			setAddress(state, "accountLayer", to)
		} else if (method === "setTargetWhitelist" || method === "registerPartyBs" || method === "addTemplate") {
			setAddress(state, "instantLayer", to)
		} else if (method === "grantRole") {
			const role = typeof tx?.contractInputsValues?.role === "string" ? tx.contractInputsValues.role.toLowerCase() : undefined
			const account = getInputAddress(tx, "account")
			if (!role || !account) continue
			if ([ROLES.SIGNER_ADMIN_ROLE, ROLES.AFFILIATE_MANAGER_ROLE, ROLES.BALANCE_SETTLER_ROLE].includes(role)) {
				setAddress(state, "accountLayer", account)
			} else if (role === ROLES.INSTANT_LAYER_ROLE || role === ROLES.SIGNER_SETTER_ROLE) {
				setAddress(state, "instantLayer", account)
				if (role === ROLES.SIGNER_SETTER_ROLE) setAddress(state, "accountLayer", to)
			} else if ([ROLES.SYMBOL_MANAGER_ROLE, ROLES.FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE].includes(role)) {
				setAddress(state, "symbolManager", account)
			}
		}
	}

	return state
}

function firstValidAddress(...addresses: Array<string | undefined>): string | undefined {
	for (const address of addresses) {
		if (address && ethers.isAddress(address)) return ethers.getAddress(address)
	}
	return undefined
}

function uniqueFiles(files: Array<string | undefined>): string[] {
	return [...new Set(files.filter((filePath): filePath is string => Boolean(filePath)))]
}

async function deriveLiveState(diamondAddress: string | undefined): Promise<PeripheralsState> {
	const state: PeripheralsState = {}
	if (!diamondAddress || !ethers.isAddress(diamondAddress)) return state

	const core = new ethers.Contract(
		diamondAddress,
		["function getAffiliateHook(address affiliate) view returns (address)", "function getSignatureVerifier() view returns (address)"],
		ethers.provider,
	)

	try {
		const accountLayer = await core.getAffiliateHook(ethers.ZeroAddress)
		const code = await ethers.provider.getCode(accountLayer)
		if (ethers.isAddress(accountLayer) && accountLayer !== ethers.ZeroAddress && code !== "0x") {
			state.accountLayer = { diamond: ethers.getAddress(accountLayer) }
		}
	} catch {}

	try {
		const signatureVerifier = await core.getSignatureVerifier()
		const code = await ethers.provider.getCode(signatureVerifier)
		if (ethers.isAddress(signatureVerifier) && signatureVerifier !== ethers.ZeroAddress && code !== "0x") {
			state.signatureVerifier = ethers.getAddress(signatureVerifier)
		}
	} catch {}

	return state
}

async function main() {
	const networkName = connection.networkName
	const networkSuffix = baseNetworkName(networkName)
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const shared = loadUpgradeConfigShared(networkSuffix)
	const upgradeConfig: UpgradeConfig = { ...shared, ...loadRawUpgradeConfig(networkSuffix) }

	const diamondAddress = process.env.DIAMOND_ADDRESS ?? upgradeConfig.diamondAddress

	let state: PeripheralsState = {}
	const candidateStateFiles = uniqueFiles([
		process.env.PERIPHERALS_FILE,
		path.join(OUTPUT_DIR, `deployed-peripherals-${networkName}.json`),
		networkSuffix ? path.join(OUTPUT_DIR, `deployed-peripherals-${networkSuffix}.json`) : undefined,
		networkSuffix ? path.join(OUTPUT_DIR, `deployed-accountlayer-instantlayer-${networkSuffix}.json`) : undefined,
		path.join(OUTPUT_DIR, "deployed-accountlayer-instantlayer.json"),
	])

	for (const filePath of candidateStateFiles) {
		state = mergeState(state, loadStateFile(filePath, networkSuffix, chainId, diamondAddress))
	}

	const candidateOutputArtifacts = uniqueFiles([
		path.join(OUTPUT_DIR, `safe-batch-${networkName}.json`),
		networkSuffix ? path.join(OUTPUT_DIR, `safe-batch-${networkSuffix}.json`) : undefined,
		path.join(OUTPUT_DIR, `register-partybs-safe-batch-${networkName}.json`),
		networkSuffix ? path.join(OUTPUT_DIR, `register-partybs-safe-batch-${networkSuffix}.json`) : undefined,
		path.join(OUTPUT_DIR, `symbolmanager-safe-batch-${networkName}.json`),
		networkSuffix ? path.join(OUTPUT_DIR, `symbolmanager-safe-batch-${networkSuffix}.json`) : undefined,
		path.join(OUTPUT_DIR, `symbolmanager-operator-roles-safe-batch-${networkName}.json`),
		networkSuffix ? path.join(OUTPUT_DIR, `symbolmanager-operator-roles-safe-batch-${networkSuffix}.json`) : undefined,
		path.join(OUTPUT_DIR, `upgrade-details-${networkName}.json`),
		networkSuffix ? path.join(OUTPUT_DIR, `upgrade-details-${networkSuffix}.json`) : undefined,
	])

	for (const filePath of candidateOutputArtifacts) {
		state = mergeState(state, extractStateFromOutputArtifact(filePath))
	}

	state = mergeState(state, await deriveLiveState(diamondAddress))

	await logUpgradeOwnershipSummary({
		symmioCore: diamondAddress,
		accountLayer: firstValidAddress(process.env.ACCOUNT_LAYER_ADDRESS, upgradeConfig.accountLayerDiamondAddress, state.accountLayer?.diamond),
		instantLayer: firstValidAddress(process.env.INSTANT_LAYER_ADDRESS, upgradeConfig.instantLayerAddress, state.instantLayer?.address),
		signatureVerifier: firstValidAddress(
			process.env.SIGNATURE_VERIFIER_ADDRESS,
			upgradeConfig.newV085Parameters?.signatureVerifierAddress,
			state.signatureVerifier,
		),
		symbolManager: firstValidAddress(process.env.SYMBOL_MANAGER_ADDRESS, state.symbolManager?.address),
		symmioPartyBImplementation: firstValidAddress(process.env.SYMMIO_PARTYB_IMPLEMENTATION, state.symmioPartyBImplementation),
		knownAccounts: [
			{ label: "protocolAdmin", address: upgradeConfig.protocolAdmin },
			{ label: "safe", address: upgradeConfig.safeAddress },
			{ label: "migrationRunner", address: upgradeConfig.migrationRunner },
			{ label: "upgradeOperator", address: process.env.UPGRADE_OPERATOR ?? upgradeConfig.upgradeOperator },
			{ label: "symmioFeeReceiver", address: upgradeConfig.symmioFeeReceiver },
		],
	})
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
