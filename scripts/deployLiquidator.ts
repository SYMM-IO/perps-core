import { tasks } from "hardhat"

import { setHyperEVMBigBlocks } from "../tasks/deploy/hyperevm.js"
// Initialize the hardhat connection
import { hre, ethers } from "../test/helpers/hardhat-connection.js"
import { loadAddresses } from "./utils/file.js"

const HYPEREVM_CHAIN_IDS = new Set<bigint>([998n, 999n])

const deployedAddresses = loadAddresses()
const symmioAddress = process.env.SYMMIO_ADDRESS || deployedAddresses.symmioAddress
const admin = process.env.ADMIN_PUBLIC_KEY
const operatorsEnv = process.env.OPERATORS || ""

if (!symmioAddress) throw new Error("Missing SYMMIO_ADDRESS (env) or symmioAddress in output/addresses.json")
if (!admin) throw new Error("Missing ADMIN_PUBLIC_KEY env var")

const operators = operatorsEnv
	.split(",")
	.map(a => a.trim())
	.filter(Boolean)

const chainId = (await ethers.provider.getNetwork()).chainId
const isHyperEVM = HYPEREVM_CHAIN_IDS.has(chainId)

if (isHyperEVM) {
	console.log(`Detected HyperEVM (chainId ${chainId}) — enabling big blocks before deploy...`)
	await setHyperEVMBigBlocks(hre, true)
	console.log("")
}

let liquidatorAddress: string
try {
	const contract = await tasks.getTask("deploy:symmioLiquidator").run({
		symmioAddress,
		admin,
		logData: true,
	})
	liquidatorAddress = (await contract.getAddress?.()) || contract.address
	console.log("SymmioLiquidator deployed at:", liquidatorAddress)

	if (operators.length === 0) {
		console.log("")
		console.log("⚠ No OPERATORS env var provided — skipping operator registration.")
		console.log("  To register operators later, set OPERATORS=0xaaa,0xbbb,0xccc and re-run,")
		console.log("  or call grantRole(OPERATOR_ROLE, <operator>) on the SymmioLiquidator.")
	} else {
		console.log("")
		console.log(`Registering ${operators.length} operator(s)...`)

		const [deployer] = await ethers.getSigners()
		console.log("  Using signer:", deployer.address)

		// ----- 1. Grant OPERATOR_ROLE on SymmioLiquidator -----
		const liquidator = await ethers.getContractAt("SymmioLiquidator", liquidatorAddress)
		const OPERATOR_ROLE = await liquidator.OPERATOR_ROLE()

		for (const op of operators) {
			const already = await liquidator.hasRole(OPERATOR_ROLE, op)
			if (already) {
				console.log(`  ⏭ ${op} already has OPERATOR_ROLE on SymmioLiquidator`)
				continue
			}
			const tx = await liquidator.grantRole(OPERATOR_ROLE, op)
			await tx.wait()
			console.log(`  ✓ Granted OPERATOR_ROLE on SymmioLiquidator to ${op}`)
		}

		// ----- 2. Grant LIQUIDATOR_ROLE + PARTYB_LIQUIDATOR_ROLE on Core -----
		//       The liquidator CONTRACT is the msg.sender seen by core, so the contract
		//       address is what needs the role — not the operator EOAs.
		const control = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", symmioAddress)
		const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", symmioAddress)

		const LIQUIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATOR_ROLE"))
		const PARTYB_LIQUIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PARTYB_LIQUIDATOR_ROLE"))

		for (const [roleName, roleHash] of [
			["LIQUIDATOR_ROLE", LIQUIDATOR_ROLE],
			["PARTYB_LIQUIDATOR_ROLE", PARTYB_LIQUIDATOR_ROLE],
		] as const) {
			const already = await view.hasRole(liquidatorAddress, roleHash)
			if (already) {
				console.log(`  ⏭ SymmioLiquidator already has ${roleName} on core`)
				continue
			}
			const tx = await control.grantRole(liquidatorAddress, roleHash)
			await tx.wait()
			console.log(`  ✓ Granted ${roleName} on core to SymmioLiquidator (${liquidatorAddress})`)
		}
	}

	console.log("")
	console.log("✓ Deployment and operator registration complete.")
} finally {
	// Always restore fast blocks, even if the deploy/grants above threw
	if (isHyperEVM) {
		console.log("")
		console.log("Restoring HyperEVM fast blocks...")
		try {
			await setHyperEVMBigBlocks(hre, false)
		} catch (err) {
			console.error("⚠ Failed to disable big blocks. Run manually:")
			console.error("    npx hardhat hyperevm:disable-big-blocks --network hyperevm")
			console.error(err)
		}
	}
}
