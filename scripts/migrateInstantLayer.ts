/**
 * Replace a deployed InstantLayer with a fresh one and re-point the rest of the system to it.
 *
 * Plan (read-only; snapshots the old layer, prints the replay plan, current wiring, and whether
 * the admin can execute the binding actions):
 *   npx hardhat run --no-compile scripts/migrateInstantLayer.ts --network arbitrum
 *
 * Execute (deployer phase, then the admin phase when the admin key is configured):
 *   EXECUTE=true CONFIRM_CHAIN_ID=42161 \
 *     npx hardhat run --no-compile scripts/migrateInstantLayer.ts --network arbitrum
 *
 * Phases (PHASE=all by default):
 *   deploy       deploy + configure + hand over the new layer, deploy the GaslessLayer implementation,
 *                verify the replacement against the old snapshot, write the admin batches.
 *   bind         execute the cutover batch as the admin (needs the admin key), then check wiring.
 *   decommission execute the decommission batch as the admin, after the transition window.
 *   all          deploy, then bind when the admin key is available.
 * The deployer key is signer 0 (NEW_DEPLOYER). The admin phase signs with ADMIN_SIGNER:
 *   auto (default)  a configured signer whose address is the admin (keystore key, or the
 *                   hardhat-ledger plugin via SYMMIO_SIGNER_MODE=ledger SYMMIO_LEDGER_ADDRESS=0x..)
 *   cast-ledger     Foundry `cast send --ledger`, the path used for the governance handover; needs
 *                   `cast` on PATH and the Ledger unlocked in the Ethereum app (LEDGER_SCAN_COUNT,
 *                   CAST_BIN optional)
 *   impersonate     simulated forks only, for rehearsals
 * When the admin is a Safe, import the written batch files into the Transaction Builder instead.
 *
 * Check a layer's wiring and parity with the old one:
 *   CHECK_INSTANT_LAYER=0x... npx hardhat run --no-compile scripts/migrateInstantLayer.ts --network arbitrum
 *
 * Defaults come from tasks/data/<chainId>/deployment-report.json and gaslesslayer.json; every one
 * can be overridden: OLD_INSTANT_LAYER, GASLESS_LAYER, SAFE_ADDRESS, CORE_ADDRESS,
 * ACCOUNT_LAYER_ADDRESS, PARTY_BS (comma-separated, added to the on-chain discovery),
 * GASLESS_LIB_<NAME>, SNAPSHOT_FROM_BLOCK, DEPLOYER_ADDRESS (plan/check without a signer),
 * ALLOW_NO_PARTY_BS, OUTPUT_DIR. A run is resumable: the state file under OUTPUT_DIR records what
 * was deployed.
 *
 * Templates: the new layer replays the old layer's templates with the same ids, then appends the
 * recipe's extra templates (TEMPLATES_RECIPE, default per chain; "none" to add nothing). The
 * recipe's leading entries must match the deployed ones exactly, so ids stay stable for hedgers.
 */
import fs from "node:fs"
import path from "node:path"

import { loadDeploymentRecipe } from "../deployment-tooling/recipe.js"
import { requireExecutionConfirmation } from "../tasks/deploy/executionGuard.js"
import connection, { ethers } from "../test/helpers/hardhat-connection.js"
import { executeActionsWithCastLedger } from "./utils/castLedgerSigner.js"
import {
	buildCutoverSafeActions,
	buildDecommissionSafeActions,
	buildInstantLayerReplayPlan,
	buildSafeTransactionBuilderBatch,
	planAdditionalTemplates,
	type InstantLayerSnapshot,
	type RecipeTemplate,
	type SafeAction,
} from "./utils/instantLayerMigration.js"
import {
	GASLESS_LIBRARY_NAMES,
	checkInstantLayerWiring,
	executeSafeActions,
	loadMigrationDefaults,
	migrateInstantLayer,
	simulateSafeActions,
	snapshotInstantLayer,
	verifyInstantLayerReplacement,
	type MigrationState,
} from "./utils/instantLayerMigrationRunner.js"
import { resolveHttpRpcUrl } from "./utils/resolveHttpRpcUrl.js"

const PLACEHOLDER = "0x1111111111111111111111111111111111111111"
const DEFAULT_TEMPLATES_RECIPE: Record<string, string> = { "42161": "deployment-recipes/arbitrum-vibe-production.json" }

