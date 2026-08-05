/**
 * Register a MultiAccount as an affiliate on a Symmio core.
 *
 * One transaction:
 *   core.registerAffiliate(multiAccount)  -- needs AFFILIATE_MANAGER_ROLE on the core
 *
 * Usage:
 *   USE_KEYSTORE=true npx hardhat run scripts/registerMultiAccountAffiliate.ts --network base
 *
 * Env overrides (optional — defaults below):
 *   SYMMIO_CORE   default 0xa805FE5baA301D4e72C789694F3967452c77D6fD
 *   MULTI_ACCOUNT default 0x41a496361df4554bbBB03450506010E5eF4a7a9d
 *   DRY_RUN       "true" prints the tx and exits without sending
 */
import hre from "hardhat"

const DEFAULT_SYMMIO_CORE = "0xa805FE5baA301D4e72C789694F3967452c77D6fD"
const DEFAULT_MULTI_ACCOUNT = "0x41a496361df4554bbBB03450506010E5eF4a7a9d"

async function main() {
	const { ethers } = await hre.network.connect()
	const [signer] = await ethers.getSigners()

	const SYMMIO_CORE = ethers.getAddress(process.env.SYMMIO_CORE ?? DEFAULT_SYMMIO_CORE)
	const MULTI_ACCOUNT = ethers.getAddress(process.env.MULTI_ACCOUNT ?? DEFAULT_MULTI_ACCOUNT)
	const DRY_RUN = process.env.DRY_RUN === "true"

	console.log("Signer:        ", signer.address)
	console.log("Symmio core:   ", SYMMIO_CORE)
	console.log("MultiAccount:  ", MULTI_ACCOUNT)
	console.log("Dry run:       ", DRY_RUN)
	console.log()

	const AFFILIATE_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("AFFILIATE_MANAGER_ROLE"))

	const core = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", SYMMIO_CORE, signer)
	const coreView = new ethers.Contract(
		SYMMIO_CORE,
		["function hasRole(address user, bytes32 role) view returns (bool)", "function isAffiliate(address affiliate) view returns (bool)"],
		signer,
	)

	console.log("--- Pre-flight ---")
	const alreadyAffiliate: boolean = await coreView.isAffiliate(MULTI_ACCOUNT)
	console.log("isAffiliate(MA) on core:        ", alreadyAffiliate)
	const signerHasAffiliateMgr: boolean = await coreView.hasRole(signer.address, AFFILIATE_MANAGER_ROLE)
	console.log("signer has AFFILIATE_MANAGER:   ", signerHasAffiliateMgr)
	console.log()

	if (alreadyAffiliate) {
		console.log("Nothing to do — MultiAccount is already registered as an affiliate.")
		return
	}
	if (!signerHasAffiliateMgr) {
		throw new Error(`Signer ${signer.address} lacks AFFILIATE_MANAGER_ROLE on core ${SYMMIO_CORE}`)
	}

	if (DRY_RUN) {
		console.log(`DRY RUN — would send: ${SYMMIO_CORE}.registerAffiliate(${MULTI_ACCOUNT})`)
		return
	}

	console.log("--- registerAffiliate ---")
	const tx = await core.registerAffiliate(MULTI_ACCOUNT)
	console.log("tx:", tx.hash)
	const receipt = await tx.wait()
	console.log("mined in block", receipt!.blockNumber, "status:", receipt!.status)

	const verify: boolean = await coreView.isAffiliate(MULTI_ACCOUNT)
	if (!verify) throw new Error("Verification failed: isAffiliate(MA) still false after registerAffiliate")
	console.log("verified: isAffiliate(MA) = true")
	console.log("\nDone.")
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
