/**
 * Repairs the missing Polygon Muon AccountManagement permissions that prevent
 * deallocate and related account-management calls from passing verification.
 *
 * Dry run (recommended first):
 *   DRY_RUN=true npx hardhat run --no-compile scripts/fixPolygonMuonAccountManagementPermissions.ts --network polygon
 *
 * Submit the missing permission transactions:
 *   USE_KEYSTORE=true KEYSTORE_DEPLOYER_KEY=NEW_DEPLOYER \
 *     npx hardhat run --no-compile scripts/fixPolygonMuonAccountManagementPermissions.ts --network polygon
 *
 * The configured signer must currently hold SETTER_ROLE on the verifier.
 *
 * Optional environment variables:
 *   RPC_POLYGON=https://...   Polygon RPC URL (defaults to https://polygon.drpc.org)
 *   SIGNER_ADDRESS=0x...      Address to check during a dry run
 *   CONFIRMATIONS=1           Confirmations to wait for each transaction
 *   ALLOW_NON_POLYGON=true    Allow execution against a fork or test network
 *   DRY_RUN=true              Inspect and print calldata without sending
 */
import { getAddress } from "ethers"
import hre from "hardhat"

const POLYGON_CHAIN_ID = 137
const DEFAULT_RPC_POLYGON = "https://polygon.drpc.org"

const VERIFIER_ADDRESS = getAddress("0x5aDfb7a307DED826CB31da81BaEcF53c2157F760")
const MUON_PUBLIC_KEY = {
	x: BigInt("0x3fb5a506c907e2f6984e4f7207fc445d3c847474d056adfd4718f17548b72136"),
	parity: 0,
}
const MUON_GATEWAY_SIGNER = getAddress("0xF621f85f20BBe733699306D336230184621dBe60")
const ACCOUNT_MANAGEMENT = 1

const VERIFIER_ABI = [
	"function SETTER_ROLE() view returns (bytes32)",
	"function hasRole(bytes32 role,address account) view returns (bool)",
	"function getRoleMemberCount(bytes32 role) view returns (uint256)",
	"function getRoleMember(bytes32 role,uint256 index) view returns (address)",
	"function getAllPublicKeys() view returns (tuple(uint256 x,uint8 parity)[])",
	"function getAllGatewaySigners() view returns (address[])",
	"function isPublicKeyAuthorized(tuple(uint256 x,uint8 parity) pubKey,uint8 func) view returns (bool)",
	"function isGatewaySignerAuthorized(address signer,uint8 func) view returns (bool)",
	"function setPublicKeyPermissions(tuple(uint256 x,uint8 parity) pubKey,uint8[] functions,bool allowed)",
	"function setGatewaySignerPermissions(address signer,uint8[] functions,bool allowed)",
]

function envFlag(name: string, defaultValue = false): boolean {
	const raw = process.env[name]
	if (raw === undefined) return defaultValue
	return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
}

function positiveIntegerEnv(name: string, defaultValue: number): number {
	const raw = process.env[name]
	if (raw === undefined) return defaultValue

	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
	return value
}

function optionalAddressEnv(name: string): string | undefined {
	const raw = process.env[name]
	if (raw === undefined || raw.trim() === "") return undefined
	return getAddress(raw.trim())
}