function recipeTemplates(chainId: bigint): { source: string; templates: RecipeTemplate[] } | undefined {
	const configured = process.env.TEMPLATES_RECIPE || DEFAULT_TEMPLATES_RECIPE[chainId.toString()]
	if (!configured || configured === "none") return undefined
	const loaded: any = loadDeploymentRecipe(configured)
	const recipe = loaded.recipe ?? loaded
	if (Number(recipe.network?.chainId) !== Number(chainId)) throw new Error(`${configured} targets chainId ${recipe.network?.chainId}, not ${chainId}`)
	return { source: configured, templates: recipe.core.protocol.instantLayerTemplates as RecipeTemplate[] }
}

function withAdditionalTemplates(snapshot: InstantLayerSnapshot, chainId: bigint, log: (message: string) => void): InstantLayerSnapshot {
	const recipe = recipeTemplates(chainId)
	if (!recipe) return snapshot
	const additional = planAdditionalTemplates(snapshot.templates, recipe.templates)
	log(`templates from ${recipe.source}: ${snapshot.templates.length} replayed, ${additional.length} added`)
	return { ...snapshot, templates: [...snapshot.templates, ...additional] }
}

function optionalAddress(name: string): string | undefined {
	const value = process.env[name]
	if (!value) return undefined
	if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address when provided`)
	return ethers.getAddress(value)
}

function readJson<T>(file: string): T | undefined {
	return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : undefined
}

function atomicWriteJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
	fs.writeFileSync(temporary, `${JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry), 2)}\n`, {
		mode: 0o600,
	})
	fs.renameSync(temporary, file)
}

function partyBsFromEnv(): string[] | undefined {
	const raw = process.env.PARTY_BS
	if (!raw) return undefined
	return raw.split(",").map(value => {
		const trimmed = value.trim()
		if (!ethers.isAddress(trimmed)) throw new Error(`PARTY_BS contains an invalid address: ${JSON.stringify(trimmed)}`)
		return ethers.getAddress(trimmed)
	})
}

type Phase = "all" | "deploy" | "bind" | "decommission"

function phaseFromEnv(): Phase {
	const raw = process.env.PHASE || "all"
	if (!["all", "deploy", "bind", "decommission"].includes(raw))
		throw new Error(`PHASE must be all, deploy, bind, or decommission; received ${JSON.stringify(raw)}`)
	return raw as Phase
}

type AdminSignerMode = "auto" | "cast-ledger" | "impersonate"

function adminSignerMode(): AdminSignerMode {
	const raw = process.env.ADMIN_SIGNER || "auto"
	if (!["auto", "cast-ledger", "impersonate"].includes(raw))
		throw new Error(`ADMIN_SIGNER must be auto, cast-ledger, or impersonate; received ${JSON.stringify(raw)}`)
	return raw as AdminSignerMode
}

interface AdminExecutor {
	isContract: boolean
	describe: string
	/** Present when this process can send transactions as the admin. */
	execute?: (actions: SafeAction[], log: (message: string) => void) => Promise<number>
}

async function resolveAdminExecutor(admin: string, mode: AdminSignerMode, chainId: bigint, outputDir: string): Promise<AdminExecutor> {
	const isContract = (await ethers.provider.getCode(admin)) !== "0x"
	if (isContract) return { isContract, describe: "contract; batches must be imported" }
	if (mode === "impersonate") {
		// Only a Hardhat simulator (in-process fork or `hardhat node --fork`) answers hardhat_metadata.
		const simulated = await ethers.provider.send("hardhat_metadata", []).then(
			() => true,
			() => false,
		)
		if (!simulated) throw new Error("ADMIN_SIGNER=impersonate is only allowed on a Hardhat fork")
		return {
			isContract,
			describe: "EOA, impersonated (Hardhat fork)",
			execute: async (actions, log) => {
				await ethers.provider.send("hardhat_impersonateAccount", [admin])
				await ethers.provider.send("hardhat_setBalance", [admin, "0x" + (10n ** 20n).toString(16)])
				return executeSafeActions(ethers, await ethers.getSigner(admin), actions, log)
			},
		}
	}
	if (mode === "cast-ledger") {
		const rpcUrl = await resolveHttpRpcUrl((connection as any).networkConfig?.url)
		return {
			isContract,
			describe: "EOA, Ledger via cast",
			execute: async (actions, log) =>
				executeActionsWithCastLedger(actions, {
					castBin: process.env.CAST_BIN,
					rpcUrl,
					chainId,
					admin,
					confirmations: Number(process.env.ADMIN_CONFIRMATIONS || 1),
					scanCount: Number(process.env.LEDGER_SCAN_COUNT || 20),
					pathCacheFile: path.join(outputDir, "ledger-path-cache.json"),
					log,
				}).length,
		}
	}
	for (const candidate of await ethers.getSigners()) {
		if ((await candidate.getAddress()).toLowerCase() === admin.toLowerCase()) {
			return {
				isContract,
				describe: "EOA, key configured as a signer",
				execute: (actions, log) => executeSafeActions(ethers, candidate, actions, log),
			}
		}
	}
	return { isContract, describe: "EOA, no signer configured (set ADMIN_SIGNER=cast-ledger or configure the key)" }
}

function printWiring(report: Awaited<ReturnType<typeof checkInstantLayerWiring>>): void {
	console.log(`  Wiring for InstantLayer ${report.instantLayer}: ${report.ok ? "fully bound" : "not fully bound"}`)
	for (const binding of report.bindings) console.log(`    ${binding.ok ? "✔" : "✘"} ${binding.label} (${binding.detail})`)
}

function printSimulation(title: string, results: Awaited<ReturnType<typeof simulateSafeActions>>): boolean {
	const ok = results.every(r => r.ok)
	console.log(`  ${title}: ${ok ? "every action simulates from the admin" : "SOME ACTIONS REVERT when simulated from the admin"}`)
	for (const r of results) console.log(`    ${r.ok ? "✔" : "✘"} ${r.description}${r.error ? ` -> ${r.error}` : ""}`)
	return ok
}

function printActions(title: string, actions: SafeAction[]): void {
	console.log(`  ${title}: ${actions.length} action(s)`)
	actions.forEach((action, index) => console.log(`    ${index + 1}. ${action.description}`))
}

function printOffChainChecklist(newInstantLayer: string): void {
	console.log("\nOff-chain follow-ups (not automated):")
	console.log(`  - Frontends: InstantLayer address and EIP-712 verifyingContract -> ${newInstantLayer}; users re-grant delegations (one signature).`)
	console.log("  - Relayer bots: new address; ordered nonces restart at 0 on the new layer.")
	console.log("  - Solver bots (PartyB signers): sign SignedOperations against the new verifyingContract.")
	console.log("  - Subgraphs / analytics: index the new InstantLayer address if they consume its events.")
	console.log("  - Address registry / docs: publish the new address next to the old one for the transition window.")
	console.log(
		"  - Repo records once batch 1 is confirmed: set addresses.instantLayer in tasks/data/<chainId>/deployment-report.json and append the new entry to tasks/data/<chainId>/instantlayer.json, so check:deployment and verify:all follow the new layer.",
	)
}

async function main(): Promise<void> {
	const chainId = (await ethers.provider.getNetwork()).chainId
	const defaults = loadMigrationDefaults(chainId)
	const outputDir = path.resolve(process.env.OUTPUT_DIR || "scripts/output")
	const stateFile = path.join(outputDir, `instant-layer-migration-${chainId}.json`)
	const fromBlock = process.env.SNAPSHOT_FROM_BLOCK ? Number(process.env.SNAPSHOT_FROM_BLOCK) : undefined
	const explicitPartyBs = partyBsFromEnv()
	const recordedPartyB = readJson<{ addresses?: { symmioPartyB?: string } }>(path.resolve("tasks/data", chainId.toString(), "deployment-report.json"))
		?.addresses?.symmioPartyB
	const partyBCandidates = [...(explicitPartyBs || []), ...(recordedPartyB ? [recordedPartyB] : [])]
	const log = (message: string) => console.log(`  ${message}`)
	const snapshotOptions = { fromBlock, partyBCandidates, log }
	const networkFlag = `--network ${process.env.HARDHAT_NETWORK || "<network>"}`

	// ── Check mode: wiring, parity with the old layer, and the batch that is still pending ──
	const checkTarget = optionalAddress("CHECK_INSTANT_LAYER")
	if (checkTarget) {
		const oldSnapshot = await snapshotInstantLayer(ethers, defaults.oldInstantLayer, snapshotOptions)
		const partyBs = oldSnapshot.registeredPartyBs
		console.log(`InstantLayer check on chain ${chainId}: ${checkTarget} (old layer ${defaults.oldInstantLayer})`)
		const wiring = await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: checkTarget })
		printWiring(wiring)
		if (checkTarget.toLowerCase() === defaults.oldInstantLayer.toLowerCase()) return

		const replacement = await verifyInstantLayerReplacement(ethers, {
			oldSnapshot: withAdditionalTemplates(oldSnapshot, chainId, log),
			newInstantLayer: checkTarget,
			safe: defaults.safe,
			deployer: optionalAddress("DEPLOYER_ADDRESS"),
			gaslessLayer: defaults.gaslessLayer,
			fromBlock,
		})
		console.log(`  Replacement parity: ${replacement.ok ? "matches the old layer" : "DIFFERS"}`)
		for (const finding of replacement.findings) console.log(`    ✘ ${finding}`)

		const state = readJson<MigrationState>(stateFile) || {}
		if (!wiring.ok && state.newGaslessImplementation) {
			const actions = buildCutoverSafeActions({
				core: oldSnapshot.symmio,
				accountLayer: oldSnapshot.accountLayer,
				partyBs,
				gaslessLayer: defaults.gaslessLayer,
				newGaslessImplementation: state.newGaslessImplementation,
				newInstantLayer: checkTarget,
			})
			printSimulation("pending cutover batch", await simulateSafeActions(ethers, defaults.safe, actions))
		}
		if (wiring.ok) {
			const actions = buildDecommissionSafeActions({
				core: oldSnapshot.symmio,
				accountLayer: oldSnapshot.accountLayer,
				partyBs,
				oldInstantLayer: defaults.oldInstantLayer,
			})
			printSimulation("decommission batch (run it only after the transition window)", await simulateSafeActions(ethers, defaults.safe, actions))
		}
		if (wiring.ok && replacement.ok) printOffChainChecklist(checkTarget)
		if (!wiring.ok || !replacement.ok) process.exitCode = 1
		return
	}

	// ── Plan / execute ──
	const execute = requireExecutionConfirmation(chainId)
	const phase = phaseFromEnv()
	const state = readJson<MigrationState & { deployer?: string }>(stateFile) || {}
	const adminOnlyPhase = phase === "bind" || phase === "decommission"
	// Signer 0 is the deployer only in phases that deploy; in admin-only phases signer 0 may be the
	// admin itself (Ledger mode), so the deployer address comes from the state file instead.
	const [firstSigner] = await ethers.getSigners()
	const deployer = adminOnlyPhase ? undefined : firstSigner
	if (execute && !adminOnlyPhase && !deployer) throw new Error("No deployer signer is configured for this network")
	const deployerAddress = deployer
		? ethers.getAddress(await deployer.getAddress())
		: optionalAddress("DEPLOYER_ADDRESS") || (state.deployer ? ethers.getAddress(state.deployer) : ethers.ZeroAddress)
	const admin = await resolveAdminExecutor(defaults.safe, adminSignerMode(), chainId, outputDir)

	console.log("InstantLayer migration")
	console.log(`  Chain:            ${chainId}`)
	console.log(`  Mode:             ${execute ? `EXECUTE (phase: ${phase})` : "PLAN ONLY"}`)
	console.log(
		`  Deployer:         ${deployer ? deployerAddress : adminOnlyPhase ? `${deployerAddress} (from the state file)` : `${deployerAddress} (no signer configured; plan only)`}`,
	)
	console.log(`  Admin:            ${defaults.safe} (${admin.describe})`)
	console.log(`  Old InstantLayer: ${defaults.oldInstantLayer}`)
	console.log(`  GaslessLayer:     ${defaults.gaslessLayer}`)
	for (const name of GASLESS_LIBRARY_NAMES) console.log(`  ${name.padEnd(26)}${defaults.libraries[name]}`)
	if (state.newInstantLayer) console.log(`  Recorded new InstantLayer:            ${state.newInstantLayer}`)
	if (state.newGaslessImplementation) console.log(`  Recorded GaslessLayer implementation: ${state.newGaslessImplementation}`)

	const snapshot = await snapshotInstantLayer(ethers, defaults.oldInstantLayer, snapshotOptions)
	console.log(`\nSnapshot of ${snapshot.address}`)
	console.log(`  Core:                   ${snapshot.symmio}`)
	console.log(`  AccountLayer:           ${snapshot.accountLayer}`)
	console.log(`  Whitelisted targets:    ${snapshot.whitelistedTargets.join(", ")}`)
	console.log(`  Registered PartyBs:     ${snapshot.registeredPartyBs.join(", ") || "none found"}`)
	console.log(
		`  Templates:              ${snapshot.templates.map(t => `${t.id}:${t.name}${t.instantOpenMode ? " (instant-open)" : ""}${t.active ? "" : " (inactive)"}`).join(", ")}`,
	)
	console.log(`  Revocation cooldown:    ${snapshot.revocationCooldown}s`)
	console.log(`  Transient context:      ${snapshot.transientContextEnabled}`)
	for (const [name, members] of Object.entries(snapshot.roles)) console.log(`  ${name.padEnd(24)}${members.join(", ")}`)
	if (snapshot.registeredPartyBs.length === 0) {
		console.log("  No registered PartyB found. Pass PARTY_BS=0x..,0x.. (confirmed on chain) or ALLOW_NO_PARTY_BS=true if that is really intended.")
		if (process.env.ALLOW_NO_PARTY_BS !== "true") {
			process.exitCode = 1
			return
		}
	}
	const partyBs = snapshot.registeredPartyBs

	console.log("\nCurrent wiring")
	printWiring(await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: snapshot.address }))

	// ── Decommission phase: only the admin acts ──
	if (phase === "decommission") {
		const actions = buildDecommissionSafeActions({
			core: snapshot.symmio,
			accountLayer: snapshot.accountLayer,
			partyBs,
			oldInstantLayer: snapshot.address,
		})
		if (!state.newInstantLayer) throw new Error(`No recorded new InstantLayer in ${stateFile}; refusing to decommission the old layer`)
		const newWiring = await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: state.newInstantLayer })
		printWiring(newWiring)
		if (!newWiring.ok) throw new Error("The new InstantLayer is not fully bound; decommissioning the old one now would break the protocol")
		if (!printSimulation("decommission", await simulateSafeActions(ethers, defaults.safe, actions)))
			throw new Error("Decommission actions do not simulate")
		if (!execute)
			return console.log(`\nPlan complete. Rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId} PHASE=decommission and the admin key configured.`)
		if (!admin.execute) throw new Error("No way to sign as the admin in this process; set ADMIN_SIGNER or import the decommission batch file")
		const sent = await admin.execute(actions, log)
		console.log(`  Sent ${sent} transaction(s) as the admin`)
		const oldWiring = await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: snapshot.address })
		printWiring(oldWiring)
		if (oldWiring.bindings.some(b => b.ok)) process.exitCode = 1
		else console.log("\nOld InstantLayer fully decommissioned.")
		return
	}

	const expected = withAdditionalTemplates(snapshot, chainId, log)
	const additionalTemplates = expected.templates.slice(snapshot.templates.length)
	if (additionalTemplates.length > 0) {
		console.log("\nTemplates added on the new layer (after the replayed ones)")
		for (const t of additionalTemplates) {
			const ops = t.operations
				.map(o => (o.insertionPoints.length ? `{at ${o.insertionPoints.join(",")} from #${o.sourceIndices.join(",")}}` : "{}"))
				.join(" ")
			console.log(`  ${t.id}: ${t.name}${t.instantOpenMode ? " (instant-open)" : ""} ${ops}`)
		}
	}
	const plan = buildInstantLayerReplayPlan(expected, { deployer: deployerAddress, safe: defaults.safe })
	if (phase !== "bind") {
		console.log(`\nDeployer phase (${plan.length + 2} contract actions plus the handover)`)
		console.log("  1. deploy InstantLayer(core, deployer)")
		plan.forEach((action, index) => console.log(`  ${index + 2}. ${action.description}`))
		console.log(`  ${plan.length + 2}. deploy GaslessLayer implementation (linked to the existing libraries)`)
		console.log("  then: grant DEFAULT_ADMIN/SETTER/OPERATOR/REVOKER to the admin and renounce the deployer")
	}

	// The admin must be able to execute every binding action. The GaslessLayer upgrade needs the new
	// implementation to exist, so it is simulated after deployment; everything else is checked now.
	console.log("\nAdmin authority (simulated from the admin against current state)")
	const cutoverPreview = buildCutoverSafeActions({
		core: snapshot.symmio,
		accountLayer: snapshot.accountLayer,
		partyBs,
		gaslessLayer: defaults.gaslessLayer,
		newGaslessImplementation: PLACEHOLDER,
		newInstantLayer: PLACEHOLDER,
	}).filter(action => action.to.toLowerCase() !== defaults.gaslessLayer.toLowerCase())
	const decommissionPreview = buildDecommissionSafeActions({
		core: snapshot.symmio,
		accountLayer: snapshot.accountLayer,
		partyBs,
		oldInstantLayer: snapshot.address,
	})
	const authorityOk =
		printSimulation(
			"cutover (placeholder new layer, GaslessLayer upgrade deferred)",
			await simulateSafeActions(ethers, defaults.safe, cutoverPreview),
		) && printSimulation("decommission", await simulateSafeActions(ethers, defaults.safe, decommissionPreview))
	if (!authorityOk) {
		console.log("  The admin cannot execute every action; resolve this before deploying anything.")
		process.exitCode = 1
		if (execute) throw new Error("Admin authority check failed")
		return
	}

	if (!execute) {
		console.log(`\nPlan complete. Review it, then rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId}.`)
		if (!admin.isContract && !admin.execute)
			console.log("  Bind in the same run with ADMIN_SIGNER=cast-ledger (Ledger) or a configured admin key; otherwise run PHASE=bind afterwards.")
		return
	}

	// ── Deployer phase ──
	let newInstantLayer = state.newInstantLayer
	let newGaslessImplementation = state.newGaslessImplementation
	let cutoverActions: SafeAction[]
	let decommissionActions: SafeAction[]
	if (phase === "bind") {
		if (!newInstantLayer || !newGaslessImplementation) throw new Error(`PHASE=bind needs a completed deployer phase recorded in ${stateFile}`)
		cutoverActions = buildCutoverSafeActions({
			core: snapshot.symmio,
			accountLayer: snapshot.accountLayer,
			partyBs,
			gaslessLayer: defaults.gaslessLayer,
			newGaslessImplementation,
			newInstantLayer,
		})
		decommissionActions = decommissionPreview
	} else {
		const balance = await ethers.provider.getBalance(deployerAddress)
		console.log(`\nExecuting the deployer phase as ${deployerAddress} (balance ${ethers.formatEther(balance)} ETH)`)
		const result = await migrateInstantLayer({
			ethers,
			deployer,
			oldInstantLayer: defaults.oldInstantLayer,
			safe: defaults.safe,
			gaslessLayer: defaults.gaslessLayer,
			gaslessLibraries: defaults.libraries,
			state,
			fromBlock,
			partyBCandidates,
			allowNoPartyBs: process.env.ALLOW_NO_PARTY_BS === "true",
			additionalTemplates,
			log,
		})
		newInstantLayer = result.newInstantLayer
		newGaslessImplementation = result.newGaslessImplementation
		cutoverActions = result.cutoverActions
		decommissionActions = result.decommissionActions
		atomicWriteJson(stateFile, {
			...result.state,
			deployer: deployerAddress,
			chainId: chainId.toString(),
			oldInstantLayer: defaults.oldInstantLayer,
			updatedAt: new Date().toISOString(),
		})
		console.log(`  New InstantLayer:            ${newInstantLayer}`)
		console.log(`  GaslessLayer implementation: ${newGaslessImplementation}`)
		console.log(`  Transactions sent:           ${result.transactionsSent}`)
		console.log(`  State file:                  ${stateFile}`)
	}

	console.log("\nReplacement verification (new layer vs old snapshot)")
	const replacement = await verifyInstantLayerReplacement(ethers, {
		oldSnapshot: expected,
		newInstantLayer,
		safe: defaults.safe,
		deployer: deployerAddress !== ethers.ZeroAddress ? deployerAddress : undefined,
		gaslessLayer: defaults.gaslessLayer,
		fromBlock,
	})
	if (replacement.ok) console.log("  ✔ configuration, roles, and handover match the old layer")
	else {
		for (const finding of replacement.findings) console.log(`  ✘ ${finding}`)
		throw new Error("The new InstantLayer does not match the old one; not binding anything")
	}

	const cutoverFile = path.join(outputDir, `instant-layer-migration-${chainId}-cutover.safe.json`)
	const decommissionFile = path.join(outputDir, `instant-layer-migration-${chainId}-decommission-old.safe.json`)
	const librariesFile = path.join(outputDir, `instant-layer-migration-${chainId}.libraries.mjs`)
	atomicWriteJson(
		cutoverFile,
		buildSafeTransactionBuilderBatch({
			chainId,
			safe: defaults.safe,
			name: `InstantLayer cutover ${newInstantLayer}`,
			description: `Bind core, AccountLayer, PartyB, and GaslessLayer to InstantLayer ${newInstantLayer} (old ${defaults.oldInstantLayer} stays authorized)`,
			actions: cutoverActions,
		}),
	)
	atomicWriteJson(
		decommissionFile,
		buildSafeTransactionBuilderBatch({
			chainId,
			safe: defaults.safe,
			name: `InstantLayer decommission ${defaults.oldInstantLayer}`,
			description: `Revoke core, AccountLayer, and PartyB bindings of the old InstantLayer ${defaults.oldInstantLayer}. Run only after the transition window.`,
			actions: decommissionActions,
		}),
	)
	fs.writeFileSync(librariesFile, `export default ${JSON.stringify(defaults.libraries, null, 2)}\n`)

	console.log("\nBinding actions (simulated from the admin with the real addresses)")
	const cutoverOk = printSimulation("cutover", await simulateSafeActions(ethers, defaults.safe, cutoverActions))
	printSimulation("decommission (for later)", await simulateSafeActions(ethers, defaults.safe, decommissionActions))
	if (!cutoverOk) throw new Error("Cutover actions do not simulate from the admin; batch files were written for review")

	// ── Admin phase ──
	let bound = false
	const alreadyBound = (await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: newInstantLayer })).ok
	if (alreadyBound) {
		console.log("\nNew layer is already fully bound; nothing to execute as the admin.")
		bound = true
	} else if (phase === "deploy") {
		console.log("\nPHASE=deploy: binding skipped. Rerun with PHASE=bind and the admin key, or import the cutover batch.")
	} else if (admin.execute) {
		console.log(
			`\nExecuting the cutover as the admin ${defaults.safe} (${admin.describe}; balance ${ethers.formatEther(await ethers.provider.getBalance(defaults.safe))} ETH)`,
		)
		const sent = await admin.execute(cutoverActions, log)
		console.log(`  Sent ${sent} transaction(s) as the admin`)
		bound = true
	} else {
		console.log(`\nNo way to sign as the admin in this process (${admin.describe}); the cutover was NOT executed.`)
		console.log(`  Rerun with PHASE=bind and ADMIN_SIGNER=cast-ledger (or a configured admin key), or import ${cutoverFile}.`)
	}

	console.log(`\nWiring of the new layer${bound ? "" : " (expected: nothing bound until the cutover executes)"}`)
	const wiring = await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: newInstantLayer })
	printWiring(wiring)
	if (bound && !wiring.ok) throw new Error("Cutover executed but the new layer is not fully bound")

	console.log("\nVerify on the explorer:")
	console.log(
		`  npx hardhat verify ${networkFlag} --contract contracts/instantLayer/InstantLayer.sol:InstantLayer ${newInstantLayer} ${snapshot.symmio} ${deployerAddress}`,
	)
	console.log(
		`  npx hardhat verify ${networkFlag} --contract contracts/gaslessLayer/GaslessLayer.sol:GaslessLayer --libraries-path ${path.relative(process.cwd(), librariesFile)} ${newGaslessImplementation}`,
	)
	printActions(`Decommission batch (after the transition window) -> ${decommissionFile}`, decommissionActions)
	console.log(
		`  or: EXECUTE=true CONFIRM_CHAIN_ID=${chainId} PHASE=decommission ADMIN_SIGNER=cast-ledger npx hardhat run --no-compile scripts/migrateInstantLayer.ts ${networkFlag}`,
	)
	printOffChainChecklist(newInstantLayer)
	if (bound) console.log("\nMigration complete: the new InstantLayer is live and the old one stays usable until you decommission it.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
