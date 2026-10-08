import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import {
	CORE_UPGRADE_API,
	CUT_SELECTOR,
	assertCoreEvidence,
	digest,
	planCoreCut,
	validateCoreUpgradeConfig,
} from "../../deployment-tooling/arbitrum-core-upgrade.js"
import { assertCoreUpgradeSourceBinding } from "../../deployment-tooling/core-upgrade-binding.js"
import {
	isStandardCoreInput,
	coreUpgradeNetwork,
	coreUpgradeAuthority,
	coreGovernanceKind,
	coreUpgradePolicies,
	coreUpgradeRoleGrants,
	coreUpgradeLimits,
	coreUpgradeMuonPolicy,
} from "../../deployment-tooling/core-upgrade-input.js"
import { operationDigest } from "../../deployment-tooling/operations/inputs.js"
import { verifyMuonReadiness } from "../../deployment-tooling/operations/muon-readiness.js"
import { publishUpgradeItems, upgradeCompletionStatus } from "../../deployment-tooling/operations/upgrade-lifecycle.js"
import { FacetSpecs, LibrarySpecs, linkedLibrariesFor } from "../../utils/deploymentManifest.js"
import { atomicWriteFile } from "../utils/fs.js"
import { json, selectorsAt } from "./accountInstantSnapshot.js"
import { assertRoundingRuntime } from "./arbitrumRoundingUpgrade.js"
import {
	acquireCheckpointLock,
	assertCheckpointManifest,
	createCheckpoint,
	createDeploymentManifest,
	loadCheckpoint,
	saveCheckpoint,
	setCheckpointSimulated,
} from "./checkpoint.js"
import {
	prepareCoreGovernancePayload,
	rehearseCoreGovernancePayload,
	verifyCoreGovernanceReceipt,
	executeCoreGovernancePayload,
} from "./coreUpgradeGovernance.js"
import { captureCoreUpgradeSnapshot, assertCoreSnapshotPreserved, assertLiveCoreFunding, coreUpgradeABI } from "./coreUpgradeSnapshot.js"
import { persistSubmittedTransaction } from "./deploymentRecovery.js"
import { resolveVerificationContractName, verificationProviderForChain } from "./explorer.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	getDeploymentTransactionJournal,
	reconcileDeploymentTransactions,
	resetDeploymentTransactionJournal,
} from "./tx.js"

const PHASES = [
	"inspect",
	"rehearse-initial",
	"deploy",
	"publish",
	"plan-pause",
	"verify-pause",
	"plan-cut",
	"rehearse-cut",
	"check-export",
	"verify-cut",
	"verify-muon",
	"verify-service",
	"plan-unpause",
	"verify-unpause",
	"reconcile",
	"execute-governance",
]
const write = (file: string, value: any) => atomicWriteFile(file, JSON.stringify(json(value), null, 2) + "\n", 0o600)
const same = (a: any, b: any, message: string) => {
	if (digest(a) !== digest(b)) throw new Error(message)
}

export function assertCoreUpgradeExecution(
	phase: string,
	connection: any,
	chainId: number,
	env: Record<string, string | undefined> = process.env,
	config?: any,
) {
	const target = coreUpgradeNetwork(
			config || JSON.parse(fs.readFileSync(new URL("../config/arbitrum-core-upgrade-42161.json", import.meta.url), "utf8")),
		),
		simulated = connection.networkConfig?.type === "edr-simulated",
		forkPhase = phase.startsWith("rehearse-")
	if (chainId !== target.chainId || simulated !== forkPhase || connection.networkName !== (forkPhase ? target.fork : target.name))
		throw new Error("Incorrect network for Core upgrade phase")
	if (phase === "deploy" && (env.SYMMIO_CORE_UPGRADE_EXECUTE !== "true" || env.CONFIRM_CHAIN_ID !== String(target.chainId)))
		throw new Error("Live deployments require explicit chain authorization")
}

