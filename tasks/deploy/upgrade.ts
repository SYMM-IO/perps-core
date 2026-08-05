import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { checksumAddress, getConnection, requireArg } from "./helpers.js"
import { logger } from "./logger.js"

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

async function readSlot(ethers: any, proxyAddress: string, slot: string): Promise<string> {
	const value = await ethers.provider.getStorage(proxyAddress, slot)
	return ethers.getAddress("0x" + value.slice(26))
}

export const upgradeProxyTask = task("upgrade:proxy", "Upgrade a UUPS or Transparent proxy to a new implementation")
	.addOption({
		name: "proxy",
		description: "The proxy contract address",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "contract",
		description: "The contract name to deploy as new implementation (e.g. MultiAccount)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "dryrun",
		description: "Only print what would be done, do not execute",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.setAction(async () => ({
		default: async ({ proxy, contract, dryrun }, hre) => {
			const { ethers } = await getConnection(hre)
			logger.section("Proxy Upgrade")

			const proxyAddress = checksumAddress(requireArg(proxy, "proxy"))

			// Read current implementation and admin slots
			const currentImpl = await readSlot(ethers, proxyAddress, IMPLEMENTATION_SLOT)
			const adminSlot = await readSlot(ethers, proxyAddress, ADMIN_SLOT)

			const isUUPS = adminSlot === ethers.ZeroAddress
			const proxyType = isUUPS ? "UUPS" : "Transparent"

			logger.info(`Proxy:          ${proxyAddress}`)
			logger.info(`Proxy type:     ${proxyType}`)
			logger.info(`Current impl:   ${currentImpl}`)
			if (!isUUPS) {
				logger.info(`ProxyAdmin:     ${adminSlot}`)
			}

			// Deploy new implementation
			const factory = await ethers.getContractFactory(contract)

			if (dryrun) {
				logger.info("")
				logger.info("[DRY RUN] Would deploy new implementation of %s", contract)
				if (isUUPS) {
					logger.info("[DRY RUN] Would call proxy.upgradeTo(newImpl)")
				} else {
					logger.info("[DRY RUN] Would call ProxyAdmin(%s).upgrade(proxy, newImpl)", adminSlot)
				}
				return
			}

			logger.info("")
			logger.info("Deploying new implementation...")
			const newImpl = await factory.deploy()
			await newImpl.waitForDeployment()
			const newImplAddress = await newImpl.getAddress()

			// Wait for implementation to be visible to RPC node (L2 race condition)
			for (let attempt = 0; attempt < 10; attempt++) {
				const code = await ethers.provider.getCode(newImplAddress)
				if (code !== "0x") break
				console.log("  Waiting for implementation to be indexed by RPC... (attempt %d)", attempt + 1)
				await new Promise(r => setTimeout(r, 3000))
			}

			logger.deployed("New Implementation", newImplAddress)

			if (isUUPS) {
				// UUPS: call upgradeTo directly on the proxy
				// Note: OZ v4.x upgradeToAndCall with empty data forces a delegate call that reverts
				// (no fallback function), so use upgradeTo instead
				logger.info("Calling upgradeTo on proxy...")
				const proxyContract = await ethers.getContractAt(contract, proxyAddress)
				const tx = await proxyContract.upgradeTo(newImplAddress)
				await tx.wait()
			} else {
				// Transparent: call ProxyAdmin.upgrade
				// Note: OZ v4.x upgradeAndCall with empty data forces a delegate call that reverts
				// (no fallback function), so use upgrade instead
				logger.info("Calling ProxyAdmin.upgrade...")
				const proxyAdmin = await ethers.getContractAt("IProxyAdmin", adminSlot)
				const tx = await proxyAdmin.upgrade(proxyAddress, newImplAddress)
				await tx.wait()
			}

			// Verify
			const updatedImpl = await readSlot(ethers, proxyAddress, IMPLEMENTATION_SLOT)
			logger.info("")
			logger.info("Upgrade complete!")
			logger.info(`New impl:       ${updatedImpl}`)
		},
	}))
	.build()
