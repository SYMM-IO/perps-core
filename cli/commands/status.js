// `symmio status --network <n>` — what is actually deployed on a chain, and is it safe?
//
// Reads the local deployment records, then probes the chain itself. The on-chain probes
// matter more than the records: records can be stale or missing, and the questions that
// actually decide whether a deployment is finished ("does the deployer still hold admin?",
// "did every facet land?") can only be answered on-chain.

import { Contract } from "ethers"

import { explorerAddressUrl, isMainnet, loadEnv, makeProvider, readCheckpoint, readDeploymentRecords, resolveDeployer, resolveNetwork } from "../lib/context.js"
import { blank, c, fail, info, kv, log, ok, skip, table, title, warn } from "../lib/ui.js"

const LOUPE_ABI = ["function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])"]
const VIEW_ABI = [
	"function hasRole(address user, bytes32 role) view returns (bool)",
	"function getCollateral() view returns (address)",
	"function getSignatureVerifier() view returns (address)",
	"function getMuonConfig() view returns (uint256,uint256)",
]
const IL_ABI = [
	"function getTemplates(uint256,uint256) view returns (tuple(string name, tuple(uint256[] insertionPoints, uint256[] sourceIndices, uint256[] sourceOffsets)[] operations, bool active)[])",
]
const ERC20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"]

const roleHash = (ethersLike, name) => ethersLike.id(name)