export function buildCoreUpgradeActions(ethers: any, input: any, snapshot: any, deployments: any) {
	if (!isStandardCoreInput(input.config) && !snapshot.pause[0]) throw new Error("A global pause is required before planning the Core cut")
	assertLiveCoreFunding(snapshot)
	const t = input.config.target,
		owner = coreUpgradeAuthority(input.config),
		policies = coreUpgradePolicies(input.config),
		iface = new ethers.Interface(coreUpgradeABI)
	const plan = planCoreCut(snapshot.selectors, snapshot.selectors, deployments.facets, policies.selectors.core.allowedRemovals)
	if (!plan.calldata) throw new Error("Core already contains this release; start with its verification evidence")
	const actions: any[] = [],
		add = (data: string, description: string) => actions.push({ to: t.core, value: "0", data, description })
	add(plan.calldata, `Atomically upgrade all Core facets (${plan.removed.length} removed selectors)`)
	if (isStandardCoreInput(input.config)) {
		for (const grant of snapshot.plannedRoles.filter((g: any) => !g.held)) {
			const holder = grant.holderRef ? `${grant.holderRef} (${grant.holder})` : grant.holder
			add(iface.encodeFunctionData("grantRole", [grant.holder, ethers.id(grant.role)]), `Grant ${grant.role} on Core (${t.core}) to ${holder}`)
		}
	} else if (!snapshot.roles.listing)
		add(
			iface.encodeFunctionData("grantRole", [t.symbolManager, ethers.id("SYMBOL_LISTING_ROLE")]),
			"Grant SYMBOL_LISTING_ROLE to the existing Symbol Manager",
		)
	const repairs = snapshot.funding
		.filter((g: any) => g.a !== g.expected || g.b !== g.expected)
		.map((g: any) => [g.partyA, g.partyB, g.symbolId, g.positionType, g.a, g.b, g.expected])
	if (repairs.length) {
		if (policies.funding.aggregate.repair !== true) throw new Error("funding.aggregate: required repairs are not authorized by the input")
		if (!snapshot.roles.migration)
			add(iface.encodeFunctionData("grantRole", [owner, ethers.id("MIGRATION_ROLE")]), "Temporarily grant MIGRATION_ROLE to the Core owner")
		add(iface.encodeFunctionData("resyncAggregateFunding", [repairs]), `Reconcile ${repairs.length} funding groups against their checked old values`)
		if (!snapshot.roles.migration)
			add(iface.encodeFunctionData("revokeRole", [owner, ethers.id("MIGRATION_ROLE")]), "Restore the Core owner's original MIGRATION_ROLE state")
	}
	return { actions, desired: plan.desired, removed: plan.removed, repairs }
}

export async function assertCoreDeployments(hre: any, ethers: any, deployments: any) {
	if (!deployments) throw new Error("Core deployment evidence is missing")
	const records: any[] = []
	for (const [kind, specs] of [
		["libraries", LibrarySpecs.core],
		["facets", FacetSpecs.core],
	] as const) {
		same(Object.keys(deployments[kind]).sort(), Object.keys(specs).sort(), `Core ${kind} do not match the complete current manifest`)
		for (const spec of Object.values(specs)) {
			const address = kind === "libraries" ? deployments.libraries[spec.name] : deployments.facets[spec.name].address
			const artifact = await hre.artifacts.readArtifact(spec.artifact)
			const libraries = linkedLibrariesFor("core", spec, deployments.libraries)
			await assertRoundingRuntime(ethers, artifact, address, libraries)
			if (kind === "facets") {
				const iface = new ethers.Interface(artifact.abi)
				const selectors = iface.fragments
					.filter((f: any) => f.type === "function" && f.format("sighash") !== "init(bytes)")
					.map((f: any) => iface.getFunction(f.format("sighash")).selector)
					.sort()
				same(selectors, [...deployments.facets[spec.name].selectors].sort(), `Artifact selector mismatch for ${spec.name}`)
			}
			records.push({
				name: spec.name,
				address,
				artifact: spec.artifact,
				libraries,
				codeHash: ethers.keccak256(await ethers.provider.getCode(address)),
			})
		}
	}
	return records
}

async function deployCore(hre: any, ethers: any, input: any, report: any, directory: string, simulated: boolean) {
	const scope = `core-upgrade-${digest(input).slice(0, 20)}${simulated ? `-${Date.now()}` : ""}`
	setCheckpointSimulated(simulated)
	const network = coreUpgradeNetwork(input.config)
	const lock = acquireCheckpointLock(network.chainId, scope)
	try {
		const checkpoint = loadCheckpoint(network.chainId, scope) || createCheckpoint(simulated ? network.fork : network.name, network.chainId, scope)
		const manifest = createDeploymentManifest({ input, simulated }, { deploymentId: checkpoint.deploymentId || checkpoint.manifest?.deploymentId })
		if (checkpoint.manifest) assertCheckpointManifest(checkpoint, manifest)
		checkpoint.manifest = manifest
		checkpoint.deploymentId = manifest.deploymentId
		const signer = (await ethers.getSigners())[0]
		const address = (await signer.getAddress()).toLowerCase()
		if (checkpoint.deployerAddress && checkpoint.deployerAddress !== address) throw new Error("Deployment signer changed")
		checkpoint.deployerAddress = address
		resetDeploymentTransactionJournal()
		try {
			await reconcileDeploymentTransactions(checkpoint.transactions || [], ethers.provider, address)
			if ((checkpoint.transactions || []).some((tx: any) => ["submitted", "unresolved", "timed_out"].includes(tx.status)))
				throw new Error("Reconcile uncertain deployments before retrying")
			bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint, record))
			const { deployFacets } = await import("./diamondUpgrade.js")
			report.deployments = await deployFacets(path.join(directory, simulated ? `${scope}-facets.json` : "facets.json"), "core", { checkpoint })
			await assertCoreDeployments(hre, ethers, report.deployments)
		} finally {
			report.transactions = [
				...new Map(
					[...(report.transactions || []), ...(checkpoint.transactions || []), ...getDeploymentTransactionJournal()].map(tx => [
						tx.hash.toLowerCase(),
						tx,
					]),
				).values(),
			]
			saveCheckpoint(checkpoint)
			clearDeploymentTransactionWriteAhead()
		}
	} finally {
		lock.release()
	}
}

