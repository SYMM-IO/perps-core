/**
 * Register a MultiAccount as an affiliate on a Symmio core.
 *
 * One transaction:
 *   core.registerAffiliate(multiAccount)  -- needs AFFILIATE_MANAGER_ROLE on the core
 *
 * Plan (default, never broadcasts):
 *   ./node_modules/.bin/hardhat run scripts/registerMultiAccountAffiliate.ts --network base
 *
 * Execute (targets must be explicit and chain-bound):
 *   EXECUTE=true CONFIRM_CHAIN_ID=8453 SYMMIO_CORE=0x... MULTI_ACCOUNT=0x... \
 *     USE_KEYSTORE=true ./node_modules/.bin/hardhat run scripts/registerMultiAccountAffiliate.ts --network base
 *
 * Env overrides (the defaults below are plan-only):
 *   SYMMIO_CORE   default 0xa805FE5baA301D4e72C789694F3967452c77D6fD
 *   MULTI_ACCOUNT default 0x41a496361df4554bbBB03450506010E5eF4a7a9d
 *   EXECUTE        must be exactly "true" to broadcast
 *   CONFIRM_CHAIN_ID must exactly match eth_chainId when EXECUTE=true
 */
import hre from "hardhat"

const DEFAULT_SYMMIO_CORE = "0xa805FE5baA301D4e72C789694F3967452c77D6fD"
const DEFAULT_MULTI_ACCOUNT = "0x41a496361df4554bbBB03450506010E5eF4a7a9d"

function exactBooleanEnv(name: string, defaultValue = false): boolean {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return defaultValue
	if (raw === "true") return true
	if (raw === "false") return false
	throw new Error(`${name} must be exactly true or false; received ${JSON.stringify(raw)}`)
}

async function main() {
	const connection = await hre.network.getOrCreate()
	const { ethers } = connection
	const [signer] = await ethers.getSigners()
	const network = await ethers.provider.getNetwork()
	const chainId = Number(network.chainId)
	const execute = exactBooleanEnv("EXECUTE")
	const legacyDryRun = exactBooleanEnv("DRY_RUN", true)
	if (execute && process.env.DRY_RUN !== undefined && legacyDryRun) throw new Error("EXECUTE=true conflicts with DRY_RUN=true")

	const SYMMIO_CORE = ethers.getAddress(process.env.SYMMIO_CORE ?? DEFAULT_SYMMIO_CORE)
	const MULTI_ACCOUNT = ethers.getAddress(process.env.MULTI_ACCOUNT ?? DEFAULT_MULTI_ACCOUNT)

	if (execute) {
		if (!signer) throw new Error("No live signer is configured")
		if (!process.env.SYMMIO_CORE || !process.env.MULTI_ACCOUNT) {
			throw new Error("EXECUTE=true requires explicit SYMMIO_CORE and MULTI_ACCOUNT values; plan-only defaults cannot broadcast")
		}
		if (!/^\d+$/.test(process.env.CONFIRM_CHAIN_ID || "") || Number(process.env.CONFIRM_CHAIN_ID) !== chainId) {
			throw new Error(`EXECUTE=true requires CONFIRM_CHAIN_ID=${chainId}; connected chainId is ${chainId}`)
		}
	}

	console.log("Mode:          ", execute ? "EXECUTE" : "PLAN ONLY")
	console.log("Network:       ", `${connection.networkName} (${chainId})`)
	console.log("Signer:        ", signer?.address ?? "(not configured; plan remains read-only)")
	console.log("Symmio core:   ", SYMMIO_CORE)
	console.log("MultiAccount:  ", MULTI_ACCOUNT)
	console.log()

	const [coreCode, multiAccountCode] = await Promise.all([ethers.provider.getCode(SYMMIO_CORE), ethers.provider.getCode(MULTI_ACCOUNT)])
	if (coreCode === "0x") throw new Error(`No contract code at SYMMIO_CORE ${SYMMIO_CORE}`)
	if (multiAccountCode === "0x") throw new Error(`No contract code at MULTI_ACCOUNT ${MULTI_ACCOUNT}`)

	const AFFILIATE_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("AFFILIATE_MANAGER_ROLE"))

	const coreView = new ethers.Contract(
		SYMMIO_CORE,
		["function hasRole(address user, bytes32 role) view returns (bool)", "function isAffiliate(address affiliate) view returns (bool)"],
		ethers.provider,
	)

	console.log("--- Pre-flight ---")
	const alreadyAffiliate: boolean = await coreView.isAffiliate(MULTI_ACCOUNT)
	console.log("isAffiliate(MA) on core:        ", alreadyAffiliate)
	const signerHasAffiliateMgr: boolean = signer ? await coreView.hasRole(signer.address, AFFILIATE_MANAGER_ROLE) : false
	console.log("signer has AFFILIATE_MANAGER:   ", signer ? signerHasAffiliateMgr : "(not checked)")
	console.log()

	if (alreadyAffiliate) {
		console.log("Nothing to do — MultiAccount is already registered as an affiliate.")
		return
	}
	if (!execute) {
		console.log(`PLAN ONLY — would send: ${SYMMIO_CORE}.registerAffiliate(${MULTI_ACCOUNT})`)
		console.log(`To execute, set EXECUTE=true CONFIRM_CHAIN_ID=${chainId} and provide both target addresses explicitly.`)
		return
	}
	if (!signerHasAffiliateMgr) throw new Error(`Signer ${signer!.address} lacks AFFILIATE_MANAGER_ROLE on core ${SYMMIO_CORE}`)

	console.log("--- registerAffiliate ---")
	const core = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", SYMMIO_CORE, signer)
	await core.registerAffiliate.staticCall(MULTI_ACCOUNT)
	const tx = await core.registerAffiliate(MULTI_ACCOUNT)
	console.log("submitted tx:", tx.hash, "nonce:", tx.nonce)
	const receipt = await tx.wait()
	if (!receipt || receipt.status !== 1) throw new Error(`registerAffiliate transaction failed: ${tx.hash}`)
	console.log("confirmed in block", receipt.blockNumber, "gas used:", receipt.gasUsed.toString())

	const verify: boolean = await coreView.isAffiliate(MULTI_ACCOUNT)
	if (!verify) throw new Error("Verification failed: isAffiliate(MA) still false after registerAffiliate")
	console.log("verified: isAffiliate(MA) = true")
	console.log("\nDone.")
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
