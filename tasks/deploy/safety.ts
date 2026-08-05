// Mainnet safety guards for deploy:system.
//
// The deploy defaults are tuned for local testing (mock verifier, fake stablecoin,
// dummy affiliate, fallback deployer key). Those defaults are silent and none of them
// used to be blocked on a real chain, so the documented "copy .env.example to .env"
// path produced a compromised protocol. These guards make that impossible without an
// explicit, deliberate override.

/** Chains where a mistake costs real money. Keep in sync with hardhat.config.ts networks. */
export const KNOWN_MAINNET_CHAIN_IDS = new Set<number>([
	1, // Ethereum
	56, // BNB Smart Chain
	137, // Polygon
	146, // Sonic
	204, // opBNB
	999, // HyperEVM
	1101, // Polygon zkEVM
	1329, // Sei
	5000, // Mantle
	8453, // Base
	8822, // IOTA
	9745, // Plasma
	34443, // Mode
	42161, // Arbitrum One
	80094, // Berachain
	81457, // Blast
	2632500, // COTI
])

/**
 * Deployer addresses that must never sign on a mainnet. Keyed by lowercased address.
 * These correspond to private keys published in this repo or in Hardhat's docs, so
 * anyone can drain or take over whatever they deploy.
 */
export const UNSAFE_DEPLOYERS = new Map<string, string>([
	["0x57331e7ca8ef2b0c8dfaa1f0760912509fe2d46d", "DUMMY_PRIVATE_KEY committed in hardhat.config.ts"],
	["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "well-known Hardhat test account #0 (shipped in .env.example)"],
])

export interface MainnetSafetyConfig {
	deployMockVerifier: boolean
	collateralAddress: string
	registerDummyAffiliate: boolean
}

export interface SafetyViolation {
	/** Short machine-readable id, useful in tests. */
	id: string
	/** What is wrong, and what it costs on a real chain. */
	message: string
	/** How the operator fixes it. */
	remedy: string
}

export function isKnownMainnet(chainId: number | bigint): boolean {
	return KNOWN_MAINNET_CHAIN_IDS.has(Number(chainId))
}

/**
 * Collect every unsafe-for-mainnet setting. Returns [] on non-mainnet chains, so local
 * and fork runs keep the permissive defaults that make testing convenient.
 */
export function collectMainnetSafetyViolations(chainId: number | bigint, deployerAddress: string, config: MainnetSafetyConfig): SafetyViolation[] {
	if (!isKnownMainnet(chainId)) return []

	const violations: SafetyViolation[] = []

	const unsafeDeployer = UNSAFE_DEPLOYERS.get(deployerAddress.toLowerCase())
	if (unsafeDeployer) {
		violations.push({
			id: "unsafe-deployer",
			message: `Deployer ${deployerAddress} is a publicly-known key (${unsafeDeployer}). Anything it deploys can be taken over by anyone.`,
			remedy:
				"Set NEW_DEPLOYER (or TEAM_DEPLOYER, or USE_KEYSTORE=true) to your real deployer key. Note: PRIVATE_KEY is NOT read by hardhat.config.ts.",
		})
	}

	if (config.deployMockVerifier) {
		violations.push({
			id: "mock-verifier",
			message:
				"DEPLOY_MOCK_VERIFIER is enabled. MockMuonSignatureVerifier accepts EVERY signature, making all Muon price/uPnL/liquidation attestations forgeable.",
			remedy: 'Set DEPLOY_MOCK_VERIFIER="false", or supply MUON_SIGNATURE_VERIFIER_ADDRESS for an already-deployed verifier.',
		})
	}

	if (!config.collateralAddress) {
		violations.push({
			id: "fake-collateral",
			message:
				"COLLATERAL_ADDRESS is empty, so the deploy would create a FakeStablecoin (permissionless mint) and wire it in as protocol collateral. setCollateral is not cleanly re-runnable.",
			remedy: "Set COLLATERAL_ADDRESS to the real collateral token (on Arbitrum One, USDC is 0xaf88d065e77c8cC2239327C5EDb3A432268e5831).",
		})
	}

	if (config.registerDummyAffiliate) {
		violations.push({
			id: "dummy-affiliate",
			message: 'REGISTER_DUMMY_AFFILIATE is enabled, which registers and approves a real "Test Affiliate" on the mainnet AccountLayer.',
			remedy: 'Set REGISTER_DUMMY_AFFILIATE="false".',
		})
	}

	return violations
}

/**
 * Abort the deployment if any unsafe setting is active on a mainnet.
 *
 * `allowUnsafe` exists so a deliberate, informed run (a controlled staging deploy on a
 * real chain, say) is still possible — but it must be passed explicitly on the command
 * line, and it still prints every violation.
 */
export function assertMainnetSafe(
	chainId: number | bigint,
	deployerAddress: string,
	config: MainnetSafetyConfig,
	allowUnsafe: boolean = false,
): void {
	const violations = collectMainnetSafetyViolations(chainId, deployerAddress, config)
	if (violations.length === 0) return

	const banner = "=".repeat(80)
	const lines = [
		banner,
		`UNSAFE MAINNET DEPLOYMENT BLOCKED — chainId ${Number(chainId)}`,
		banner,
		"",
		...violations.flatMap((v, i) => [`${i + 1}. ${v.message}`, `   FIX: ${v.remedy}`, ""]),
	]

	if (allowUnsafe) {
		lines.splice(1, 1, `UNSAFE MAINNET DEPLOYMENT — PROCEEDING ANYWAY (--allow-unsafe-mainnet) — chainId ${Number(chainId)}`)
		console.warn(lines.join("\n"))
		console.warn("Continuing because --allow-unsafe-mainnet was passed. This deployment will NOT be safe to use in production.\n")
		return
	}

	lines.push("Re-run with --allow-unsafe-mainnet=true only if every item above is intentional.", banner)
	throw new Error(`\n${lines.join("\n")}`)
}