function assertStaticBaseline(before: any, after: any, preserveAvailability = false) {
	if (!before.muon?.configuration || !after.muon?.configuration) throw new Error("Missing Muon configuration evidence")
	same(before.muon?.configuration, after.muon?.configuration, "Initial Muon configuration changed")
	for (const key of ["preserved", "wiring", "code", "selectors", "facetCode", "roles", "plannedRoles"])
		same(before[key] ?? [], after[key] ?? [], `Initial ${key} changed; refuse upgrade drift`)
	if (digest(preserveAvailability ? before.pause : before.pause.slice(1)) !== digest(preserveAvailability ? after.pause : after.pause.slice(1)))
		throw new Error("Unrelated pause flags changed")
}

/** Check configuration and governance progress; active trading may change economic state. */
export function assertCoreGovernanceProgress(ethers: any, before: any, after: any, batch: any, confirmed: number, config: any) {
	if (!Number.isInteger(confirmed) || confirmed < 0 || confirmed > batch.actions.length) throw new Error("Invalid governance progress")
	const expected = structuredClone(before),
		iface = new ethers.Interface(coreUpgradeABI)
	for (const action of batch.actions.slice(0, confirmed)) {
		if (action.data.slice(0, 10) === CUT_SELECTOR) {
			expected.selectors = batch.desired
			continue
		}
		const parsed = iface.parseTransaction({ data: action.data })
		if (parsed?.name === "grantRole" || parsed?.name === "revokeRole") {
			const [holder, role] = parsed.args,
				held = parsed.name === "grantRole"
			for (const grant of expected.plannedRoles || [])
				if (grant.holder.toLowerCase() === holder.toLowerCase() && ethers.id(grant.role) === role) grant.held = held
			if (holder.toLowerCase() === before.preserved.getOwner.toLowerCase() && role === ethers.id("MIGRATION_ROLE")) expected.roles.migration = held
			if (holder.toLowerCase() === config.target.symbolManager.toLowerCase() && role === ethers.id("SYMBOL_LISTING_ROLE"))
				expected.roles.listing = held
		} else if (parsed?.name === "resyncAggregateFunding") {
			for (const group of expected.funding) group.a = group.b = group.expected
			for (const group of expected.globals) group.stored = group.pairTotal = group.expected
		} else throw new Error("Unexpected action in Core governance progress")
	}
	const liveTrading = isStandardCoreInput(config) && !before.pause[0]
	for (const key of [
		"preserved",
		"wiring",
		"code",
		"pause",
		"roles",
		"plannedRoles",
		"selectors",
		...(!liveTrading ? ["economy", "funding", "globals"] : []),
	])
		same(expected[key] ?? [], after[key] ?? [], `Core governance progress changed ${key}`)
	if (
		liveTrading &&
		(after.funding.some((g: any) => g.a !== g.expected || g.b !== g.expected) || after.globals.some((g: any) => g.stored !== g.expected))
	)
		throw new Error("Core governance aggregate funding is inconsistent")
	if (!before.muon?.configuration || !after.muon?.configuration) throw new Error("Missing Muon configuration evidence")
	same(before.muon.configuration, after.muon.configuration, "Core governance changed Muon configuration")
}

export async function verifyCoreUpgradePostState(hre: any, ethers: any, input: any, report: any, atBlock?: number, unpaused = false) {
	await assertCoreDeployments(hre, ethers, report.deployments)
	const state = await captureCoreUpgradeSnapshot(ethers, input.config, true, atBlock)
	const standard = isStandardCoreInput(input.config)
	assertCoreSnapshotPreserved(standard ? report.cutSnapshot : report.paused, state, true, unpaused, standard)
	same(report.batch.desired, state.selectors, "Installed selector map does not equal the complete reviewed cut")
	return state
}

/** Bind routed Muon checks to the preserved configuration and the verified cut. */
function coreMuonBindings(input: any, report: any) {
	const snapshot = isStandardCoreInput(input.config) ? report.cutSnapshot : report.paused
	return {
		chainId: coreUpgradeNetwork(input.config).chainId,
		core: input.config.target.core,
		upgradeInputDigest: digest(input),
		cutDigest: digest(report.verifiedCut),
		releaseCommit: input.releaseCommit || input.sourceCommit,
		configurationDigest: operationDigest(snapshot.muon.configuration),
	}
}

