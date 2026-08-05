// `symmio config show|diff|export`
//
// `diff` is the reason this exists: comparing a live deployment against the config a new
// chain would deploy with. It is how the HyperEVM/Arbitrum template mismatch was found —
// InstantLayer template ids are referenced by hedgers, and the built-in defaults put a
// different template at id 3 than HyperEVM runs.

import fs from "node:fs"
import { Contract } from "ethers"

import { loadEnv, makeProvider, resolveNetwork } from "../lib/context.js"
import { hardhat } from "../lib/hardhat.js"
import { blank, c, fail, info, kv, log, ok, table, title, warn } from "../lib/ui.js"

const VIEW_ABI = [
	"function getBalanceLimitPerUser() view returns (uint256)",
	"function getMaxWithdrawParts() view returns (uint256)",
	"function getMinWithdrawCooldown() view returns (uint256)",
	"function getDeallocateDebounceTime() view returns (uint256)",
	"function getMuonConfig() view returns (uint256,uint256)",
	"function getCollateral() view returns (address)",
	"function getSignatureVerifier() view returns (address)",
]
const IL_ABI = [
	"function getTemplates(uint256,uint256) view returns (tuple(string name, tuple(uint256[] insertionPoints, uint256[] sourceIndices, uint256[] sourceOffsets)[] operations, bool active)[])",
]

function configPath(chainId) {
	return `tasks/config/protocol-${chainId}.json`
}

function readConfig(chainId) {
	const p = configPath(chainId)
	if (!fs.existsSync(p)) return null
	return JSON.parse(fs.readFileSync(p, "utf8"))
}

export async function config(args) {
	const sub = args._[1]
	if (!sub || sub === "show") return show(args)
	if (sub === "diff") return diff(args)
	if (sub === "export") return exportConfig(args)
	throw new Error(`Unknown subcommand "${sub}". Use: show | diff | export`)
}

function show(args) {
	const chainId = args.chain ? Number(args.chain) : args.network ? resolveNetwork(args.network).chainId : null
	if (!chainId) throw new Error("pass --chain <id> or --network <name>")

	const cfg = readConfig(chainId)
	if (!cfg) {
		blank()
		info(`no ${configPath(chainId)} — deploy:system would use built-in defaults`)
		blank()
		return 0
	}

	title(`Protocol config — chain ${chainId}`)
	if (cfg.description) log(`  ${c.grey(cfg.description)}`)
	blank()
	kv(Object.entries(cfg.parameters).map(([k, v]) => [k, Array.isArray(v) ? `[${v.join(", ")}]` : String(v)]))

	title("InstantLayer templates")
	table(
		["id", "name", "ops", "instantOpenMode"],
		(cfg.instantLayerTemplates ?? []).map((t, i) => [i, t.name, t.operations.length, t.instantOpenMode ? "yes" : ""]),
	)

	const unverified = cfg._provenance?.UNVERIFIED_still_defaults
	if (unverified?.length) {
		blank()
		warn(`${unverified.length} parameters are unverified defaults`, unverified.join(", "))
	}
	blank()
	return 0
}

async function diff(args) {
	const networkName = args.network
	const symmio = args.symmio
	const instantLayer = args["instant-layer"]
	const against = args.against ? Number(args.against) : null

	if (!networkName || !symmio) {
		throw new Error("usage: symmio config diff --network <live-network> --symmio <address> [--instant-layer <address>] --against <chainId>")
	}
	if (!against) throw new Error("--against <chainId> is required (the config file to compare with)")

	const cfg = readConfig(against)
	if (!cfg) throw new Error(`no ${configPath(against)} to compare against`)

	const { vars: env } = loadEnv()
	const provider = makeProvider(networkName, env)
	const chain = resolveNetwork(networkName)

	title(`Live ${chain.name} vs ${configPath(against)}`)
	blank()

	const view = new Contract(symmio, VIEW_ABI, provider)
	const rows = []
	let mismatches = 0

	const cmp = (label, live, configured) => {
		const same = String(live) === String(configured)
		if (!same) mismatches++
		rows.push([same ? c.green("=") : c.red("≠"), label, String(live), String(configured)])
	}

	try {
		cmp("balanceLimitPerUser", (await view.getBalanceLimitPerUser()).toString(), cfg.parameters.balanceLimitPerUser)
		cmp("maxWithdrawParts", (await view.getMaxWithdrawParts()).toString(), cfg.parameters.maxWithdrawParts)
		cmp("deallocateCooldown", (await view.getMinWithdrawCooldown()).toString(), cfg.parameters.deallocateCooldown)
		cmp("deallocateDebounceTime", (await view.getDeallocateDebounceTime()).toString(), cfg.parameters.deallocateDebounceTime)
	} catch (err) {
		fail("could not read parameters from the live deployment", (err.shortMessage || err.message).slice(0, 80))
		return 1
	}

	table([" ", "parameter", "live", "config"], rows)

	// muon validity lives in .env, not the config file — report it separately
	try {
		const [upnl, price] = await view.getMuonConfig()
		blank()
		info(`live Muon validity: ${upnl}/${price}s`, "set via MUON_UPNL_VALID_TIME / MUON_PRICE_VALID_TIME in .env")
	} catch {
		/* optional */
	}

	// templates — order matters, ids are part of the contract with hedgers
	if (instantLayer) {
		title("InstantLayer templates")
		const il = new Contract(instantLayer, IL_ABI, provider)
		const live = await il.getTemplates(0, 100)
		const configured = cfg.instantLayerTemplates ?? []
		const max = Math.max(live.length, configured.length)
		const trows = []
		for (let i = 0; i < max; i++) {
			const l = live[i]
			const k = configured[i]
			const lname = l ? `${l.name} (${l.operations.length})` : c.grey("—")
			const kname = k ? `${k.name} (${k.operations.length})` : c.grey("—")
			const same = l && k && l.name === k.name && l.operations.length === k.operations.length
			if (!same) mismatches++
			trows.push([same ? c.green("=") : c.red("≠"), i, lname, kname])
		}
		table([" ", "id", "live", "config"], trows)
	} else {
		blank()
		info("pass --instant-layer <address> to compare templates too")
	}

	blank()
	if (mismatches === 0) {
		log(`  ${c.green(c.bold("configurations match"))}`)
		blank()
		return 0
	}
	log(`  ${c.red(c.bold(`${mismatches} difference${mismatches > 1 ? "s" : ""}`))}`)
	log(`  ${c.grey("template ids are referenced by hedgers — a mismatch there changes behaviour silently")}`)
	blank()
	return 1
}

async function exportConfig(args) {
	const networkName = args.network
	if (!networkName || !args.symmio) {
		throw new Error("usage: symmio config export --network <live-network> --symmio <address> [--instant-layer <address>] [--to <chainId>]")
	}
	const to = args.to ? String(args.to) : String(resolveNetwork(networkName).chainId)
	info(`reading ${args.symmio} on ${networkName} → ${configPath(to)}`)
	return hardhat(["run", "scripts/exportProtocolConfig.ts", "--network", networkName], {
		env: {
			SYMMIO: args.symmio,
			INSTANT_LAYER: args["instant-layer"] ?? "",
			TARGET_CHAIN_ID: to,
		},
	})
}
