/**
 * Upgrade Superflow's SymmioPartyB UUPS proxy on HyperEVM.
 *
 * Dry run:
 *   ./node_modules/.bin/hardhat run scripts/upgrade/upgradeSuperflowPartyB.ts --network hyperevm
 *
 * Execute (live targets and expected state must be explicit):
 *   EXECUTE=true CONFIRM_CHAIN_ID=999 PARTY_B_PROXY=0x... EXPECTED_CURRENT_IMPLEMENTATION=0x... \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/upgradeSuperflowPartyB.ts --network hyperevm
 *
 * Resume after implementation deploy succeeded but verification/upgrade failed:
 *   USE_KEYSTORE=true EXECUTE=true NEW_IMPL_ADDRESS=0x... ./node_modules/.bin/hardhat run scripts/upgrade/upgradeSuperflowPartyB.ts --network hyperevm
 */
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"

import { setHyperEVMBigBlocks } from "../../tasks/deploy/hyperevm.js"
import connection, { ethers, hre } from "../../test/helpers/hardhat-connection.js"
import { exactBooleanEnv, requireExecutionConfirmation } from "./utils/executionGuard.js"

const PARTY_B_NAME = "Superflow"
const DEFAULT_PARTY_B_PROXY = "0xf62a670cda28FfAE65eE2a42D6cf6CF05EC5E775"
const EXPECTED_CHAIN_ID = 999n
const EXECUTE_REQUESTED = exactBooleanEnv("EXECUTE")
const NEW_IMPL_ADDRESS = process.env.NEW_IMPL_ADDRESS

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

function readAddressFromSlotValue(value: string): string {
	return ethers.getAddress(`0x${value.slice(-40)}`)
}

async function readAddressSlot(address: string, slot: string): Promise<string> {
	return readAddressFromSlotValue(await ethers.provider.getStorage(address, slot))
}

async function waitForCode(address: string): Promise<void> {
	for (let attempt = 1; attempt <= 10; attempt++) {
		const code = await ethers.provider.getCode(address)
		if (code !== "0x") return
		console.log("  Waiting for implementation code to be indexed... (attempt %d)", attempt)
		await new Promise(resolve => setTimeout(resolve, 3000))
	}
	throw new Error(`No code found at ${address}`)
}

async function verifyImplementation(address: string): Promise<void> {
	console.log("Verifying new implementation on Hyperevmscan...")
	try {
		await verifyContract(
			{
				address,
				constructorArgs: [],
				contract: "contracts/helpers/accounts/SymmioPartyB.sol:SymmioPartyB",
			},
			hre as any,
		)
		console.log("Scanner:      verified")
	} catch (error: any) {
		const message = error?.message ?? String(error)
		if (message.includes("Already Verified") || message.includes("already verified") || message.includes("already been verified")) {
			console.log("Scanner:      already verified")
			return
		}
		throw new Error(`Scanner verification failed for ${address}: ${message}`)
	}
}

