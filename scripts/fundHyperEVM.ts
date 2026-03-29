import hre from "hardhat"

import { getConnection } from "../tasks/deploy/helpers.js"

async function main() {
	const { ethers } = await getConnection(hre)
	const [funder] = await ethers.getSigners()

	console.log(`Funder: ${funder.address}`)
	console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(funder.address))} HYPE\n`)

	// Fetch HYPE price to calculate $1 worth
	const res = await fetch("https://api.hyperliquid.xyz/info", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: "allMids" }),
	})
	const mids: Record<string, string> = await res.json()
	const hypePrice = parseFloat(mids["HYPE"])
	if (!hypePrice) {
		console.error("Could not fetch HYPE price")
		process.exit(1)
	}

	const amountHype = 1 / hypePrice
	const amountWei = ethers.parseEther(amountHype.toFixed(18))
	console.log(`HYPE price: $${hypePrice}`)
	console.log(`Sending ${amountHype.toFixed(6)} HYPE (~$1) to each wallet\n`)

	const wallets = []
	for (let i = 0; i < 5; i++) {
		const w = ethers.Wallet.createRandom()
		wallets.push({ address: w.address, privateKey: w.privateKey })
	}

	console.log("=== Generated Wallets ===")
	wallets.forEach((w, i) => {
		console.log(`[${i + 1}] ${w.address}`)
		console.log(`    PK: ${w.privateKey}`)
	})
	console.log()

	for (const w of wallets) {
		const tx = await funder.sendTransaction({
			to: w.address,
			value: amountWei,
		})
		console.log(`Sent to ${w.address} — tx: ${tx.hash}`)
		await tx.wait()
	}

	console.log("\nDone!")
}

main().catch(console.error)
