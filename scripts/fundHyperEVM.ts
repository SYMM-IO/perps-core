import hre from "hardhat"

import { getConnection } from "../tasks/deploy/helpers.js"
import { requireExecutionConfirmation } from "./upgrade/utils/executionGuard.js"

// Plan-only wallet funding for HyperEVM (chainId 999).
// Required: DESTINATION_ADDRESSES=0x...,0x... and AMOUNT_HYPE=<decimal>.
// Set EXECUTE=true CONFIRM_CHAIN_ID=999 after reviewing the complete destination list.

function parseDestinations(ethers: any): string[] {
	const raw = process.env.DESTINATION_ADDRESSES
	if (!raw) throw new Error("DESTINATION_ADDRESSES is required (comma-separated existing wallet addresses)")
	const addresses = raw
		.split(",")
		.map(value => value.trim())
		.filter(Boolean)
		.map(value => {
			if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`Invalid destination address: ${value}`)
			return ethers.getAddress(value)
		})
	if (addresses.length === 0) throw new Error("DESTINATION_ADDRESSES contains no addresses")
	if (addresses.length > 100) throw new Error("Refusing to fund more than 100 addresses in one run")
	if (new Set(addresses).size !== addresses.length) throw new Error("DESTINATION_ADDRESSES contains duplicate addresses")
	return addresses
}

async function main(): Promise<void> {
	const { ethers } = await getConnection(hre)
	const network = await ethers.provider.getNetwork()
	if (network.chainId !== 999n) throw new Error(`fundHyperEVM.ts only supports HyperEVM chainId 999; connected to ${network.chainId}`)
	const execute = requireExecutionConfirmation(network.chainId)
	const destinations = parseDestinations(ethers)
	const amountRaw = process.env.AMOUNT_HYPE
	if (!amountRaw || !/^\d+(\.\d{1,18})?$/.test(amountRaw)) throw new Error("AMOUNT_HYPE is required as a positive decimal with at most 18 decimals")
	const amountWei = ethers.parseEther(amountRaw)
	if (amountWei <= 0n) throw new Error("AMOUNT_HYPE must be greater than zero")

	const [availableSigner] = await ethers.getSigners()
	const configuredFunder = process.env.FUNDER_ADDRESS
	const funderAddress = configuredFunder
		? ethers.getAddress(configuredFunder)
		: availableSigner
			? ethers.getAddress(await availableSigner.getAddress())
			: undefined
	if (!funderAddress) throw new Error("FUNDER_ADDRESS is required for planning when no signer is configured")
	if (execute && !availableSigner) throw new Error("No funder signer is configured")
	if (execute && ethers.getAddress(await availableSigner!.getAddress()) !== funderAddress) {
		throw new Error(`Configured FUNDER_ADDRESS ${funderAddress} does not match execution signer ${await availableSigner!.getAddress()}`)
	}
	if (destinations.includes(funderAddress)) throw new Error("DESTINATION_ADDRESSES must not include the funder itself")
	const startingBalances = new Map<string, bigint>()
	for (const address of destinations) {
		if ((await ethers.provider.getCode(address)) !== "0x")
			throw new Error(`Destination ${address} is a contract; this wallet-funding script only permits EOAs`)
		startingBalances.set(address, await ethers.provider.getBalance(address))
	}

	const total = amountWei * BigInt(destinations.length)
	const funderBalance = await ethers.provider.getBalance(funderAddress)
	if (funderBalance <= total) throw new Error(`Funder balance ${funderBalance} is not enough for value ${total} plus transaction fees`)

	console.log("HyperEVM wallet-funding plan")
	console.log(`  Funder:        ${funderAddress}`)
	console.log(`  Funder balance:${ethers.formatEther(funderBalance)} HYPE`)
	console.log(`  Per wallet:    ${ethers.formatEther(amountWei)} HYPE`)
	console.log(`  Wallets:       ${destinations.length}`)
	console.log(`  Total value:   ${ethers.formatEther(total)} HYPE`)
	for (const address of destinations) console.log(`    ${address}`)

	if (!execute) {
		console.log("\nPLAN ONLY: no funds sent. Set EXECUTE=true CONFIRM_CHAIN_ID=999 after reviewing every destination.")
		return
	}
	const funder = availableSigner!

	for (const address of destinations) {
		const tx = await funder.sendTransaction({ to: address, value: amountWei })
		console.log(`Sent to ${address}: ${tx.hash} (nonce ${tx.nonce})`)
		const receipt = await tx.wait()
		if (!receipt?.status) throw new Error(`Funding transaction ${tx.hash} failed`)
		console.log(`Confirmed in block ${receipt.blockNumber}; gas ${receipt.gasUsed}`)
		const after = await ethers.provider.getBalance(address)
		const expectedMinimum = startingBalances.get(address)! + amountWei
		if (after < expectedMinimum)
			throw new Error(`Post-state verification failed for ${address}: balance ${after}, expected at least ${expectedMinimum}`)
	}
	console.log(`Funded and verified ${destinations.length} wallet(s).`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
