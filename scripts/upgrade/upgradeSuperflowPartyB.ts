/**
 * Upgrade Superflow's SymmioPartyB UUPS proxy on HyperEVM.
 *
 * Dry run:
 *   npx hardhat run scripts/upgrade/upgradeSuperflowPartyB.ts --network hyperevm
 *
 * Execute:
 *   EXECUTE=true npx hardhat run scripts/upgrade/upgradeSuperflowPartyB.ts --network hyperevm
 *
 * Resume after implementation deploy succeeded but verification/upgrade failed:
 *   USE_KEYSTORE=true EXECUTE=true NEW_IMPL_ADDRESS=0x... npx hardhat run scripts/upgrade/upgradeSuperflowPartyB.ts --network hyperevm
 */
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"

import { setHyperEVMBigBlocks } from "../../tasks/deploy/hyperevm.js"
import { ethers, hre } from "../../test/helpers/hardhat-connection.js"

const PARTY_B_NAME = "Superflow"
const PARTY_B_PROXY = "0xf62a670cda28FfAE65eE2a42D6cf6CF05EC5E775"
const EXPECTED_CHAIN_ID = 999n
const EXECUTE = process.env.EXECUTE === "true"
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
	const proxyAddress = ethers.getAddress(PARTY_B_PROXY)
	const [signer] = await ethers.getSigners()
	const signerAddress = await signer.getAddress()
	const network = await ethers.provider.getNetwork()
	let bigBlocksEnabled = false

	if (network.chainId !== EXPECTED_CHAIN_ID) {
		throw new Error(`Refusing to upgrade ${PARTY_B_NAME} on chain ${network.chainId}. Expected HyperEVM chain ${EXPECTED_CHAIN_ID}.`)
	}

	console.log(`\n${PARTY_B_NAME} SymmioPartyB upgrade`)
	console.log("Network:      HyperEVM (%s)", network.chainId.toString())
	console.log("Proxy:        %s", proxyAddress)
	console.log("Signer:       %s", signerAddress)
	console.log("Mode:         %s", EXECUTE ? "EXECUTE" : "DRY RUN")
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

	const symmioPartyB = await ethers.getContractAt("SymmioPartyB", proxyAddress, signer)
	const hasAdminRole = await symmioPartyB.hasRole(DEFAULT_ADMIN_ROLE, signerAddress)
	if (hasAdminRole) {
		console.log("Role check:    signer has DEFAULT_ADMIN_ROLE")
	} else if (EXECUTE) {
		throw new Error(`${signerAddress} does not have DEFAULT_ADMIN_ROLE on ${PARTY_B_NAME} PartyB proxy`)
	} else {
		console.log("Role check:    signer does NOT have DEFAULT_ADMIN_ROLE; EXECUTE=true would fail")
	}

	if (!EXECUTE) {
		console.log("\nDry run complete. Re-run with EXECUTE=true to deploy a new implementation and call upgradeTo.")
		return
	}

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
			console.log("\nEnabling HyperEVM big blocks for implementation deployment...")
			await setHyperEVMBigBlocks(hre, true)
			bigBlocksEnabled = true

			console.log("\nDeploying new SymmioPartyB implementation...")
			newImplementation = await SymmioPartyBFactory.deploy()
			const deploymentTx = newImplementation.deploymentTransaction()
			if (deploymentTx) {
				console.log("Deploy tx:     %s", deploymentTx.hash)
			}
			await newImplementation.waitForDeployment()
			newImplementationAddress = await newImplementation.getAddress()
			await waitForCode(newImplementationAddress)
			console.log("New impl:      %s", newImplementationAddress)
		}

		const uuid = await newImplementation.proxiableUUID()
		if (uuid !== IMPLEMENTATION_SLOT) {
			throw new Error(`New implementation returned unexpected proxiableUUID ${uuid}`)
		}
		await verifyImplementation(newImplementationAddress)
		if (currentImplementation === newImplementationAddress) {
			console.log("\nAlready upgraded")
			console.log("Current impl:  %s", currentImplementation)
			return
		}

		console.log("Calling upgradeTo...")
		const tx = await symmioPartyB.upgradeTo(newImplementationAddress)
		console.log("Tx:            %s", tx.hash)
		await tx.wait()

		const updatedImplementation = await readAddressSlot(proxyAddress, IMPLEMENTATION_SLOT)
		if (updatedImplementation !== newImplementationAddress) {
			throw new Error(`Upgrade verification failed. Slot has ${updatedImplementation}, expected ${newImplementationAddress}`)
		}

		console.log("\nUpgrade complete")
		console.log("Previous impl: %s", currentImplementation)
		console.log("Updated impl:  %s", updatedImplementation)
	} finally {
		if (bigBlocksEnabled) {
			try {
				console.log("\nRestoring HyperEVM fast blocks...")
				await setHyperEVMBigBlocks(hre, false)
			} catch (error: any) {
				console.error(`Failed to disable big blocks: ${error.message}`)
				console.error("Run manually: npx hardhat hyperevm:disable-big-blocks --network hyperevm")
			}
		}
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
