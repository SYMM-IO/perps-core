// `symmio deploy --network <n>` — the runbook, executed.
//
// Encodes the order that a correct deployment actually requires: preflight, an explicit
// plan, confirmation proportional to the risk, the deploy itself, then verification and a
// health check. The manual steps the tooling cannot perform are printed at the end rather
// than left in someone's head.

import { isMainnet, loadEnv, resolveDeployer, resolveNetwork } from "../lib/context.js"
import { hardhat } from "../lib/hardhat.js"
import { blank, c, confirm, confirmPhrase, info, kv, log, ok, title, warn } from "../lib/ui.js"
import { doctor } from "./doctor.js"

export async function deploy(args) {
	const networkName = args.network
	if (!networkName) throw new Error("--network is required")
	const chain = resolveNetwork(networkName)
	const { vars: env } = loadEnv()
	const mainnet = isMainnet(chain.chainId)

	// ── 1. preflight ────────────────────────────────────────────────────────────
	log(c.bold("\n  Step 1/4 — preflight"))
	const doctorCode = await doctor(args)
	if (doctorCode !== 0) {
		if (!args.force) {
			log(`  ${c.red("Preflight failed.")} ${c.grey("Fix the issues above, or pass --force to override.")}`)
			blank()
			return 1
		}
		warn("preflight failed but --force was passed — continuing")
	}

	// ── 2. plan ─────────────────────────────────────────────────────────────────
	log(c.bold("\n  Step 2/4 — plan"))
	const deployer = resolveDeployer(env)
	title("What will happen")
	kv([
		["network", `${chain.name} (chainId ${chain.chainId})`],
		["deployer", deployer.address ?? c.grey("(from keystore)")],
		["admin", env.ADMIN_PUBLIC_KEY || c.yellow("(defaults to deployer)")],
		["fee receiver", env.SYMMIO_FEE_RECEIVER || c.grey("(defaults to admin)")],
		["collateral", env.COLLATERAL_ADDRESS || c.yellow("(would deploy FakeStablecoin)")],
		["verifier", env.DEPLOY_MOCK_VERIFIER === "true" ? c.red("MOCK — accepts every signature") : "MuonSignatureVerifier"],
		["protocol config", `tasks/config/protocol-${chain.chainId}.json`],
		["verification", args["no-verify"] ? c.grey("skipped (--no-verify)") : "after deploy"],
	])
	blank()
	info("deploys ~45 contracts: Diamond + 31 facets, AccountLayer, InstantLayer, PartyB, SymbolManager")
	info("then hands admin to ADMIN_PUBLIC_KEY and revokes the deployer's privileges")

	// ── 3. confirm ──────────────────────────────────────────────────────────────
	if (!args.yes) {
		blank()
		const proceed = mainnet
			? await confirmPhrase(`This will spend real funds on ${chain.name}.`, chain.key)
			: await confirm(`Deploy to ${chain.name}?`)
		if (!proceed) {
			log(`  ${c.grey("Aborted.")}`)
			blank()
			return 1
		}
	}

	// ── 4. deploy ───────────────────────────────────────────────────────────────
	log(c.bold("\n  Step 3/4 — deploy"))
	const deployArgs = ["deploy:system", "--network", networkName]
	if (args.fresh) deployArgs.push("--fresh", "true")
	const code = await hardhat(deployArgs)
	if (code !== 0) {
		blank()
		log(`  ${c.red(c.bold("Deployment failed."))}`)
		log(`  ${c.grey("It is checkpointed — re-run the same command to resume from where it stopped.")}`)
		blank()
		return code
	}

	// ── 5. verify + check ───────────────────────────────────────────────────────
	log(c.bold("\n  Step 4/4 — verify and check"))
	if (!args["no-verify"]) {
		const vcode = await hardhat(["verify:all", "--network", networkName])
		if (vcode !== 0) {
			warn("block-explorer verification reported failures")
			info(`retry with: npx hardhat verify:all --retry-failed --network ${networkName}`)
		}
	}

	const ccode = await hardhat([
		"check:deployment",
		"--network",
		networkName,
		"--from-report",
		"true",
		...(env.ADMIN_PUBLIC_KEY ? ["--admin", env.ADMIN_PUBLIC_KEY] : []),
	])

	// ── what the tooling cannot do ──────────────────────────────────────────────
	title("Manual steps remaining")
	log(`  These cannot be done by the deployer and must come from your admin:`)
	blank()
	log(`  ${c.bold("1.")} Accept ownership — ownership transfer is two-step.`)
	log(`     ${c.grey("Your admin must call acceptOwnership() on the Diamond.")}`)
	blank()
	log(`  ${c.bold("2.")} Grant SymbolManager operator roles.`)
	log(`     ${c.grey("The SymbolManager constructor gives DEFAULT_ADMIN_ROLE to the admin only,")}`)
	log(`     ${c.grey("so the deployer cannot do this. From the admin:")}`)
	log(`     ${c.cyan(`npx hardhat symbolManager:grantOperatorRoles --symbol-manager-address <addr> --operator <addr> --network ${networkName}`)}`)
	blank()
	log(`  ${c.bold("3.")} Add trading symbols — deploy:system deploys the machinery but seeds no symbols.`)
	blank()
	log(`  Then confirm the result: ${c.cyan(`symmio status --network ${networkName}`)}`)
	blank()

	return ccode === 0 ? 0 : 1
}
