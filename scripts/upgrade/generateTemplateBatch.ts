/**
 * Generate a Safe batch to add InstantLayer templates.
 *
 * Reads template definitions from a config file and produces a Safe Transaction
 * Builder JSON that calls addTemplate() on the InstantLayer contract.
 * The Safe (protocolAdmin) must have SETTER_ROLE on InstantLayer.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/generateTemplateBatch.ts --network <network>
 *
 * Config:
 *   scripts/upgrade/config/upgrade.json                 -- diamondAddress, safeAddress, instantLayerAddress
 *   scripts/upgrade/config/instantLayerTemplates.json   -- template definitions
 *
 * Output:
 *   scripts/upgrade/output/add-templates-safe-batch.json
 */
import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch } from "./utils/upgradeHelpers.js"

type OperationConfig = {
	insertionPoints: number[]
	sourceIndices: number[]
	sourceOffsets: number[]
}

type TemplateConfig = {
	name: string
	operations: OperationConfig[]
}

type TemplatesFileConfig = {
	templates: TemplateConfig[]
}

type DeployedPeripherals = {
	instantLayer?: { address?: string }
}

const TEMPLATES_CONFIG_FILE = process.env.TEMPLATES_CONFIG_FILE ?? "./scripts/upgrade/config/instantLayerTemplates.json"
const OUTPUT_DIR = "./scripts/upgrade/output"
const PERIPHERALS_FILE = process.env.PERIPHERALS_FILE ?? path.join(OUTPUT_DIR, "deployed-peripherals.json")

const INSTANT_LAYER_ABI = [
	"function addTemplate(string name, tuple(uint256[] insertionPoints, uint256[] sourceIndices, uint256[] sourceOffsets)[] operations)",
]

const instantLayerIface = new ethers.Interface(INSTANT_LAYER_ABI)

async function main() {
	const shared = loadUpgradeConfigShared()

	let peripherals: DeployedPeripherals = {}
	if (fs.existsSync(PERIPHERALS_FILE)) {
		peripherals = JSON.parse(fs.readFileSync(PERIPHERALS_FILE, "utf-8"))
	}

	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? shared.safeAddress
	const IL_ADDRESS = process.env.INSTANT_LAYER_ADDRESS ?? (shared.instantLayerAddress || peripherals.instantLayer?.address)

	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("SAFE_ADDRESS is required (env var or config)")
	}
	if (!IL_ADDRESS || !ethers.isAddress(IL_ADDRESS)) {
		throw new Error("INSTANT_LAYER_ADDRESS is required (env var or config)")
	}
	if (!fs.existsSync(TEMPLATES_CONFIG_FILE)) {
		throw new Error(`Templates config not found: ${TEMPLATES_CONFIG_FILE}`)
	}

	const templatesConfig: TemplatesFileConfig = JSON.parse(fs.readFileSync(TEMPLATES_CONFIG_FILE, "utf-8"))

	if (!templatesConfig.templates || templatesConfig.templates.length === 0) {
		throw new Error("No templates defined in config file")
	}

	const CHAIN_ID = String(Number((await ethers.provider.getNetwork()).chainId))

	console.log(`InstantLayer: ${IL_ADDRESS}`)
	console.log(`Safe:         ${SAFE_ADDRESS}`)
	console.log(`Chain ID:     ${CHAIN_ID}`)
	console.log(`Templates:    ${templatesConfig.templates.length}`)
	console.log(`Config:       ${TEMPLATES_CONFIG_FILE}`)
	console.log()

	const safeTxs = []
	const breakdown: string[] = []

	for (const template of templatesConfig.templates) {
		if (!template.name || !template.operations || template.operations.length === 0) {
			throw new Error(`Invalid template: ${JSON.stringify(template)}`)
		}

		for (let i = 0; i < template.operations.length; i++) {
			const op = template.operations[i]
			if (op.sourceIndices.length !== op.insertionPoints.length || op.sourceIndices.length !== op.sourceOffsets.length) {
				throw new Error(`Template "${template.name}" op ${i}: insertionPoints, sourceIndices, and sourceOffsets must have equal length`)
			}
			for (const idx of op.sourceIndices) {
				if (idx >= i) {
					throw new Error(`Template "${template.name}" op ${i}: sourceIndex ${idx} references a non-preceding operation`)
				}
			}
		}

		const tx = toHumanReadableSafeTxFromIface(instantLayerIface, IL_ADDRESS, "addTemplate", [template.name, template.operations])
		safeTxs.push(tx)
		breakdown.push(`addTemplate("${template.name}", ${template.operations.length} ops)`)
		console.log(`  ${breakdown.length}. ${breakdown[breakdown.length - 1]}`)
	}

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio v0.8.5 — Add InstantLayer Templates",
			description: `Add ${safeTxs.length} templates to InstantLayer at ${IL_ADDRESS}`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: SAFE_ADDRESS,
			createdFromOwnerAddress: "",
		},
		transactions: safeTxs,
	}

	const outFile = path.join(OUTPUT_DIR, "add-templates-safe-batch.json")
	fs.writeFileSync(outFile, JSON.stringify(batch, null, 2))
	console.log(`\nSafe batch: ${outFile}`)

	console.log("\nExecution:")
	console.log("  1. Import add-templates-safe-batch.json into Safe → sign & execute")
	console.log(`  NOTE: The Safe (${SAFE_ADDRESS}) must have SETTER_ROLE on InstantLayer (${IL_ADDRESS})`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
