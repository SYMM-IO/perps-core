/**
 * Accept AccountLayer diamond ownership with the configured protocolAdmin signer.
 *
 * Use after a deploy-only EOA upgrade run where a hot deployer paid gas and
 * initiated AccountLayer ownership transfer to the hardware-wallet owner.
 *
 * Plan (default):
 *   ./node_modules/.bin/hardhat run scripts/upgrade/acceptAccountLayerOwnership.ts --network coti
 *
 * Execute:
 *   EXECUTE=true CONFIRM_CHAIN_ID=2632500 HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port> \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/acceptAccountLayerOwnership.ts --network coti
 *
 * Env overrides:
 *   ACCOUNT_LAYER_ADDRESS
 *   PERIPHERALS_FILE
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { loadDeploymentState } from "./utils/deploymentState.js"
import { requireExecutionConfirmation } from "./utils/executionGuard.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { DIAMOND_OWNER_ABI, readDiamondOwner } from "./utils/ownership.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { writeTxOverrides } from "./utils/txOverrides.js"

type PeripheralsState = {
	accountLayer?: { diamond?: string }
}

const OUTPUT_DIR = "./scripts/upgrade/output"

async function main() {
	const networkName = connection.networkName
	const networkSuffix = baseNetworkName(networkName)
	const shared = loadUpgradeConfigShared(networkSuffix)
	const diamondAddress = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	await verifyRpc()
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const execute = requireExecutionConfirmation(chainId)
	const peripheralsFile = process.env.PERIPHERALS_FILE ?? path.join(OUTPUT_DIR, `deployed-peripherals-${networkName}.json`)

	let state: PeripheralsState = {}
	if (fs.existsSync(peripheralsFile)) {
		state = loadDeploymentState<PeripheralsState>(peripheralsFile, {
			networkName,
			chainId,
			diamondAddress,
		})
	}

	const accountLayerAddress = process.env.ACCOUNT_LAYER_ADDRESS ?? state.accountLayer?.diamond
	if (!accountLayerAddress || !ethers.isAddress(accountLayerAddress)) {
		throw new Error("ACCOUNT_LAYER_ADDRESS is required or must exist in the deployed peripherals state file")
	}

	const protocolAdmin = shared.protocolAdmin
	if (!protocolAdmin || !ethers.isAddress(protocolAdmin) || protocolAdmin === ethers.ZeroAddress) {
		throw new Error("A non-zero protocolAdmin is required in the network upgrade config")
	}
	const signer = execute
		? await resolveConfiguredSigner({
				role: "protocolAdmin",
				expectedAddress: protocolAdmin,
				envPrefix: "PROTOCOL_ADMIN",
			})
		: undefined
	const signerAddress = signer ? ethers.getAddress(await signer.getAddress()) : ethers.getAddress(protocolAdmin)

	const accountLayer = new ethers.Contract(
		accountLayerAddress,
		[...DIAMOND_OWNER_ABI, "function pendingOwner() view returns (address)", "function acceptOwnership()"],
		signer ?? ethers.provider,
	)

	const owner = await readDiamondOwner(accountLayer)
	if (!owner) throw new Error(`Could not read AccountLayer owner at ${accountLayerAddress}`)
	const pendingOwner = ethers.getAddress(await accountLayer.pendingOwner())

	log.header("Accept AccountLayer Ownership")
	log.kv("AccountLayer", log.addr(ethers.getAddress(accountLayerAddress)))
	log.kv("Signer", log.addr(signerAddress))
	log.kv("Owner", log.addr(owner))
	log.kv("Pending owner", log.addr(pendingOwner))
	log.kv("Mode", execute ? "EXECUTE" : "PLAN ONLY")

	if (owner.toLowerCase() === signerAddress.toLowerCase()) {
		log.ok("Signer is already AccountLayer owner")
		return
	}
	if (pendingOwner.toLowerCase() !== signerAddress.toLowerCase()) {
		throw new Error(`Signer ${signerAddress} is not pending owner. Current pending owner is ${pendingOwner}.`)
	}
	if (!execute) {
		log.warn(`Plan only: ${log.addr(signerAddress)} would call acceptOwnership(). Rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId}.`)
		return
	}

	await accountLayer.acceptOwnership.staticCall(writeTxOverrides())
	const tx = await accountLayer.acceptOwnership(writeTxOverrides())
	log.info(`Submitted acceptOwnership: ${tx.hash} (nonce: ${tx.nonce})`)
	const receipt = await tx.wait()
	if (!receipt?.status) throw new Error(`acceptOwnership transaction failed: ${tx.hash}`)
	const verifiedOwner = await readDiamondOwner(accountLayer)
	if (verifiedOwner !== signerAddress) throw new Error(`Ownership post-check failed: owner is ${verifiedOwner}, expected ${signerAddress}`)
	log.ok(`AccountLayer ownership accepted by ${log.addr(signerAddress)}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
