// `symmio doctor` — everything that should be true BEFORE you spend gas.
//
// The audit that motivated this CLI found that the expensive failures were operator
// failures, not code failures: a variable the config never reads, a mock verifier left
// enabled, a collateral address nobody set. Every check here corresponds to a way a real
// deployment has been or could be silently ruined.

import fs from "node:fs"
import { Contract } from "ethers"

import {
	KNOWN_COLLATERAL,
	UNSAFE_DEPLOYERS,
	isMainnet,
	loadEnv,
	makeProvider,
	readCheckpoint,
	resolveDeployer,
	resolveNetwork,
	rpcUrl,
} from "../lib/context.js"
import { checkMirrorDrift } from "../lib/safety-mirror.js"
import { blank, c, fail, info, kv, log, ok, skip, title, warn } from "../lib/ui.js"

const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"]

class Report {
	constructor() {
		this.errors = 0
		this.warnings = 0
	}
	ok(m, d) {
		ok(m, d)
	}
	warn(m, d) {
		this.warnings++
		warn(m, d)
	}
	fail(m, d) {
		this.errors++
		fail(m, d)
	}
	info(m, d) {
		info(m, d)
	}
	skip(m, d) {
		skip(m, d)
	}
}

export async function doctor(args) {
	const networkName = args.network
	if (!networkName) {
		throw new Error("--network is required (e.g. --network arbitrum)")
	}
	const chain = resolveNetwork(networkName)
	const { vars: env, path: envPath, exists: envExists } = loadEnv()
	const mainnet = isMainnet(chain.chainId)
	const r = new Report()

	blank()
	kv([
		["network", `${chain.key} ${c.grey(`(${chain.name}, chainId ${chain.chainId})`)}`],
		["mode", mainnet ? c.yellow("MAINNET — real funds") : c.grey("non-mainnet")],
	])

	// ── environment file ────────────────────────────────────────────────────────
	title("Environment")
	if (!envExists) {
		r.fail(".env not found", envPath)
		r.info("copy .env.example to .env and fill it in")
	} else {
		r.ok(".env found", envPath)
	}

	// PRIVATE_KEY is the single most dangerous piece of documentation drift in this repo:
	// operators set it, believe they configured the deployer, and sign with a public key.
	if (env.PRIVATE_KEY) {
		r.fail("PRIVATE_KEY is set but nothing reads it", "hardhat.config.ts uses NEW_DEPLOYER / TEAM_DEPLOYER / keystore")
	}
	if (env.PRIVATE_KEYS_STR) {
		r.warn("PRIVATE_KEYS_STR is set but nothing reads it", "safe to delete")
	}

	// ── deployer ────────────────────────────────────────────────────────────────
	title("Deployer")
	const deployer = resolveDeployer(env)
	if (deployer.keystore) {
		r.ok("deployer comes from the hardhat keystore", "USE_KEYSTORE=true")
		r.info("address cannot be shown without the keystore password")
	} else if (deployer.invalid) {
		r.fail(`${deployer.source} is set but is not a valid private key`)
	} else if (deployer.isDummy || UNSAFE_DEPLOYERS.has((deployer.address || "").toLowerCase())) {
		const why = UNSAFE_DEPLOYERS.get((deployer.address || "").toLowerCase()) || "committed to this repo"
		if (mainnet) r.fail(`deployer is a publicly-known key (${why})`, deployer.address)
		else r.warn(`deployer is a publicly-known key (${why})`, deployer.address)
		r.info("set NEW_DEPLOYER, or USE_KEYSTORE=true")
	} else {
		r.ok(`deployer resolved from ${deployer.source}`, deployer.address)
	}

	// ── rpc ─────────────────────────────────────────────────────────────────────
	title("RPC")
	const url = rpcUrl(networkName, env)
	const usingDefault = !env[`RPC_${networkName.toUpperCase()}`] && !process.env[`RPC_${networkName.toUpperCase()}`]
	if (usingDefault && mainnet) {
		r.warn(`using the built-in public endpoint`, url)
		r.info(`set RPC_${networkName.toUpperCase()} — public RPCs rate-limit and can drop transactions`)
	} else {
		r.ok("endpoint configured", usingDefault ? url : "from RPC_" + networkName.toUpperCase())
	}

	let provider = null
	let liveChainId = null
	try {
		provider = makeProvider(networkName, env)
		const net = await provider.getNetwork()
		liveChainId = Number(net.chainId)
		if (liveChainId !== chain.chainId) {
			r.fail(`RPC reports chainId ${liveChainId}, expected ${chain.chainId}`, "the endpoint points at the wrong chain")
		} else {
			const block = await provider.getBlockNumber()
			r.ok(`reachable, chainId ${liveChainId}`, `block ${block}`)
		}
	} catch (err) {
		r.fail("RPC unreachable", (err.shortMessage || err.message || "").slice(0, 90))
	}

	// ── deployer balance ────────────────────────────────────────────────────────
	if (provider && deployer.address && liveChainId === chain.chainId) {
		try {
			const bal = await provider.getBalance(deployer.address)
			const eth = Number(bal) / 1e18
			if (bal === 0n) r.fail("deployer balance is zero", deployer.address)
			else if (mainnet && eth < 0.05) r.warn(`deployer balance is low: ${eth.toFixed(5)} ETH`, "a full deploy is ~45 contracts")
			else r.ok(`deployer balance ${eth.toFixed(5)} ETH`)
		} catch {
			r.warn("could not read deployer balance")
		}
	}

	// ── deployment configuration ────────────────────────────────────────────────
	title("Deployment configuration")

	const admin = env.ADMIN_PUBLIC_KEY
	if (!admin) {
		if (mainnet) r.fail("ADMIN_PUBLIC_KEY is not set", "would default to the deployer, leaving a hot wallet as protocol admin")
		else r.warn("ADMIN_PUBLIC_KEY is not set", "defaults to the deployer")
	} else if (deployer.address && admin.toLowerCase() === deployer.address.toLowerCase()) {
		if (mainnet) r.warn("ADMIN_PUBLIC_KEY is the deployer", "privileges cannot be handed over; use a multisig")
		else r.ok("ADMIN_PUBLIC_KEY set (same as deployer)", admin)
	} else {
		r.ok("ADMIN_PUBLIC_KEY set", admin)
	}

	if (!env.SYMMIO_FEE_RECEIVER) r.warn("SYMMIO_FEE_RECEIVER not set", "defaults to ADMIN_PUBLIC_KEY")
	else r.ok("SYMMIO_FEE_RECEIVER set", env.SYMMIO_FEE_RECEIVER)

	// collateral — a wrong or empty value here is unrecoverable after setCollateral
	const collateral = env.COLLATERAL_ADDRESS
	if (!collateral) {
		if (mainnet) r.fail("COLLATERAL_ADDRESS is empty", "deploy:system would create a mintable FakeStablecoin as protocol collateral")
		else r.info("COLLATERAL_ADDRESS empty — a FakeStablecoin will be deployed (fine locally)")
	} else if (provider && liveChainId === chain.chainId) {
		try {
			const code = await provider.getCode(collateral)
			if (code === "0x") {
				r.fail("COLLATERAL_ADDRESS has no contract code on this chain", collateral)
			} else {
				const token = new Contract(collateral, ERC20, provider)
				const [sym, dec] = [await token.symbol(), Number(await token.decimals())]
				const known = KNOWN_COLLATERAL[chain.chainId]?.[collateral.toLowerCase()]
				r.ok(`collateral ${sym} (${dec} decimals)`, known ? `recognised: ${known}` : collateral)
				if (!known && mainnet) r.warn("collateral is not a token this CLI recognises for this chain", "double-check the address")
			}
		} catch {
			r.warn("could not read collateral token metadata", collateral)
		}
	}

	// the two switches that silently produce a compromised protocol
	if (env.DEPLOY_MOCK_VERIFIER === "true") {
		if (mainnet) r.fail("DEPLOY_MOCK_VERIFIER=true", "installs a verifier that accepts EVERY signature")
		else r.info("DEPLOY_MOCK_VERIFIER=true (expected for local/test)")
	} else {
		r.ok("DEPLOY_MOCK_VERIFIER is off")
	}
	if (env.REGISTER_DUMMY_AFFILIATE === "true") {
		if (mainnet) r.fail("REGISTER_DUMMY_AFFILIATE=true", 'registers a real "Test Affiliate" on-chain')
		else r.info("REGISTER_DUMMY_AFFILIATE=true (expected for local/test)")
	} else {
		r.ok("REGISTER_DUMMY_AFFILIATE is off")
	}

	// muon
	const muonMissing = ["MUON_APP_ID", "MUON_PUBLIC_KEY_X", "MUON_PUBLIC_KEY_PARITY", "MUON_GATEWAY_SIGNERS"].filter(k => !env[k])
    if (env.DEPLOY_MOCK_VERIFIER === "true") {
		r.skip("Muon configuration not required with the mock verifier")
	} else if (muonMissing.length) {
		if (mainnet) r.fail(`Muon configuration incomplete: ${muonMissing.join(", ")}`)
		else r.warn(`Muon configuration incomplete: ${muonMissing.join(", ")}`)
	} else {
		r.ok("Muon configuration present", `validity ${env.MUON_UPNL_VALID_TIME || 300}/${env.MUON_PRICE_VALID_TIME || 300}s`)
	}

	if (!env.ETHERSCAN_APIKEY) r.warn("ETHERSCAN_APIKEY not set", "contract verification will fail")
	else r.ok("ETHERSCAN_APIKEY set")

	// ── protocol config ─────────────────────────────────────────────────────────
	title("Protocol config")
	const cfgPath = `tasks/config/protocol-${chain.chainId}.json`
	if (!fs.existsSync(cfgPath)) {
		r.info(`no ${cfgPath} — built-in defaults will be used`)
		r.info("run `symmio config export` to mirror an existing deployment")
	} else {
		try {
			const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
			const required = [
				"balanceLimitPerUser",
				"maxWithdrawParts",
				"deallocateCooldown",
				"settlementCooldown",
				"deallocateDebounceTime",
				"liquidatorShare",
				"liquidationTimeout",
				"forceCloseCooldowns",
				"forceCancelCooldown",
				"forceCancelCloseCooldown",
				"pendingQuotesValidLength",
				"maxPartyAConnectionLimit",
			]
			const missing = required.filter(k => cfg.parameters?.[k] === undefined)
			if (missing.length) r.fail(`${cfgPath} missing parameters: ${missing.join(", ")}`)
			else r.ok(`${cfgPath} valid`, `${cfg.instantLayerTemplates?.length ?? 0} templates`)

			const unverified = cfg._provenance?.UNVERIFIED_still_defaults
			if (unverified?.length) {
				r.warn(`${unverified.length} parameters are unverified defaults`, unverified.join(", "))
			}
			if (cfg.instantLayerTemplates?.length) {
				log("")
				for (const [i, t] of cfg.instantLayerTemplates.entries()) {
					info(`template ${i}: ${t.name}`, `${t.operations.length} ops${t.instantOpenMode ? ", instantOpenMode" : ""}`)
				}
			}
		} catch (err) {
			r.fail(`${cfgPath} is not valid JSON`, String(err.message).slice(0, 80))
		}
	}

	// ── in-flight deployment ────────────────────────────────────────────────────
	title("Deployment state")
	const checkpoint = readCheckpoint(chain.chainId)
	if (!checkpoint) {
		r.ok("no in-progress checkpoint — this would be a fresh deployment")
	} else if (checkpoint._corrupt) {
		r.fail("checkpoint file is unreadable", checkpoint._path)
	} else {
		r.warn(`a checkpoint exists — deploy:system would RESUME, not start fresh`, checkpoint._path)
		r.info(`last step: ${checkpoint.step ?? "unknown"}`)
	}

	// ── internal consistency ────────────────────────────────────────────────────
	const drift = checkMirrorDrift()
	if (drift.problems.length) {
		title("CLI consistency")
		for (const p of drift.problems) r.warn(p)
	}

	// ── verdict ─────────────────────────────────────────────────────────────────
	blank()
	if (r.errors > 0) {
		log(`  ${c.red(c.bold(`${r.errors} blocking issue${r.errors > 1 ? "s" : ""}`))}${r.warnings ? c.grey(`, ${r.warnings} warning${r.warnings > 1 ? "s" : ""}`) : ""}`)
		log(`  ${c.grey("fix these before deploying")}`)
		blank()
		return 1
	}
	if (r.warnings > 0) {
		log(`  ${c.yellow(c.bold(`ready, with ${r.warnings} warning${r.warnings > 1 ? "s" : ""}`))}`)
		blank()
		return 0
	}
	log(`  ${c.green(c.bold("all checks passed"))}`)
	blank()
	return 0
}