async function checkCoreMuonReadiness(ethers: any, input: any, report: any, document: any) {
	const standard = isStandardCoreInput(input.config),
		snapshot = standard ? report.cutSnapshot : report.paused
	const state = await captureCoreUpgradeSnapshot(ethers, input.config, true, undefined, true)
	for (const key of ["preserved", "wiring", "code"]) same(snapshot[key], state[key], `Muon readiness ${key} changed`)
	if (standard) same(snapshot.pause, state.pause, "Muon readiness pause flags changed")
	same(report.batch.desired, state.selectors, "Muon readiness selector map changed")
	const t = input.config.target,
		core = new ethers.Interface(coreUpgradeABI)
	return verifyMuonReadiness(
		ethers.provider,
		{
			profile: {
				schemaVersion: 1,
				kind: "symmio.muon-upgrade-profile",
				chainId: Number((await ethers.provider.getNetwork()).chainId),
				core: { address: t.core, codeHash: state.code.core },
				verifier: { address: t.signatureVerifier, codeHash: state.code.signatureVerifier },
				policy: coreUpgradeMuonPolicy(input.config),
			},
			snapshot: snapshot.muon,
			checkpoint: { blockNumber: state.blockNumber, blockHash: state.blockHash },
			bindings: coreMuonBindings(input, report),
			entrypoints: ["instantLayer", "gaslessLayer", "accountLayer", "partyB"].map(id => ({ id, address: t[id], codeHash: state.code[id] })),
			restoreCall:
				!standard && state.pause[0]
					? { from: coreUpgradeAuthority(input.config), to: t.core, value: "0x0", data: core.encodeFunctionData("unpauseGlobal") }
					: null,
		},
		document,
	)
}

async function assertMuonRestoreReady(ethers: any, input: any, report: any, bindings: any) {
	if (!bindings.muonReadiness || !report.muonReadiness?.document)
		throw new Error("Verify Muon service and routed canaries before completing the upgrade")
	assertCoreEvidence(report, "muonReadiness", bindings.muonReadiness)
	await checkCoreMuonReadiness(ethers, input, report, report.muonReadiness.document)
}

export async function rehearseInitialCoreUpgrade(hre: any, ethers: any, input: any, report: any, directory: string) {
	const initial = report.initial,
		standard = isStandardCoreInput(input.config),
		snapshotField = standard ? "cutSnapshot" : "paused",
		metadata = await ethers.provider.send("hardhat_metadata", [])
	if (Number(metadata.forkedNetwork?.forkBlockNumber) !== initial.blockNumber) throw new Error("Initial rehearsal fork mismatch")
	if ((await ethers.provider.getBlock(initial.blockNumber))?.hash !== initial.blockHash) throw new Error("Initial rehearsal block hash mismatch")
	const local: any = { transactions: [] }
	const [signer] = await ethers.getSigners()
	await ethers.provider.send("hardhat_setBalance", [await signer.getAddress(), "0x3635c9adc5dea00000"])
	await deployCore(hre, ethers, input, local, directory, true)
	const core = await ethers.getContractAt(coreUpgradeABI, input.config.target.core)
	if (!standard && !initial.pause[0]) {
		const actions = [
			{ to: input.config.target.core, value: "0", data: core.interface.encodeFunctionData("pauseGlobal"), description: "Maintenance pause" },
		]
		await rehearseCoreGovernancePayload(ethers, input.config, await prepareCoreGovernancePayload(ethers, input.config, actions), initial.blockNumber)
	}
	local[snapshotField] = await captureCoreUpgradeSnapshot(ethers, input.config)
	assertStaticBaseline(initial, local[snapshotField], standard)
	local.batch = { ...buildCoreUpgradeActions(ethers, input, local[snapshotField], local.deployments) }
	local.batch.envelope = await prepareCoreGovernancePayload(ethers, input.config, local.batch.actions)
	const execution = await rehearseCoreGovernancePayload(ethers, input.config, local.batch.envelope, initial.blockNumber)
	await verifyCoreUpgradePostState(hre, ethers, input, local)
	if (!standard && !initial.pause[0]) {
		const actions = [
			{
				to: input.config.target.core,
				value: "0",
				data: core.interface.encodeFunctionData("unpauseGlobal"),
				description: "Restore global pause flag",
			},
		]
		await rehearseCoreGovernancePayload(ethers, input.config, await prepareCoreGovernancePayload(ethers, input.config, actions), initial.blockNumber)
		await verifyCoreUpgradePostState(hre, ethers, input, local, undefined, true)
	}
	return {
		inputDigest: digest(input),
		initialDigest: digest(initial),
		status: "complete",
		execution,
		selectorCount: Object.keys(local.batch.desired).length,
		repairs: local.batch.repairs,
	}
}

