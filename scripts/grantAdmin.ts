import hre from "hardhat"

const TARGET = "0x7b92448dd0d9eadd63cde0a8a106c5e21559dff5"

const CORE_DIAMOND = "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB"
const ACCOUNT_LAYER = "0x812e98F31A4EfFC09dD82e6e87ff7456151a0dFB"
const INSTANT_LAYER = "0x42b5612870671795Eff958eB761A9BEf1684664D"
const SYMMIO_PARTY_B = "0xf62a670cda28FfAE65eE2a42D6cf6CF05EC5E775"

async function main() {
	const { ethers } = await hre.network.connect()
	const [signer] = await ethers.getSigners()

	// Core + AccountLayer use keccak256("DEFAULT_ADMIN_ROLE")
	const CUSTOM_DEFAULT_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DEFAULT_ADMIN_ROLE"))
	// InstantLayer + SymmioPartyB use OpenZeppelin's DEFAULT_ADMIN_ROLE = 0x00
	const OZ_DEFAULT_ADMIN_ROLE = ethers.ZeroHash
	console.log("Signer:", signer.address)

	// 1. Core Diamond — setAdmin(address)
	console.log("\n--- Core Diamond ---")
	const core = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", CORE_DIAMOND)
	let tx = await core.setAdmin(TARGET)
	await tx.wait()
	console.log("setAdmin tx:", tx.hash)

	// 2. AccountLayer — grantRole(address user, bytes32 role)
	console.log("\n--- AccountLayer ---")
	const alAbi = ["function grantRole(address user, bytes32 role) external"]
	const accountLayer = new ethers.Contract(ACCOUNT_LAYER, alAbi, signer)
	tx = await accountLayer.grantRole(TARGET, CUSTOM_DEFAULT_ADMIN_ROLE)
	await tx.wait()
	console.log("grantRole tx:", tx.hash)

	// 3. InstantLayer — grantRole(bytes32 role, address account) (OpenZeppelin)
	console.log("\n--- InstantLayer ---")
	const ozAbi = ["function grantRole(bytes32 role, address account) external"]
	const instantLayer = new ethers.Contract(INSTANT_LAYER, ozAbi, signer)
	tx = await instantLayer.grantRole(OZ_DEFAULT_ADMIN_ROLE, TARGET)
	await tx.wait()
	console.log("grantRole tx:", tx.hash)

	// 4. SymmioPartyB — grantRole(bytes32 role, address account) (OpenZeppelin)
	console.log("\n--- SymmioPartyB ---")
	const partyB = new ethers.Contract(SYMMIO_PARTY_B, ozAbi, signer)
	tx = await partyB.grantRole(OZ_DEFAULT_ADMIN_ROLE, TARGET)
	await tx.wait()
	console.log("grantRole tx:", tx.hash)

	console.log("\nDone! DEFAULT_ADMIN_ROLE granted on all 4 contracts.")
}

main().catch(console.error)
