/**
 * Deploy a new AccountLayer diamond and/or set it up on a Symmio Core diamond.
 *
 * Usage:
 *   # First run: deploy new AccountLayer + set up on Symmio #1
 *   SYMMIO_ADDRESS=0x0f43... INSTANT_LAYER_ADDRESS=0xDbC9... \
 *     npx hardhat run scripts/deployAndSetupAccountLayer.ts --network <network>
 *
 *   # Second run: reuse deployed AccountLayer + set up on Symmio #2
 *   SYMMIO_ADDRESS=0xa805... INSTANT_LAYER_ADDRESS=0x5Aa5... ACCOUNT_LAYER_ADDRESS=0x<from_run_1> \
 *     npx hardhat run scripts/deployAndSetupAccountLayer.ts --network <network>
 *
 * Environment variables:
 *   SYMMIO_ADDRESS          (required) Symmio Core diamond address
 *   INSTANT_LAYER_ADDRESS   (required) InstantLayer address for this Symmio instance
 *   ACCOUNT_LAYER_ADDRESS   (optional) Skip deploy, use existing AccountLayer address
 *   OLD_ACCOUNT_LAYER       (optional) Revoke roles from old AccountLayer
 *   SYMMIO_FEE_RECEIVER     (optional) Fee receiver address (defaults to deployer)
 */
import { toUtf8Bytes } from "ethers"
import hre from "hardhat"

import { deployAccountLayerDiamond } from "../tasks/deploy/accountLayerDiamond.js"
import { setLogLevel } from "../tasks/deploy/logger.js"

setLogLevel("verbose")

const { ethers } = await hre.network.connect()

const SYMMIO_ADDRESS = process.env.SYMMIO_ADDRESS
if (!SYMMIO_ADDRESS) {
	console.error("ERROR: SYMMIO_ADDRESS env var is required")
	process.exit(1)
}

const INSTANT_LAYER_ADDRESS = process.env.INSTANT_LAYER_ADDRESS
if (!INSTANT_LAYER_ADDRESS) {
	console.error("ERROR: INSTANT_LAYER_ADDRESS env var is required")
	process.exit(1)
}

const ACCOUNT_LAYER_ADDRESS = process.env.ACCOUNT_LAYER_ADDRESS
const OLD_ACCOUNT_LAYER = process.env.OLD_ACCOUNT_LAYER
const SYMMIO_FEE_RECEIVER_ADDR = process.env.SYMMIO_FEE_RECEIVER

const [deployer] = await ethers.getSigners()
const roleHash = (role: string) => ethers.keccak256(toUtf8Bytes(role))

console.log("=".repeat(60))
console.log("AccountLayer Deploy & Setup Script")
console.log("=".repeat(60))
console.log(`Deployer:            ${deployer.address}`)
console.log(`Symmio Core:         ${SYMMIO_ADDRESS}`)
console.log(`InstantLayer:        ${INSTANT_LAYER_ADDRESS}`)
console.log(`AccountLayer:        ${ACCOUNT_LAYER_ADDRESS || "(will deploy new)"}`)
console.log(`Old AccountLayer:    ${OLD_ACCOUNT_LAYER || "(none - skip revoke)"}`)
console.log(`Fee Receiver:        ${SYMMIO_FEE_RECEIVER_ADDR || deployer.address}`)
console.log("=".repeat(60))

// ── Step 1: Deploy or reuse AccountLayer ────────────────────
let accountLayerAddress: string

if (ACCOUNT_LAYER_ADDRESS) {
	accountLayerAddress = ACCOUNT_LAYER_ADDRESS
	console.log(`\n✓ Using existing AccountLayer: ${accountLayerAddress}`)
} else {
	console.log("\n▶ Deploying new AccountLayer diamond...")
	const symmioFeeReceiver = SYMMIO_FEE_RECEIVER_ADDR ? await ethers.getSigner(SYMMIO_FEE_RECEIVER_ADDR) : deployer

	const result = await deployAccountLayerDiamond(hre, {
		admin: deployer,
		symmioFeeReceiver,
		logData: true,
	})
	accountLayerAddress = result.diamond
	console.log(`\n✓ AccountLayer deployed at: ${accountLayerAddress}`)
}