export async function runCoreUpgradePhase(hre: any, phase: string, inputFile: string, output: string) {
	if (!PHASES.includes(phase)) throw new Error("Unknown Core upgrade phase")
	const input = JSON.parse(fs.readFileSync(inputFile, "utf8")),
		inputDigest = digest(input)
	validateCoreUpgradeConfig(input.config)
	const standard = isStandardCoreInput(input.config),
		snapshotField = standard ? "cutSnapshot" : "paused"
	if (standard && /^(plan|verify)-(un)?pause$/.test(phase))
		throw new Error("Standard Core upgrades preserve pause flags and have no pause governance")
	assertCoreUpgradeSourceBinding(process.cwd(), input)
	if (
		input.apiVersion !== (isStandardCoreInput(input.config) ? "operations.symm.io/core-upgrade-run-v1" : CORE_UPGRADE_API) ||
		process.env.SYMMIO_CORE_UPGRADE_INPUT !== inputDigest
	)
		throw new Error("Use the registered Core upgrade task")
	if (
		execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== input.sourceCommit ||
		execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()
	)
		throw new Error("Core upgrade source changed or has tracked edits")
	const connection = await getConnection(hre),
		{ ethers } = connection
	const forkPhase = phase.startsWith("rehearse-")
	assertCoreUpgradeExecution(phase, connection, Number((await ethers.provider.getNetwork()).chainId), process.env, input.config)
	const report = JSON.parse(fs.readFileSync(output, "utf8")),
		directory = path.dirname(output)
	if (report.inputDigest !== inputDigest) throw new Error("Core report/input binding changed")
	const bindings = JSON.parse(process.env.SYMMIO_CORE_UPGRADE_EVIDENCE || "{}")
	for (const [field, hash] of Object.entries(bindings)) assertCoreEvidence(report, field, hash as string)
	if (phase !== "inspect" && !bindings.initial) throw new Error("Missing bound initial snapshot")
	const t = input.config.target,
		owner = coreUpgradeAuthority(input.config),
		core = await ethers.getContractAt(coreUpgradeABI, t.core)
	const persist = () => {
		const governanceTransactions = Object.values(report.governanceExecutions || {}).flatMap((journal: any) => journal.transactions || [])
		report.transactions = [...new Map([...(report.transactions || []), ...governanceTransactions].map(tx => [tx.hash, tx])).values()]
		write(output, report)
	}
	const eventFd = process.env.SYMMIO_TASK_EVENT_FD
	if (forkPhase) delete process.env.SYMMIO_TASK_EVENT_FD
	try {
		if (phase === "inspect") {
			if (report.initial)
				same(
					report.initial,
					await captureCoreUpgradeSnapshot(ethers, input.config, false, report.initial.blockNumber),
					"Saved initial snapshot does not match its historical block",
				)
			else report.initial = await captureCoreUpgradeSnapshot(ethers, input.config)
			write(path.join(directory, "core-abi.json"), coreUpgradeABI)
			report.client = {
				abiDigest: digest(coreUpgradeABI),
				removedSelectors: coreUpgradePolicies(input.config).selectors.core.allowedRemovals,
				policies: coreUpgradePolicies(input.config),
				limits: coreUpgradeLimits(input.config),
				roleGrants: { core: { address: input.config.target.core, grants: coreUpgradeRoleGrants(input.config) } },
				changes: [
					"getSymbolAdjustment(uint256) now returns 17 fields instead of 15",
					"startRestatement(uint256,uint256) requires the liquidation nonce",
					"Separate pause/unpause PartyB open-position methods and roles",
					"Symbol Manager needs SYMBOL_LISTING_ROLE; review registrar, metadata and limits operators before cutover",
				],
			}
			return
		}
		if (phase === "reconcile") {
			report.transactions = [
				...new Map(
					[...(report.transactions || []), ...JSON.parse(process.env.SYMMIO_CORE_UPGRADE_TRANSACTIONS || "[]")].map(tx => [tx.hash, tx]),
				).values(),
			]
			await reconcileDeploymentTransactions(report.transactions, ethers.provider)
			for (const journal of Object.values(report.governanceExecutions || {}) as any[])
				for (const tx of journal.transactions || [])
					Object.assign(
						tx,
						report.transactions.find((record: any) => record.hash === tx.hash),
					)
			return
		}
		if (phase === "rehearse-initial") {
			report.initialRehearsal = await rehearseInitialCoreUpgrade(hre, ethers, input, report, directory)
			return
		}
		if (phase === "deploy") {
			assertStaticBaseline(report.initial, await captureCoreUpgradeSnapshot(ethers, input.config, false, undefined, true), standard)
			await deployCore(hre, ethers, input, report, directory, false)
			return
		}
		if (!bindings.deployments) throw new Error("Missing bound deployment evidence")
		const records = await assertCoreDeployments(hre, ethers, report.deployments)
		if (phase === "publish") {
			const serviceField = standard ? "verifiedService" : "restoredService"
			if (!bindings.verifiedCut || !bindings[serviceField] || report[serviceField].cutDigest !== bindings.verifiedCut)
				throw new Error("Verify execution and service restoration before explorer publication")
			report.status = "publication-pending"
			report.publicationProgress ||= {}
			await publishUpgradeItems(
				records.map(record => ({ ...record, id: record.name })),
				report.publicationProgress,
				persist,
				async record => {
					try {
						await verifyContract(
							{
								address: record.address,
								constructorArgs: [],
								contract: await resolveVerificationContractName(hre.artifacts, record.artifact),
								libraries: record.libraries,
								provider: verificationProviderForChain(coreUpgradeNetwork(input.config).chainId),
							},
							hre,
						)
					} catch (error) {
						if (!(error instanceof Error && /already verified/i.test(error.message))) throw error
					}
				},
			)
			report.publication = { records, deploymentDigest: bindings.deployments }
			report.status = upgradeCompletionStatus({ executionVerified: true, serviceRestored: true, publicationVerified: true })
			return
		}
		if (phase === "execute-governance") {
			if (
				coreGovernanceKind(input.config) !== "eoa" ||
				process.env.SYMMIO_CORE_UPGRADE_EXECUTE !== "true" ||
				process.env.CONFIRM_CHAIN_ID !== String(coreUpgradeNetwork(input.config).chainId)
			)
				throw new Error("Direct governance requires explicit execution and chain authorization")
			const key = process.env.SYMMIO_CORE_UPGRADE_BATCH
			if (standard && key !== "cut") throw new Error("Standard Core upgrades have only cut governance")
			if (!["pause", "cut", "unpause"].includes(key || "")) throw new Error("Unknown governance phase")
			const field = key === "cut" ? "batch" : `${key}Batch`
			if (!bindings[field] || (key === "unpause" && !bindings.verifiedCut)) throw new Error("Missing reviewed governance evidence")
			if (
				key === "cut" &&
				(!bindings[snapshotField] ||
					report.batch[standard ? "snapshotDigest" : "pausedDigest"] !== bindings[snapshotField] ||
					report.batch.deploymentDigest !== bindings.deployments)
			)
				throw new Error("Governance payload must match the bound deployments and Core cut snapshot")
			report.governanceExecutions ||= {}
			const journal = (report.governanceExecutions[key!] ||= {})
			if (key === "unpause" && !journal.transactions?.length) await assertMuonRestoreReady(ethers, input, report, bindings)
			if (!standard && key === "cut" && !(await core.pauseState())[0]) throw new Error("Core must stay paused throughout direct governance")
			journal.receipts = await executeCoreGovernancePayload(ethers, input.config, report[field].envelope, journal, persist, async confirmed => {
				if (key === "pause") {
					const current = await captureCoreUpgradeSnapshot(ethers, input.config, false, undefined, true)
					assertStaticBaseline(report.initial, current)
					if (confirmed && !current.pause[0]) throw new Error("Executed maintenance pause is no longer active")
				} else if (key === "cut") {
					const current = await captureCoreUpgradeSnapshot(ethers, input.config, confirmed > 0)
					assertCoreGovernanceProgress(ethers, report[snapshotField], current, report.batch, confirmed, input.config)
				} else if (!confirmed) await verifyCoreUpgradePostState(hre, ethers, input, report)
			})
			return
		}
		const exportKey = process.env.SYMMIO_CORE_UPGRADE_BATCH || "cut"
		if (standard && exportKey !== "cut") throw new Error("Standard Core upgrades have only cut governance")
		if (phase === "check-export" && exportKey !== "cut") {
			if (!["pause", "unpause"].includes(exportKey) || !bindings[`${exportKey}Batch`]) throw new Error("Missing bound Safe export")
			if (exportKey === "pause") assertStaticBaseline(report.initial, await captureCoreUpgradeSnapshot(ethers, input.config, false, undefined, true))
			else {
				if (!bindings.verifiedCut) throw new Error("Verify the cut before unpausing")
				await verifyCoreUpgradePostState(hre, ethers, input, report)
				await assertMuonRestoreReady(ethers, input, report, bindings)
			}
			const batch = report[`${exportKey}Batch`]
			same(batch.envelope, await prepareCoreGovernancePayload(ethers, input.config, batch.actions), "Safe nonce or payload changed before export")
			return
		}
		const makeBatch = async (method: string) => {
			const actions = [
				{
					to: t.core,
					value: "0",
					data: core.interface.encodeFunctionData(method),
					description: method === "pauseGlobal" ? "Pause Core for the upgrade" : "Restore the original global pause flag after verification",
				},
			]
			return {
				actions,
				envelope: await prepareCoreGovernancePayload(ethers, input.config, actions),
				blockNumber: Number(await ethers.provider.getBlockNumber()),
			}
		}
		if (phase === "plan-pause") {
			const current = await captureCoreUpgradeSnapshot(ethers, input.config, false, undefined, true)
			assertStaticBaseline(report.initial, current)
			if (!report.pauseBatch) report.pauseBatch = report.initial.pause[0] ? { alreadyPaused: true } : await makeBatch("pauseGlobal")
			return
		}
		const receiptHash = process.env.SYMMIO_CORE_UPGRADE_RECEIPT || ""
		if (phase === "verify-pause") {
			if (!bindings.pauseBatch) throw new Error("Missing bound pause plan")
			if (!report.pauseBatch.alreadyPaused)
				report.pauseReceipt = await verifyCoreGovernanceReceipt(
					ethers,
					input.config,
					report.pauseBatch.envelope,
					receiptHash,
					report.pauseBatch.blockNumber,
				)
			const current = await captureCoreUpgradeSnapshot(ethers, input.config)
			if (!current.pause[0]) throw new Error("Core must remain globally paused")
			assertStaticBaseline(report.initial, current)
			if (report.paused) assertCoreSnapshotPreserved(report.paused, current)
			else report.paused = current
			return
		}
		if (standard && phase === "plan-cut" && !report.cutSnapshot) {
			const current = await captureCoreUpgradeSnapshot(ethers, input.config)
			assertStaticBaseline(report.initial, current, true)
			report.cutSnapshot = current
		}
		if (!report[snapshotField] || (!bindings[snapshotField] && phase !== "plan-cut")) throw new Error("A fresh bound Core cut snapshot is required")
		if (phase === "plan-cut" || phase === "check-export") {
			const current = await captureCoreUpgradeSnapshot(ethers, input.config)
			assertCoreSnapshotPreserved(report[snapshotField], current, false, false, standard)
			const batch = buildCoreUpgradeActions(ethers, input, standard ? current : report.paused, report.deployments)
			if (!report.batch)
				report.batch = {
					...batch,
					envelope: await prepareCoreGovernancePayload(ethers, input.config, batch.actions),
					[standard ? "snapshotDigest" : "pausedDigest"]: standard ? digest(report.cutSnapshot) : bindings.paused,
					deploymentDigest: bindings.deployments,
				}
			else same(batch.actions, report.batch.actions, "Saved Core actions changed")
			if (phase === "check-export")
				same(
					report.batch.envelope,
					await prepareCoreGovernancePayload(ethers, input.config, report.batch.actions),
					"Safe nonce or payload changed before export",
				)
			return
		}
		if (
			!bindings.batch ||
			report.batch[standard ? "snapshotDigest" : "pausedDigest"] !== bindings[snapshotField] ||
			report.batch.deploymentDigest !== bindings.deployments
		)
			throw new Error("Missing bound atomic Core batch")
		if (phase === "rehearse-cut") {
			if ((await ethers.provider.getBlock(report[snapshotField].blockNumber))?.hash !== report[snapshotField].blockHash)
				throw new Error("Core cut rehearsal block hash mismatch")
			assertCoreSnapshotPreserved(report[snapshotField], await captureCoreUpgradeSnapshot(ethers, input.config), false, false, standard)
			const execution = await rehearseCoreGovernancePayload(ethers, input.config, report.batch.envelope, report[snapshotField].blockNumber)
			await verifyCoreUpgradePostState(hre, ethers, input, report)
			report.cutRehearsal = { status: "complete", batchDigest: bindings.batch, execution, blockNumber: report[snapshotField].blockNumber }
			return
		}
		if (phase === "verify-cut") {
			report.cutReceipt = await verifyCoreGovernanceReceipt(
				ethers,
				input.config,
				report.batch.envelope,
				receiptHash,
				report[snapshotField].blockNumber,
			)
			await verifyCoreUpgradePostState(hre, ethers, input, report, report.cutReceipt.blockNumber)
			await verifyCoreUpgradePostState(hre, ethers, input, report)
			report.verifiedCut = { receipt: report.cutReceipt, batchDigest: bindings.batch }
			const muonBindings = coreMuonBindings(input, report)
			write(path.join(directory, "muon-readiness-request.json"), {
				schemaVersion: 1,
				kind: "symmio.muon-readiness",
				bindings: muonBindings,
				service: {
					chainId: muonBindings.chainId,
					core: t.core,
					appId: report[snapshotField].muon.configuration.appId,
					releaseCommit: muonBindings.releaseCommit,
					configurationDigest: "<hash of reviewed service configuration>",
					methods: [],
					observedAt: 0,
					registered: false,
				},
				canaries: ["instantLayer", "gaslessLayer", "accountLayer", "partyB"].map(route => ({
					route,
					function: "Trading",
					method: "<supported Muon method>",
					signedTimestamp: 0,
					valid: { from: "<authorized caller>", to: t[route], value: "0x0", data: "<fresh signed operation>" },
					invalid: {
						from: "<same caller>",
						to: t[route],
						value: "0x0",
						data: "<same operation with invalid Muon data and valid outer authorization>",
					},
					expectedReturnData: "<expected successful return data>",
				})),
			})
			return
		}
		if (!bindings.verifiedCut) throw new Error("Verify the executed Core cut before restoring service")
		if (phase === "verify-muon") {
			const file = process.env.SYMMIO_MUON_READY_INPUT
			if (!file) throw new Error("Provide a Muon readiness JSON with fresh positive and negative routed probes")
			const document = JSON.parse(fs.readFileSync(file, "utf8"))
			const evidence = await checkCoreMuonReadiness(ethers, input, report, document)
			if (report.muonReadiness) (report.muonReadinessHistory ||= []).push(report.muonReadiness)
			report.muonReadiness = { document, evidence }
			return
		}
		if (phase === "verify-service") {
			if (!standard) throw new Error("The legacy Core workflow requires its separate restoration phase")
			await verifyCoreUpgradePostState(hre, ethers, input, report)
			await assertMuonRestoreReady(ethers, input, report, bindings)
			same(Array.from(await core.pauseState()), report.initial.pause, "Final pause flags differ from their original values")
			report.verifiedService = { cutDigest: bindings.verifiedCut, pause: report.initial.pause, governance: "cut-only" }
			report.status = upgradeCompletionStatus({ executionVerified: true, serviceRestored: true, publicationVerified: false })
			return
		}
		if (phase === "plan-unpause") {
			await verifyCoreUpgradePostState(hre, ethers, input, report)
			await assertMuonRestoreReady(ethers, input, report, bindings)
			if (!report.unpauseBatch) report.unpauseBatch = report.initial.pause[0] ? { alreadyPaused: true } : await makeBatch("unpauseGlobal")
			return
		}
		if (phase === "verify-unpause") {
			if (!bindings.unpauseBatch) throw new Error("Missing bound unpause plan")
			if (!report.unpauseBatch.alreadyPaused) {
				report.unpauseReceipt = await verifyCoreGovernanceReceipt(
					ethers,
					input.config,
					report.unpauseBatch.envelope,
					receiptHash,
					report.unpauseBatch.blockNumber,
				)
				// The cut was verified while paused. Transactions later in the unpause
				// block may legitimately trade; do not freeze their economic state.
				await verifyCoreUpgradePostState(hre, ethers, input, report, report.verifiedCut.receipt.blockNumber)
				const current = await captureCoreUpgradeSnapshot(ethers, input.config, true, undefined, true)
				for (const key of ["preserved", "wiring", "code"]) same(report.paused[key], current[key], `Post-unpause ${key} changed`)
				same(report.paused.muon.configuration, current.muon.configuration, "Post-unpause Muon configuration changed")
				if (!current.roles.listing || current.roles.migration !== report.paused.roles.migration || current.plannedRoles.some((g: any) => !g.held))
					throw new Error("Post-unpause role mismatch")
			} else await verifyCoreUpgradePostState(hre, ethers, input, report)
			same(report.batch.desired, await selectorsAt(ethers, t.core), "Selectors changed after upgrade")
			same(Array.from(await core.pauseState()), report.initial.pause, "Final pause flags differ from their original values")
			report.restoredService = { cutDigest: bindings.verifiedCut, pause: report.initial.pause, receipt: report.unpauseReceipt || null }
			report.status = upgradeCompletionStatus({ executionVerified: true, serviceRestored: true, publicationVerified: false })
			return
		}
	} finally {
		persist()
		if (eventFd !== undefined) process.env.SYMMIO_TASK_EVENT_FD = eventFd
	}
}

const coreUpgradeAdapter = (name: string) =>
	task(name, "Internal adapter for the input-bound Core upgrade workflow")
		.addOption({ name: "phase", description: "Workflow phase", type: ArgumentType.STRING, defaultValue: "inspect" })
		.addOption({ name: "input", description: "Bound upgrade input", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
		.addOption({ name: "output", description: "Upgrade report", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
		.setAction(async () => ({
			default: async ({ phase, input, output }, hre) => {
				if (!input || !output) throw new Error("Input and output are required")
				logger.info(`Core upgrade: ${phase}`)
				await runCoreUpgradePhase(hre, phase, path.resolve(input), path.resolve(output))
			},
		}))
		.build()

export const arbitrumCoreUpgradeTask = coreUpgradeAdapter("internal:arbitrum-core-upgrade")
export const coreUpgradeTask = coreUpgradeAdapter("internal:core-upgrade")
