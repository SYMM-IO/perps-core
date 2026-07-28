import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { checksumAddress, getConnection } from "./helpers.js"
import { logger } from "./logger.js"

type ConfigureTransientContextArgs = {
	diamond: string
	accountlayer: string
	instantlayer: string
	enabled: boolean
	dryrun: boolean
}

/**
 * Configures an already-deployed InstantLayer address on upgraded core and
 * AccountLayer diamonds. It never deploys or replaces InstantLayer, preserving
 * the EIP-712 verifying contract, templates, nonces, and signed operations.
 */
export const configureTransientContextTask = task(
	"configure:transient-context",
	"Route an existing InstantLayer's legacy setter sequence through transient state",
)
	.addOption({ name: "diamond", description: "Core Diamond address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({
		name: "accountlayer",
		description: "AccountLayer Diamond address",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "instantlayer",
		description: "Existing InstantLayer address",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "enabled", description: "Enable or disable the compatibility route", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({ name: "dryrun", description: "Validate and report without sending transactions", type: ArgumentType.BOOLEAN, defaultValue: false })
	.setAction(async () => ({
		default: async ({ diamond, accountlayer, instantlayer, enabled, dryrun }: ConfigureTransientContextArgs, hre) => {
			const { ethers } = await getConnection(hre)
			const coreAddress = checksumAddress(diamond)
			const accountLayerAddress = checksumAddress(accountlayer)
			const instantLayerAddress = checksumAddress(instantlayer)

			const core = await ethers.getContractAt("contracts/core/facets/Control/IControlFacet.sol:IControlFacet", coreAddress)
			const accountLayer = await ethers.getContractAt("contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet", accountLayerAddress)

			const currentCore = await core.legacyExecutionContextAdapterEnabled(instantLayerAddress)
			const currentAccountLayer = await accountLayer.legacySignerAdapterEnabled(instantLayerAddress)

			logger.section("Transaction Context Compatibility")
			logger.info(`Core Diamond:          ${coreAddress}`)
			logger.info(`AccountLayer:          ${accountLayerAddress}`)
			logger.info(`Existing InstantLayer: ${instantLayerAddress}`)
			logger.info(`Requested state:       ${enabled}`)
			logger.info(`Current core state:    ${currentCore}`)
			logger.info(`Current AL state:      ${currentAccountLayer}`)

			if (dryrun) {
				logger.info("[DRY RUN] No transactions sent")
				return
			}

			if (currentCore !== enabled) {
				await (await core.setLegacyExecutionContextAdapter(instantLayerAddress, enabled)).wait()
			}
			if (currentAccountLayer !== enabled) {
				await (await accountLayer.setLegacySignerAdapter(instantLayerAddress, enabled)).wait()
			}

			const configuredCore = await core.legacyExecutionContextAdapterEnabled(instantLayerAddress)
			const configuredAccountLayer = await accountLayer.legacySignerAdapterEnabled(instantLayerAddress)
			if (configuredCore !== enabled || configuredAccountLayer !== enabled) {
				throw new Error("Transaction-context compatibility verification failed")
			}

			logger.info("Transaction-context compatibility configured and verified")
		},
	}))
	.build()