// ── Step 2: Revoke roles from old AccountLayer (optional) ───
if (OLD_ACCOUNT_LAYER) {
	console.log(`\n▶ Revoking roles from old AccountLayer (${OLD_ACCOUNT_LAYER}) on Symmio Core...`)
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", SYMMIO_ADDRESS, deployer)

	const rolesToRevoke = ["SIGNER_ADMIN_ROLE", "AFFILIATE_MANAGER_ROLE", "INTERNAL_TRANSFER_TO_BALANCE_ROLE"]
	for (const role of rolesToRevoke) {
		const tx = await controlFacet.revokeRole(OLD_ACCOUNT_LAYER, roleHash(role))
		await tx.wait()
		console.log(`  ✓ Revoked ${role}`)
	}
}

// ── Step 3: Grant roles to new AccountLayer on Symmio Core ──
console.log(`\n▶ Granting roles to AccountLayer (${accountLayerAddress}) on Symmio Core...`)
const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", SYMMIO_ADDRESS, deployer)

const rolesToGrant = ["SIGNER_ADMIN_ROLE", "AFFILIATE_MANAGER_ROLE", "INTERNAL_TRANSFER_TO_BALANCE_ROLE"]
for (const role of rolesToGrant) {
	const tx = await controlFacet.grantRole(accountLayerAddress, roleHash(role))
	await tx.wait()
	console.log(`  ✓ Granted ${role}`)
}

// ── Step 4: Whitelist Symmio Core on AccountLayer ───────────
console.log(`\n▶ Whitelisting Symmio Core (${SYMMIO_ADDRESS}) on AccountLayer...`)
const alControlFacet = await ethers.getContractAt(
	"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
	accountLayerAddress,
	deployer,
)

let tx = await alControlFacet.setWhitelistedSymmioCore(SYMMIO_ADDRESS, true)
await tx.wait()
console.log(`  ✓ Whitelisted`)

// ── Step 5: Grant SIGNER_SETTER_ROLE on AccountLayer (allows InstantLayer to call setSigner) ────────
console.log(`\n▶ Granting SIGNER_SETTER_ROLE to InstantLayer (${INSTANT_LAYER_ADDRESS}) on AccountLayer...`)
tx = await alControlFacet.grantRole(INSTANT_LAYER_ADDRESS, roleHash("SIGNER_SETTER_ROLE"))
await tx.wait()
console.log(`  ✓ Granted SIGNER_SETTER_ROLE`)

// ── Step 6: Set AccountLayer on InstantLayer + whitelist ────
console.log(`\n▶ Setting AccountLayer on InstantLayer (${INSTANT_LAYER_ADDRESS})...`)
const instantLayer = await ethers.getContractAt("InstantLayer", INSTANT_LAYER_ADDRESS, deployer)

tx = await instantLayer.setAccountLayer(accountLayerAddress)
await tx.wait()
console.log(`  ✓ setAccountLayer (also auto-whitelists new + de-whitelists old)`)

// ── Step 7: Register AccountLayer as system hook on Symmio Core ──
console.log(`\n▶ Registering AccountLayer as system hook on Symmio Core...`)
tx = await controlFacet.registerHook(ethers.ZeroAddress, accountLayerAddress)
await tx.wait()
console.log(`  ✓ registerHook(address(0), ${accountLayerAddress})`)

// ── Done ────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60))
console.log("DONE")
console.log("=".repeat(60))
console.log(`AccountLayer:   ${accountLayerAddress}`)
console.log(`Symmio Core:    ${SYMMIO_ADDRESS}`)
console.log(`InstantLayer:   ${INSTANT_LAYER_ADDRESS}`)
console.log("")
if (!ACCOUNT_LAYER_ADDRESS) {
	console.log("Save the AccountLayer address for the second run:")
	console.log(`  ACCOUNT_LAYER_ADDRESS=${accountLayerAddress}`)
}
console.log("=".repeat(60))
