import { ethers } from "../test/helpers/hardhat-connection.js"
import { loadAddresses } from "./utils/file.js"

// Configuration - set via environment variables or update these defaults
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || "MySubAccount"
const ISOLATION_TYPE = Number(process.env.ISOLATION_TYPE || 3) // 0=POSITION, 1=MARKET, 2=MARKET_DIRECTION, 3=CUSTOM
const SINGLE_VA_MODE = process.env.SINGLE_VA_MODE === "true"

async function main() {
	const deployedAddresses = loadAddresses()

	// These can be set via env vars or will fall back to addresses.json (if extended)
	const accountLayerAddress = "0xb5230Cb273299826E991808D34Ef8E1D25349F8D"
	const affiliateAddress = "0xF6aF1Bcb4303FD7d59b637ce01aee0bc1Bcd19c6"
	const symmioCoreAddress = "0xa805FE5baA301D4e72C789694F3967452c77D6fD"

	if (!accountLayerAddress) {
		throw new Error("ACCOUNT_LAYER_ADDRESS environment variable required")
	}
	if (!affiliateAddress) {
		throw new Error("AFFILIATE_ADDRESS environment variable required")
	}
	if (!symmioCoreAddress) {
		throw new Error("SYMMIO_ADDRESS environment variable or symmioAddress in addresses.json required")
	}

	const [signer] = await ethers.getSigners()
	console.log("Using signer:", signer.address)

	const accountLayer = await ethers.getContractAt("contracts/accountLayer/facets/Core/ICoreFacet.sol:ICoreFacet", accountLayerAddress, signer)

	const subAccountData = {
		name: ACCOUNT_NAME,
		metadata: "0x",
		symmioCore: symmioCoreAddress,
		isolationType: ISOLATION_TYPE,
		singleVAMode: SINGLE_VA_MODE,
	}

	console.log("Creating sub-account with config:")
	console.log("  Name:", ACCOUNT_NAME)
	console.log("  Affiliate:", affiliateAddress)
	console.log("  SymmioCore:", symmioCoreAddress)
	console.log("  IsolationType:", ISOLATION_TYPE)
	console.log("  SingleVAMode:", SINGLE_VA_MODE)

	try {
		const tx = await accountLayer.createSubAccounts(affiliateAddress, [subAccountData])
		console.log("Transaction hash:", tx.hash)

		const receipt = await tx.wait()
		console.log("Transaction confirmed in block:", receipt!.blockNumber)

		// Parse the SubAccountCreated event
		const event = receipt!.logs.find((log: any) => {
			try {
				const parsed = accountLayer.interface.parseLog(log)
				return parsed?.name === "SubAccountCreated"
			} catch {
				return false
			}
		})

		if (event) {
			const parsed = accountLayer.interface.parseLog(event)
			console.log("\nSub-account created successfully!")
			console.log("  Address:", parsed!.args[0])
			console.log("  Owner:", parsed!.args[1])
			console.log("  Affiliate:", parsed!.args[2])
			console.log("  Name:", parsed!.args[3])
		}
	} catch (err: any) {
		console.error("Transaction failed!")
		if (err.reason) {
			console.error("Reason:", err.reason)
		} else if (err.errorName) {
			console.error("Custom error:", err.errorName, err.errorArgs)
		} else {
			console.error(err)
		}
		process.exit(1)
	}
}

main()
