import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { requireChainConfirmation } from "./executionGuard.js"
import { assertStandaloneDeploymentTaskAllowed, checksumAddress, getConnection, requireArg } from "./helpers.js"
import { logger } from "./logger.js"
import { confirmDeployment, send } from "./tx.js"

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

async function readSlot(ethers: any, proxyAddress: string, slot: string): Promise<string> {
	const value = await ethers.provider.getStorage(proxyAddress, slot)
	return ethers.getAddress("0x" + value.slice(26))
}

export const upgradeProxyTask = task("upgrade:proxy", "Plan a proxy upgrade; execution is limited to local or simulated fork rehearsals")
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
		name: "implementation",
		description: "Reuse an implementation during a local/fork rehearsal (for receipt-timeout recovery)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "dryrun",
		description: "Deprecated safety alias; dry-run is now the default",
		type: ArgumentType.BOOLEAN,
		defaultValue: true,
	})
	.addOption({
		name: "execute",
		description: "Apply the upgrade on a local/simulated network (live RPC execution is refused)",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.setAction(async () => ({
		default: async ({ proxy, contract, implementation, dryrun, execute }, hre) => {
			const { ethers } = await getConnection(hre)
			logger.section("Proxy Upgrade")
			const chainId = (await ethers.provider.getNetwork()).chainId

			const proxyAddress = checksumAddress(requireArg(proxy, "proxy"))
			const contractName = requireArg(contract, "contract")
			const recoveredImplementation = implementation ? checksumAddress(implementation) : undefined
			const proxyCode = await ethers.provider.getCode(proxyAddress)
			if (proxyCode === "0x") throw new Error(`No proxy bytecode exists at ${proxyAddress}`)
			if (recoveredImplementation && (await ethers.provider.getCode(recoveredImplementation)) === "0x") {
				throw new Error(`No implementation bytecode exists at ${recoveredImplementation}`)
			}
			if (execute && dryrun) {
				throw new Error("--execute=true conflicts with --dryrun=true. Pass --dryrun=false explicitly after reviewing the plan.")
			}
			if (execute) {
				await assertStandaloneDeploymentTaskAllowed(
					hre,
					"upgrade:proxy",
					"Generic proxy upgrades cannot prove implementation identity and storage-layout compatibility on a live chain. Use a reviewed target-specific upgrade script.",
				)
				requireChainConfirmation(chainId, "--execute=true")
			}

			// Read current implementation and admin slots
			const currentImpl = await readSlot(ethers, proxyAddress, IMPLEMENTATION_SLOT)
			const adminSlot = await readSlot(ethers, proxyAddress, ADMIN_SLOT)
			if (currentImpl === ethers.ZeroAddress) throw new Error(`${proxyAddress} has no EIP-1967 implementation slot`)

			const isUUPS = adminSlot === ethers.ZeroAddress
			const proxyType = isUUPS ? "UUPS" : "Transparent"

			logger.info(`Proxy:          ${proxyAddress}`)
			logger.info(`Chain ID:       ${chainId}`)
			logger.info(`Proxy type:     ${proxyType}`)
			logger.info(`Current impl:   ${currentImpl}`)
			logger.info(`Next impl:      ${recoveredImplementation || "deploy new"}`)
			if (!isUUPS) {
				logger.info(`ProxyAdmin:     ${adminSlot}`)
			}

			// Deploy new implementation
			const factory = await ethers.getContractFactory(contractName)

			if (!execute || dryrun) {
				logger.info("")
				if (recoveredImplementation) logger.info("[DRY RUN] Would reuse implementation %s", recoveredImplementation)
				else logger.info("[DRY RUN] Would deploy new implementation of %s", contractName)
				if (isUUPS) {
					logger.info("[DRY RUN] Would call proxy.upgradeToAndCall(newImpl, 0x)")
				} else {
					logger.info("[DRY RUN] Would call ProxyAdmin(%s).upgradeAndCall(proxy, newImpl, 0x)", adminSlot)
				}
				logger.info(
					`[DRY RUN] On a local or simulated fork only, re-run with --execute=true --dryrun=false and CONFIRM_CHAIN_ID=${chainId} after reviewing this plan.`,
				)
				return
			}

			let newImplAddress = recoveredImplementation
			if (!newImplAddress) {
				logger.info("")
				logger.info("Deploying new implementation...")
				const newImpl = await factory.deploy()
				newImplAddress = await confirmDeployment(newImpl, `${contractName} implementation`)
			} else {
				logger.info("")
				logger.info(`Reusing implementation ${newImplAddress}`)
			}

			// Wait for implementation to be visible to RPC node (L2 race condition)
			for (let attempt = 0; attempt < 10; attempt++) {
				const code = await ethers.provider.getCode(newImplAddress)
				if (code !== "0x") break
				console.log("  Waiting for implementation to be indexed by RPC... (attempt %d)", attempt + 1)
				await new Promise(r => setTimeout(r, 3000))
			}
			if ((await ethers.provider.getCode(newImplAddress)) === "0x") {
				throw new Error(`New implementation bytecode is still unavailable at ${newImplAddress}`)
			}
			if (newImplAddress.toLowerCase() === currentImpl.toLowerCase()) {
				logger.info(`Proxy already uses implementation ${newImplAddress}; no upgrade transaction sent.`)
				return
			}

			logger.deployed("New Implementation", newImplAddress)

			if (isUUPS) {
				const candidate = await ethers.getContractAt(["function proxiableUUID() view returns (bytes32)"], newImplAddress)
				const uuid = await candidate.proxiableUUID()
				if (uuid.toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase()) {
					throw new Error(`New implementation proxiableUUID is ${uuid}, expected ${IMPLEMENTATION_SLOT}`)
				}
				// OpenZeppelin 5 exposes only upgradeToAndCall; empty data performs no delegate call.
				logger.info("Calling upgradeToAndCall on proxy...")
				const proxyContract = await ethers.getContractAt(contractName, proxyAddress)
				await proxyContract.upgradeToAndCall.staticCall(newImplAddress, "0x")
				await send(proxyContract.upgradeToAndCall(newImplAddress, "0x"), `upgradeToAndCall(${contractName})`)
			} else {
				// OpenZeppelin 5 ProxyAdmin exposes only upgradeAndCall.
				logger.info("Calling ProxyAdmin.upgradeAndCall...")
				const proxyAdmin = await ethers.getContractAt("IProxyAdmin", adminSlot)
				await proxyAdmin.upgradeAndCall.staticCall(proxyAddress, newImplAddress, "0x")
				await send(proxyAdmin.upgradeAndCall(proxyAddress, newImplAddress, "0x"), `ProxyAdmin.upgradeAndCall(${contractName})`)
			}

			// Verify
			const updatedImpl = await readSlot(ethers, proxyAddress, IMPLEMENTATION_SLOT)
			if (updatedImpl.toLowerCase() !== newImplAddress.toLowerCase()) {
				throw new Error(`Upgrade verification failed: implementation slot is ${updatedImpl}, expected ${newImplAddress}`)
			}
			logger.info("")
			logger.info("Upgrade complete!")
			logger.info(`New impl:       ${updatedImpl}`)
		},
	}))
	.build()