async function main() {
	if (EXECUTE_REQUESTED && (!process.env.PARTY_B_PROXY || !process.env.EXPECTED_CURRENT_IMPLEMENTATION)) {
		throw new Error("EXECUTE=true requires explicit PARTY_B_PROXY and EXPECTED_CURRENT_IMPLEMENTATION; embedded targets are plan-only")
	}
	const proxyAddress = ethers.getAddress(process.env.PARTY_B_PROXY ?? DEFAULT_PARTY_B_PROXY)
	const network = await ethers.provider.getNetwork()
	const EXECUTE = requireExecutionConfirmation(network.chainId)
	if (EXECUTE !== EXECUTE_REQUESTED) throw new Error("Execution mode changed while the proxy-upgrade process was starting")
	const [signer] = EXECUTE ? await ethers.getSigners() : []
	if (EXECUTE && !signer) throw new Error("No upgrade signer is configured")
	const signerAddress = signer
		? ethers.getAddress(await signer.getAddress())
		: process.env.SIGNER_ADDRESS
			? ethers.getAddress(process.env.SIGNER_ADDRESS)
			: undefined
	const isSimulatedNetwork = (connection as any).networkConfig?.type === "edr-simulated"
	let bigBlocksEnabled = false
	let upgradeError: unknown
	let cleanupError: unknown

	if (network.chainId !== EXPECTED_CHAIN_ID) {
		throw new Error(`Refusing to upgrade ${PARTY_B_NAME} on chain ${network.chainId}. Expected HyperEVM chain ${EXPECTED_CHAIN_ID}.`)
	}

	console.log(`\n${PARTY_B_NAME} SymmioPartyB upgrade`)
	console.log("Network:      HyperEVM (%s)", network.chainId.toString())
	console.log("Proxy:        %s", proxyAddress)
	console.log("Signer:       %s", signerAddress ?? "(not configured; role check skipped in plan)")
	console.log("Mode:         %s", EXECUTE ? "EXECUTE" : "DRY RUN")
	console.log("Runtime:      %s", isSimulatedNetwork ? "simulated fork" : "live RPC")
	if (NEW_IMPL_ADDRESS) {
		console.log("Resume impl:  %s", ethers.getAddress(NEW_IMPL_ADDRESS))
	}

	const proxyCode = await ethers.provider.getCode(proxyAddress)
	if (proxyCode === "0x") {
		throw new Error(`No contract code found at ${proxyAddress}`)
	}

	const currentImplementation = await readAddressSlot(proxyAddress, IMPLEMENTATION_SLOT)
	const proxyAdmin = await readAddressSlot(proxyAddress, ADMIN_SLOT)
	if (currentImplementation === ethers.ZeroAddress) {
		throw new Error("Proxy implementation slot is empty")
	}
	if (proxyAdmin !== ethers.ZeroAddress) {
		throw new Error(`Proxy admin slot is ${proxyAdmin}; this script only upgrades UUPS/ERC1967 proxies with an empty admin slot.`)
	}

	console.log("Proxy type:    UUPS/ERC1967")
	console.log("Current impl:  %s", currentImplementation)
	if (EXECUTE) {
		const expectedImplementation = ethers.getAddress(process.env.EXPECTED_CURRENT_IMPLEMENTATION!)
		if (currentImplementation !== expectedImplementation) {
			throw new Error(`Current implementation is ${currentImplementation}, expected ${expectedImplementation}; refusing a stale upgrade plan`)
		}
	}

	const symmioPartyB = await ethers.getContractAt("SymmioPartyB", proxyAddress, signer ?? ethers.provider)
	const hasAdminRole = signerAddress ? await symmioPartyB.hasRole(DEFAULT_ADMIN_ROLE, signerAddress) : false
	if (!signerAddress) {
		console.log("Role check:    skipped; set SIGNER_ADDRESS to include it in the plan")
	} else if (hasAdminRole) {
		console.log("Role check:    signer has DEFAULT_ADMIN_ROLE")
	} else if (EXECUTE) {
		throw new Error(`${signerAddress} does not have DEFAULT_ADMIN_ROLE on ${PARTY_B_NAME} PartyB proxy`)
	} else {
		console.log("Role check:    signer does NOT have DEFAULT_ADMIN_ROLE; EXECUTE=true would fail")
	}

	if (!EXECUTE) {
		console.log("\nPlan complete. Re-run with explicit proxy/current implementation, EXECUTE=true, and CONFIRM_CHAIN_ID=999.")
		return
	}
	if (!signer) throw new Error("Execution signer disappeared before submission")

	try {
		const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB", signer)
		let newImplementationAddress: string
		let newImplementation: any

		if (NEW_IMPL_ADDRESS) {
			newImplementationAddress = ethers.getAddress(NEW_IMPL_ADDRESS)
			console.log("\nReusing deployed SymmioPartyB implementation...")
			await waitForCode(newImplementationAddress)
			newImplementation = SymmioPartyBFactory.attach(newImplementationAddress)
			console.log("New impl:      %s", newImplementationAddress)
		} else {
			if (isSimulatedNetwork) {
				console.log("\nSimulated HyperEVM fork detected; skipping the real HyperCore big-block API.")
			} else {
				console.log("\nEnabling HyperEVM big blocks for implementation deployment...")
				await setHyperEVMBigBlocks(hre, true)
				bigBlocksEnabled = true
			}

			console.log("\nDeploying new SymmioPartyB implementation...")
			newImplementation = await SymmioPartyBFactory.deploy()
			const deploymentTx = newImplementation.deploymentTransaction()
			if (deploymentTx) {
				console.log("Deploy tx:     %s (nonce: %s)", deploymentTx.hash, deploymentTx.nonce)
			}
			await newImplementation.waitForDeployment()
			const deploymentReceipt = deploymentTx ? await deploymentTx.wait() : null
			if (deploymentReceipt && !deploymentReceipt.status) throw new Error(`Implementation deployment failed: ${deploymentTx!.hash}`)
			if (deploymentReceipt) console.log("Deploy receipt: block %s, gas %s", deploymentReceipt.blockNumber, deploymentReceipt.gasUsed)
			newImplementationAddress = await newImplementation.getAddress()
			await waitForCode(newImplementationAddress)
			console.log("New impl:      %s", newImplementationAddress)
		}

		const uuid = await newImplementation.proxiableUUID()
		if (uuid !== IMPLEMENTATION_SLOT) {
			throw new Error(`New implementation returned unexpected proxiableUUID ${uuid}`)
		}
		if (isSimulatedNetwork) console.log("Scanner:      skipped on simulated fork")
		else await verifyImplementation(newImplementationAddress)
		if (currentImplementation === newImplementationAddress) {
			console.log("\nAlready upgraded")
			console.log("Current impl:  %s", currentImplementation)
		} else {
			console.log("Calling upgradeTo...")
			await symmioPartyB.upgradeTo.staticCall(newImplementationAddress)
			const tx = await symmioPartyB.upgradeTo(newImplementationAddress)
			console.log("Tx:            %s (nonce: %s)", tx.hash, tx.nonce)
			const receipt = await tx.wait()
			if (!receipt?.status) throw new Error(`upgradeTo transaction failed: ${tx.hash}`)
			console.log("Receipt:       block %s, gas %s", receipt.blockNumber, receipt.gasUsed)

			const updatedImplementation = await readAddressSlot(proxyAddress, IMPLEMENTATION_SLOT)
			if (updatedImplementation !== newImplementationAddress) {
				throw new Error(`Upgrade verification failed. Slot has ${updatedImplementation}, expected ${newImplementationAddress}`)
			}

			console.log("\nUpgrade complete")
			console.log("Previous impl: %s", currentImplementation)
			console.log("Updated impl:  %s", updatedImplementation)
		}
	} catch (error) {
		upgradeError = error
	} finally {
		if (bigBlocksEnabled) {
			try {
				console.log("\nRestoring HyperEVM fast blocks...")
				await setHyperEVMBigBlocks(hre, false)
			} catch (error) {
				cleanupError = error
				console.error(`Failed to disable big blocks: ${error instanceof Error ? error.message : String(error)}`)
				console.error("Run manually: ./node_modules/.bin/hardhat hyperevm:disable-big-blocks --network hyperevm")
			}
		}
	}

	if (upgradeError !== undefined && cleanupError !== undefined) {
		const primaryMessage = upgradeError instanceof Error ? upgradeError.message : String(upgradeError)
		const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
		const combined = new Error(`PartyB upgrade failed: ${primaryMessage}; HyperEVM big-block cleanup also failed: ${cleanupMessage}`) as Error & {
			upgradeError?: unknown
			cleanupError?: unknown
		}
		combined.upgradeError = upgradeError
		combined.cleanupError = cleanupError
		throw combined
	}
	if (upgradeError !== undefined) throw upgradeError
	if (cleanupError !== undefined) throw cleanupError
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