export async function status(args) {
	const networkName = args.network
	if (!networkName) throw new Error("--network is required")
	const chain = resolveNetwork(networkName)
	const { vars: env } = loadEnv()
	const provider = makeProvider(networkName, env)
	const mainnet = isMainnet(chain.chainId)

	blank()
	kv([
		["network", `${chain.key} ${c.grey(`(chainId ${chain.chainId})`)}`],
		["mode", mainnet ? c.yellow("MAINNET") : c.grey("non-mainnet")],
	])

	// ── local records ───────────────────────────────────────────────────────────
	title("Deployment records")
	const records = readDeploymentRecords(chain.chainId)
	if (records.length === 0) {
		warn("no local deployment records for this chain", `expected under tasks/data/${chain.chainId}/`)
		info("records are written by deploy:system and read by verify:all")
	} else {
		const seen = new Map()
		for (const rec of records) if (rec.name && rec.address) seen.set(rec.name, rec.address)
		table(
			["contract", "address"],
			[...seen.entries()].slice(0, 40).map(([n, a]) => [n, a]),
		)
		info(`${seen.size} recorded contract${seen.size === 1 ? "" : "s"}`)
	}

	const checkpoint = readCheckpoint(chain.chainId)
	if (checkpoint && !checkpoint._corrupt) {
		warn("an in-progress checkpoint exists", `last step: ${checkpoint.step ?? "unknown"}`)
	} else if (checkpoint?._corrupt) {
		fail("checkpoint file is unreadable", checkpoint._path)
	}

	// ── on-chain ────────────────────────────────────────────────────────────────
	const diamond = args.diamond || findRecorded(records, ["Diamond", "SymmioDiamond"])
	if (!diamond) {
		blank()
		info("pass --diamond <address> to probe the deployment on-chain")
		blank()
		return 0
	}

	title("On-chain")
	log(`  ${c.grey("diamond")}  ${diamond}`)
	log(`  ${c.grey("explorer")} ${explorerAddressUrl(networkName, diamond)}`)
	blank()

	const code = await provider.getCode(diamond)
	if (code === "0x") {
		fail("no contract code at that address on this chain")
		blank()
		return 1
	}

	let problems = 0

	// facet completeness — the resume bug this audit fixed shipped diamonds missing facets
	try {
		const loupe = new Contract(diamond, LOUPE_ABI, provider)
		const facets = await loupe.facets()
		const selectors = facets.reduce((n, f) => n + f.functionSelectors.length, 0)
		if (facets.length < 20) {
			problems++
			fail(`only ${facets.length} facets installed`, `${selectors} selectors — a complete v0.8.6 diamond has ~31 facets`)
		} else {
			ok(`${facets.length} facets installed`, `${selectors} selectors`)
		}
	} catch {
		problems++
		fail("DiamondLoupeFacet not reachable", "the diamond cut may be incomplete")
	}

	const view = new Contract(diamond, VIEW_ABI, provider)

	try {
		const collateral = await view.getCollateral()
		const token = new Contract(collateral, ERC20, provider)
		const [sym, dec] = [await token.symbol(), Number(await token.decimals())]
		if (/fake/i.test(sym)) {
			problems++
			fail(`collateral is ${sym} (${dec} decimals)`, "a FakeStablecoin is wired in as protocol collateral")
		} else {
			ok(`collateral ${sym} (${dec} decimals)`, collateral)
		}
	} catch {
		warn("could not read collateral")
	}

	try {
		const verifier = await view.getSignatureVerifier()
		const vcode = await provider.getCode(verifier)
		if (vcode === "0x") {
			problems++
			fail("signature verifier has no code", verifier)
		} else {
			// A mock verifier has no roles; a real MuonSignatureVerifier exposes SETTER_ROLE.
			const probe = new Contract(verifier, ["function SETTER_ROLE() view returns (bytes32)"], provider)
			let looksReal = true
			try {
				await probe.SETTER_ROLE()
			} catch {
				looksReal = false
			}
			if (!looksReal) {
				problems++
				fail("signature verifier looks like MockMuonSignatureVerifier", `${verifier} — accepts every signature`)
			} else {
				ok("signature verifier present", verifier)
			}
		}
	} catch {
		warn("could not read signature verifier")
	}

	try {
		const [upnl, price] = await view.getMuonConfig()
		ok(`Muon validity ${upnl}/${price}s`)
	} catch {
		warn("could not read Muon config")
	}

	// role hygiene — the whole point of the revoke step added in this audit
	title("Role hygiene")
	const { id } = await import("ethers")
	const deployer = resolveDeployer(env)
	const admin = env.ADMIN_PUBLIC_KEY

	const checkRole = async (who, label, role) => {
		if (!who) return null
		try {
			return await view.hasRole(who, id(role))
		} catch {
			warn(`could not read ${role} for ${label}`)
			return null
		}
	}

	if (admin) {
		const adminHas = await checkRole(admin, "admin", "DEFAULT_ADMIN_ROLE")
		if (adminHas === true) ok("ADMIN_PUBLIC_KEY holds DEFAULT_ADMIN_ROLE", admin)
		else if (adminHas === false) {
			problems++
			fail("ADMIN_PUBLIC_KEY does NOT hold DEFAULT_ADMIN_ROLE", admin)
		}
	} else {
		skip("ADMIN_PUBLIC_KEY not set — cannot check the intended admin")
	}

	if (deployer.address) {
		const deployerHas = await checkRole(deployer.address, "deployer", "DEFAULT_ADMIN_ROLE")
		if (deployerHas === true) {
			problems++
			fail("the DEPLOYER still holds DEFAULT_ADMIN_ROLE", `${deployer.address} — a hot wallet with full protocol admin`)
			info("deploy:system step 11 revokes this; it may not have run")
		} else if (deployerHas === false) {
			ok("deployer holds no admin role")
		}
		const muonSetter = await checkRole(deployer.address, "deployer", "MUON_SETTER_ROLE")
		if (muonSetter === true) {
			problems++
			fail("the deployer still holds MUON_SETTER_ROLE", deployer.address)
		}
	} else {
		skip("deployer address unknown (keystore) — cannot check for leftover privileges")
	}

	// templates
	const instantLayer = args["instant-layer"] || findRecorded(records, ["InstantLayer"])
	if (instantLayer) {
		title("InstantLayer templates")
		try {
			const il = new Contract(instantLayer, IL_ABI, provider)
			const templates = await il.getTemplates(0, 100)
			table(
				["id", "name", "ops", "active"],
				templates.map((t, i) => [i, t.name, t.operations.length, t.active ? "yes" : c.red("no")]),
			)
		} catch {
			warn("could not read templates", instantLayer)
		}
	}

	blank()
	if (problems > 0) {
		log(`  ${c.red(c.bold(`${problems} problem${problems > 1 ? "s" : ""} found`))}`)
		blank()
		return 1
	}
	log(`  ${c.green(c.bold("deployment looks healthy"))}`)
	blank()
	return 0
}

function findRecorded(records, names) {
	for (const n of names) {
		const hit = records.find(r => r.name === n)
		if (hit?.address) return hit.address
	}
	return null
}
