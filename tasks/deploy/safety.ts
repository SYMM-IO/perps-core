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
	adminAddress: string
	adminWasExplicit: boolean
}

export interface SafetyViolation {
	/** Short machine-readable id, useful in tests. */
	id: string
	/** What is wrong, and what it costs on a real chain. */
	message: string
	/** How the operator fixes it. */
	remedy: string
}

/**
 * Chains that exist only for development. Everything else is treated as value-bearing.
 *
 * The guards used to key off KNOWN_MAINNET_CHAIN_IDS alone, which is fail-open: a chain
 * added to hardhat.config.ts but forgotten here silently accepted a mock verifier, fake
 * collateral and a published deployer key. Defaulting to "protected" means the worst case
 * for a new chain is an explicit override, not a compromised protocol.
 */
export const DEVELOPMENT_CHAIN_IDS = new Set<number>([
	31337, // Hardhat / localhost
	1337, // legacy local JSON-RPC nodes
])

export function isKnownMainnet(chainId: number | bigint): boolean {
	return KNOWN_MAINNET_CHAIN_IDS.has(Number(chainId))
}

/**
 * Whether production guards apply. True for every chain that is not a local development
 * node, including chains missing from KNOWN_MAINNET_CHAIN_IDS and the fork rehearsals that
 * inherit an upstream chain id.
 */
export function requiresProductionSafety(chainId: number | bigint): boolean {
	return !DEVELOPMENT_CHAIN_IDS.has(Number(chainId))
}

/**
 * Low-level `deploy:*` component tasks have no durable standalone journal. They are
 * useful building blocks on Hardhat/local networks, but invoking one directly against
 * a live RPC can orphan a deployment when the receipt wait times out. Live deployments
 * must enter through a workflow that owns recovery and chain confirmation.
 */
export function assertStandaloneDeploymentTaskAllowed(
	taskName: string,
	chainId: number | bigint,
	isSimulated: boolean,
	liveWorkflow = "Use `./symmio` and a registered deployment task for a checkpointed live deployment.",
): void {
	const normalizedChainId = Number(chainId)
	if (isSimulated || normalizedChainId === 31337) return
	throw new Error(
		`${taskName} is a low-level component deployment task and is refused on live RPC chainId ${normalizedChainId}. ` +
			"It has no durable standalone transaction journal, so retrying after an uncertain receipt could deploy a duplicate contract. " +
			liveWorkflow,
	)
}

/**
 * Collect every unsafe-for-mainnet setting. Returns [] on non-mainnet chains, so local
 * runs keep the permissive defaults that make testing convenient.
 *
 * Note this is evaluated on chainId alone. A forked network reports its upstream chainId
 * (fork-arbitrum is chainId 42161), so violations are still collected there — which is the
 * point of a rehearsal. Whether they BLOCK is decided by assertMainnetSafe, which treats a
 * simulated network as a warning rather than a stop.
 */
export function collectMainnetSafetyViolations(chainId: number | bigint, deployerAddress: string, config: MainnetSafetyConfig): SafetyViolation[] {
	if (!requiresProductionSafety(chainId)) return []

	const violations: SafetyViolation[] = []

	if (!config.adminWasExplicit) {
		violations.push({
			id: "missing-admin",
			message: "ADMIN_PUBLIC_KEY is not explicitly configured, so protocol administration would default to the deployer hot wallet.",
			remedy: "Set ADMIN_PUBLIC_KEY to the production multisig address.",
		})
	}

	if (config.adminAddress.toLowerCase() === deployerAddress.toLowerCase()) {
		violations.push({
			id: "admin-is-deployer",
			message: `ADMIN_PUBLIC_KEY resolves to the deployer ${deployerAddress}, so the deploy hot wallet would retain protocol control.`,
			remedy: "Set ADMIN_PUBLIC_KEY to a distinct production multisig address.",
		})
	}

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
 * Abort the deployment if any unsafe setting is active on a real mainnet.
 *
 * `allowUnsafe` exists so a deliberate, informed run (a controlled staging deploy on a
 * real chain, say) is still possible — but it must be passed explicitly on the command
 * line, and it still prints every violation.
 *
 * `isSimulated` marks an in-process EVM (hardhat's edr-simulated type, which is what the
 * fork-* networks are). A fork reports its upstream chainId — fork-arbitrum is 42161 — and
 * uses hardhat's built-in test accounts, so every check here would fire and block the one
 * rehearsal that is supposed to catch problems before mainnet. A simulated network cannot
 * touch a real chain whatever chainId it claims, so violations are reported loudly and the
 * run continues. That way the rehearsal still tells you exactly what mainnet would reject.
 */
export function assertMainnetSafe(
	chainId: number | bigint,
	deployerAddress: string,
	config: MainnetSafetyConfig,
	allowUnsafe: boolean = false,
	isSimulated: boolean = false,
): void {
	const violations = collectMainnetSafetyViolations(chainId, deployerAddress, config)
	if (violations.length === 0) return

	const banner = "=".repeat(80)
	const body = violations.flatMap((v, i) => [`${i + 1}. ${v.message}`, `   FIX: ${v.remedy}`, ""])

	if (isSimulated) {
		console.warn(
			[
				"",
				banner,
				`SIMULATED NETWORK — these would BLOCK a real deployment to chainId ${Number(chainId)}`,
				banner,
				"",
				...body,
				"Not blocking: this network is an in-process EVM and cannot reach a real chain.",
				"Fix everything above before running the same configuration for real.",
				banner,
				"",
			].join("\n"),
		)
		return
	}

	const lines = [banner, `UNSAFE MAINNET DEPLOYMENT BLOCKED — chainId ${Number(chainId)}`, banner, "", ...body]

	if (allowUnsafe) {
		const confirmation = process.env.UNSAFE_MAINNET_CONFIRM_CHAIN_ID
		if (confirmation !== String(Number(chainId))) {
			throw new Error(
				`${lines.join("\n")}\n` +
					`Unsafe override refused: set UNSAFE_MAINNET_CONFIRM_CHAIN_ID=${Number(chainId)} in addition to --allow-unsafe-mainnet=true.\n` +
					"This second, chain-bound confirmation prevents a copied flag from bypassing production safety by accident.",
			)
		}
		lines.splice(1, 1, `UNSAFE MAINNET DEPLOYMENT — PROCEEDING ANYWAY (--allow-unsafe-mainnet) — chainId ${Number(chainId)}`)
		console.warn(lines.join("\n"))
		console.warn("Continuing because --allow-unsafe-mainnet was passed. This deployment will NOT be safe to use in production.\n")
		return
	}

	lines.push("Re-run with --allow-unsafe-mainnet=true only if every item above is intentional.", banner)
	throw new Error(`\n${lines.join("\n")}`)
}

/**
 * Apply the signer/final-admin subset of the mainnet guard to a deployment that
 * reuses an already-proven Core. The sentinel collateral value deliberately marks
 * that full-system checks are not part of this component-only workflow.
 */
export function assertMainnetDeploymentIdentitySafe(
	chainId: number | bigint,
	deployerAddress: string,
	adminAddress: string,
	isSimulated: boolean = false,
): void {
	assertMainnetSafe(
		chainId,
		deployerAddress,
		{
			deployMockVerifier: false,
			collateralAddress: "reused-core",
			registerDummyAffiliate: false,
			adminAddress,
			adminWasExplicit: true,
		},
		false,
		isSimulated,
	)
}