async function main() {
	const dryRun = envFlag("DRY_RUN")
	const allowNonPolygon = envFlag("ALLOW_NON_POLYGON")
	const confirmations = positiveIntegerEnv("CONFIRMATIONS", 1)
	const rpcUrl = process.env.RPC_POLYGON ?? DEFAULT_RPC_POLYGON
	const dryRunSignerAddress = optionalAddressEnv("SIGNER_ADDRESS")

	const connection = await hre.network.connect({ override: { url: rpcUrl } })
	const { ethers } = connection as any
	const network = await ethers.provider.getNetwork()
	const chainId = Number(network.chainId)

	if (chainId !== POLYGON_CHAIN_ID && !allowNonPolygon) {
		throw new Error(`This repair is intended for Polygon mainnet (chainId ${POLYGON_CHAIN_ID}); connected to chainId ${chainId}`)
	}

	const verifierCode = await ethers.provider.getCode(VERIFIER_ADDRESS)
	if (verifierCode === "0x") throw new Error(`No contract found at verifier ${VERIFIER_ADDRESS}`)

	const [liveSigner] = dryRun ? [] : await ethers.getSigners()
	const signerAddress = liveSigner?.address ?? dryRunSignerAddress
	const verifier = new ethers.Contract(VERIFIER_ADDRESS, VERIFIER_ABI, liveSigner ?? ethers.provider)

	const setterRole = await verifier.SETTER_ROLE()
	const setterCount = Number(await verifier.getRoleMemberCount(setterRole))
	const setterMembers = await Promise.all(Array.from({ length: setterCount }, (_, index) => verifier.getRoleMember(setterRole, index)))
	const signerHasSetterRole = signerAddress ? await verifier.hasRole(setterRole, signerAddress) : false

	const publicKeys = await verifier.getAllPublicKeys()
	const publicKeyRegistered = publicKeys.some(
		(key: { x: bigint; parity: bigint | number }) => BigInt(key.x) === MUON_PUBLIC_KEY.x && Number(key.parity) === MUON_PUBLIC_KEY.parity,
	)
	const gatewaySigners = (await verifier.getAllGatewaySigners()).map((address: string) => getAddress(address))
	const gatewayRegistered = gatewaySigners.includes(MUON_GATEWAY_SIGNER)

	if (!publicKeyRegistered) {
		throw new Error(`Expected Muon public key is not registered on ${VERIFIER_ADDRESS}; refusing to modify permissions`)
	}
	if (!gatewayRegistered) {
		throw new Error(`Expected Muon gateway signer ${MUON_GATEWAY_SIGNER} is not registered; refusing to modify permissions`)
	}

	const publicKeyAuthorized = await verifier.isPublicKeyAuthorized(MUON_PUBLIC_KEY, ACCOUNT_MANAGEMENT)
	const gatewayAuthorized = await verifier.isGatewaySignerAuthorized(MUON_GATEWAY_SIGNER, ACCOUNT_MANAGEMENT)

	const publicKeyCalldata = verifier.interface.encodeFunctionData("setPublicKeyPermissions", [MUON_PUBLIC_KEY, [ACCOUNT_MANAGEMENT], true])
	const gatewayCalldata = verifier.interface.encodeFunctionData("setGatewaySignerPermissions", [MUON_GATEWAY_SIGNER, [ACCOUNT_MANAGEMENT], true])

	console.log("Polygon Muon AccountManagement permission repair")
	console.log(`  Network:             ${connection.networkName} (${chainId})`)
	console.log(`  Verifier:            ${VERIFIER_ADDRESS}`)
	console.log(`  Signer:              ${signerAddress ?? "(not supplied for dry run)"}`)
	console.log(`  SETTER_ROLE members: ${setterMembers.length > 0 ? setterMembers.join(", ") : "(none)"}`)
	console.log(`  Signer has role:     ${signerAddress ? (signerHasSetterRole ? "yes" : "no") : "(not checked)"}`)
	console.log(`  TSS key registered:  ${publicKeyRegistered ? "yes" : "no"}`)
	console.log(`  Gateway registered:  ${gatewayRegistered ? "yes" : "no"}`)
	console.log(`  TSS permission:      ${publicKeyAuthorized ? "already granted" : "missing"}`)
	console.log(`  Gateway permission:  ${gatewayAuthorized ? "already granted" : "missing"}`)
	console.log(`  Dry run:             ${dryRun ? "yes" : "no"}`)

	if (publicKeyAuthorized && gatewayAuthorized) {
		console.log("\nBoth AccountManagement permissions are already configured; no transaction is needed.")
		return
	}

	console.log("\nMissing transaction calldata:")
	if (!publicKeyAuthorized) {
		console.log(`  to:   ${VERIFIER_ADDRESS}`)
		console.log(`  data: ${publicKeyCalldata}`)
		console.log("  call: setPublicKeyPermissions(MUON_PUBLIC_KEY, [1], true)")
	}
	if (!gatewayAuthorized) {
		console.log(`  to:   ${VERIFIER_ADDRESS}`)
		console.log(`  data: ${gatewayCalldata}`)
		console.log(`  call: setGatewaySignerPermissions(${MUON_GATEWAY_SIGNER}, [1], true)`)
	}

	if (dryRun) {
		console.log("\nDry run complete. Re-run without DRY_RUN=true using a SETTER_ROLE signer to submit.")
		return
	}

	if (!liveSigner || !signerAddress) throw new Error("No live signer is configured")
	if (!signerHasSetterRole) {
		throw new Error(`Signer ${signerAddress} does not have SETTER_ROLE on ${VERIFIER_ADDRESS}; current members: ${setterMembers.join(", ")}`)
	}

	if (!publicKeyAuthorized) {
		await verifier.setPublicKeyPermissions.staticCall(MUON_PUBLIC_KEY, [ACCOUNT_MANAGEMENT], true)
		const tx = await verifier.setPublicKeyPermissions(MUON_PUBLIC_KEY, [ACCOUNT_MANAGEMENT], true)
		console.log(`\nTSS permission transaction: ${tx.hash}`)
		const receipt = await tx.wait(confirmations)
		if (receipt?.status !== 1) throw new Error(`TSS permission transaction failed: ${tx.hash}`)
	}

	if (!gatewayAuthorized) {
		await verifier.setGatewaySignerPermissions.staticCall(MUON_GATEWAY_SIGNER, [ACCOUNT_MANAGEMENT], true)
		const tx = await verifier.setGatewaySignerPermissions(MUON_GATEWAY_SIGNER, [ACCOUNT_MANAGEMENT], true)
		console.log(`Gateway permission transaction: ${tx.hash}`)
		const receipt = await tx.wait(confirmations)
		if (receipt?.status !== 1) throw new Error(`Gateway permission transaction failed: ${tx.hash}`)
	}

	const publicKeyAuthorizedAfter = await verifier.isPublicKeyAuthorized(MUON_PUBLIC_KEY, ACCOUNT_MANAGEMENT)
	const gatewayAuthorizedAfter = await verifier.isGatewaySignerAuthorized(MUON_GATEWAY_SIGNER, ACCOUNT_MANAGEMENT)
	if (!publicKeyAuthorizedAfter || !gatewayAuthorizedAfter) {
		throw new Error(
			`Post-update verification failed: TSS=${publicKeyAuthorizedAfter ? "granted" : "missing"}, gateway=${gatewayAuthorizedAfter ? "granted" : "missing"}`,
		)
	}

	console.log("\nRepair complete: both Polygon AccountManagement permissions are now granted.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
