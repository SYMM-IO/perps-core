import hre from "hardhat"

// ─── Configuration ──────────────────────────────────────────────────────────

const VERIFIER_ADDRESS = "0x0000000000000000000000000000000000000000" // MuonSignatureVerifier address

// Set ONE of these depending on what you're configuring:
const PUBLIC_KEY = { x: "0x0", parity: 0 } // TSS public key (set x to "0x0" to skip)
const GATEWAY_SIGNER = "0x0000000000000000000000000000000000000000" // Gateway signer address (set to zero to skip)

// Comment out lines to remove permissions from the list.
// Only the uncommented categories will be granted.
const FUNCTIONS = [
	0, // Trading           (SendQuote, LockQuote, OpenPosition, FillCloseRequest, FillCloseRequestToLiquidation, EmergencyClosePosition, OpenPositions, ClosePositions)
	1, // AccountManagement (Deallocate, SafeDeallocate, DeallocateForPartyB, TransferAllocation)
	2, // Settlement        (SettleUpnl, SettleUpnlUnified)
	3, // ForceClose        (ForceClose, InitializeForceClose, SettleUpnlForForceClose, SettleUpnlForForceCloseLegacy, FinalizeForceClose)
	4, // Funding           (ChargeFundingRate, ChargeAccumulatedFundingFee)
	5, // LiquidationPartyA (LiquidatePartyA, SetSymbolsPrice, DeferredLiquidatePartyA, DeferredSetSymbolsPrice)
	6, // LiquidationPartyB (LiquidatePartyB, LiquidatePositionsPartyB)
]

// Set to false to revoke the listed permissions instead of granting them
const ALLOWED = true

// ─── Script ─────────────────────────────────────────────────────────────────

const FUNCTION_NAMES = ["Trading", "AccountManagement", "Settlement", "ForceClose", "Funding", "LiquidationPartyA", "LiquidationPartyB"]

async function main() {
	const { ethers } = await hre.network.connect()
	const [signer] = await ethers.getSigners()
	console.log("Signer:", signer.address)

	const verifier = await ethers.getContractAt("MuonSignatureVerifier", VERIFIER_ADDRESS)

	const action = ALLOWED ? "Granting" : "Revoking"
	const funcNames = FUNCTIONS.map(f => FUNCTION_NAMES[f]).join(", ")
	console.log(`\n${action} permissions for: ${funcNames}`)

	// Configure public key
	if (PUBLIC_KEY.x !== "0x0") {
		const pubKey = { x: PUBLIC_KEY.x, parity: PUBLIC_KEY.parity }

		// Check if key exists, add if not
		const existingKeys = await verifier.getAllPublicKeys()
		const keyExists = existingKeys.some((k: any) => k.x.toString() === BigInt(PUBLIC_KEY.x).toString() && Number(k.parity) === PUBLIC_KEY.parity)

		if (!keyExists) {
			console.log("\nAdding public key...")
			const addTx = await verifier.connect(signer).addPublicKey(pubKey)
			await addTx.wait()
			console.log("  Added public key, tx:", addTx.hash)
		} else {
			console.log("\nPublic key already registered")
		}

		console.log(`${action} public key permissions...`)
		const tx = await verifier.connect(signer).setPublicKeyPermissions(pubKey, FUNCTIONS, ALLOWED)
		await tx.wait()
		console.log("  tx:", tx.hash)
	}

	// Configure gateway signer
	if (GATEWAY_SIGNER !== "0x0000000000000000000000000000000000000000") {
		// Check if signer exists, add if not
		const existingSigners = await verifier.getAllGatewaySigners()
		const signerExists = existingSigners.some((s: string) => s.toLowerCase() === GATEWAY_SIGNER.toLowerCase())

		if (!signerExists) {
			console.log("\nAdding gateway signer...")
			const addTx = await verifier.connect(signer).addGatewaySigner(GATEWAY_SIGNER)
			await addTx.wait()
			console.log("  Added gateway signer, tx:", addTx.hash)
		} else {
			console.log("\nGateway signer already registered")
		}

		console.log(`${action} gateway signer permissions...`)
		const tx = await verifier.connect(signer).setGatewaySignerPermissions(GATEWAY_SIGNER, FUNCTIONS, ALLOWED)
		await tx.wait()
		console.log("  tx:", tx.hash)
	}

	console.log("\nDone!")
}

main().catch(console.error)
