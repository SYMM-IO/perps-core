import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import {
	CORE_UPGRADE_API,
	assertCoreEvidence,
	digest,
	planCoreCut,
	validateCoreUpgradeConfig,
} from "../../deployment-tooling/arbitrum-core-upgrade.js"
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
import { prepareCoreSafePayload, rehearseCoreSafePayload, verifyCoreSafeReceipt } from "./coreUpgradeSafe.js"
import { captureCoreUpgradeSnapshot, assertCoreSnapshotPreserved, coreUpgradeABI } from "./coreUpgradeSnapshot.js"
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
	"plan-unpause",
	"verify-unpause",
	"reconcile",
]
const write = (file: string, value: any) => atomicWriteFile(file, JSON.stringify(json(value), null, 2) + "\n", 0o600)
const same = (a: any, b: any, message: string) => {
	if (digest(a) !== digest(b)) throw new Error(message)
}

export function assertCoreUpgradeExecution(phase: string, connection: any, chainId: number, env: Record<string, string | undefined> = process.env) {
	const simulated = connection.networkConfig?.type === "edr-simulated",
		forkPhase = phase.startsWith("rehearse-")
	if (chainId !== 42161 || simulated !== forkPhase || connection.networkName !== (forkPhase ? "fork-arbitrum" : "arbitrum"))
		throw new Error("Incorrect network for Core upgrade phase")
	if (phase === "deploy" && (env.SYMMIO_CORE_UPGRADE_EXECUTE !== "true" || env.CONFIRM_CHAIN_ID !== "42161"))
		throw new Error("Live deployments require explicit Arbitrum authorization")
}

export function buildCoreUpgradeActions(ethers: any, input: any, snapshot: any, deployments: any) {
	if (!snapshot.pause[0]) throw new Error("A global pause is required before planning the Core cut")
	const t = input.config.target,
		iface = new ethers.Interface(coreUpgradeABI)
	const plan = planCoreCut(snapshot.selectors, snapshot.selectors, deployments.facets, input.config.allowedRemovedSelectors)
	if (!plan.calldata) throw new Error("Core already contains this release; start with its verification evidence")
	const actions: any[] = [],
		add = (data: string, description: string) => actions.push({ to: t.core, value: "0", data, description })
	add(plan.calldata, `Atomically upgrade all Core facets (${plan.removed.length} removed selectors)`)
	if (input.config.pledgeTokens.length) {
		if (!snapshot.roles.pledgeTokenManager)
			add(
				iface.encodeFunctionData("grantRole", [t.safe, ethers.id("PLEDGE_TOKEN_MANAGER_ROLE")]),
				"Temporarily authorize the Safe to seed the reviewed pledge whitelist",
			)
		for (const token of input.config.pledgeTokens)
			add(iface.encodeFunctionData("setPledgeTokenWhitelist", [token, true]), `Enable manager-reviewed pledge token ${token}`)
		if (!snapshot.roles.pledgeTokenManager)
			add(
				iface.encodeFunctionData("revokeRole", [t.safe, ethers.id("PLEDGE_TOKEN_MANAGER_ROLE")]),
				"Restore the Safe's previous pledge-token-manager authority",
			)
	}
	if (!snapshot.roles.listing)
		add(
			iface.encodeFunctionData("grantRole", [t.symbolManager, ethers.id("SYMBOL_LISTING_ROLE")]),
			"Grant SYMBOL_LISTING_ROLE to the existing Symbol Manager",
		)
	const repairs = snapshot.funding
		.filter((g: any) => g.a !== g.expected || g.b !== g.expected)
		.map((g: any) => [g.partyA, g.partyB, g.symbolId, g.positionType, g.a, g.b, g.expected])
	if (repairs.length) {
		if (!snapshot.roles.migration)
			add(iface.encodeFunctionData("grantRole", [t.safe, ethers.id("MIGRATION_ROLE")]), "Temporarily grant MIGRATION_ROLE to the Dev Safe")
		add(iface.encodeFunctionData("resyncAggregateFunding", [repairs]), `Reconcile ${repairs.length} funding groups against their checked old values`)
		if (!snapshot.roles.migration)
			add(
				iface.encodeFunctionData("revokeRole", [t.safe, ethers.id("MIGRATION_ROLE")]),
				"Revoke the temporary MIGRATION_ROLE in the same Safe transaction",
			)
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
	const lock = acquireCheckpointLock(42161, scope)
	try {
		const checkpoint = loadCheckpoint(42161, scope) || createCheckpoint(simulated ? "fork-arbitrum" : "arbitrum", 42161, scope)
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

function assertStaticBaseline(before: any, after: any) {
	for (const key of ["preserved", "wiring", "code", "selectors", "facetCode", "roles"])
		same(before[key], after[key], `Initial ${key} changed; refuse upgrade drift`)
	if (digest(before.pause.slice(1)) !== digest(after.pause.slice(1))) throw new Error("Unrelated pause flags changed")
}

export async function verifyCoreUpgradePostState(hre: any, ethers: any, input: any, report: any, atBlock?: number, unpaused = false) {
	await assertCoreDeployments(hre, ethers, report.deployments)
	const state = await captureCoreUpgradeSnapshot(ethers, input.config, true, atBlock)
	assertCoreSnapshotPreserved(report.paused, state, true, unpaused)
	same(report.batch.desired, state.selectors, "Installed selector map does not equal the complete reviewed cut")
	return state
}

export async function rehearseInitialCoreUpgrade(hre: any, ethers: any, input: any, report: any, directory: string) {
	const initial = report.initial,
		metadata = await ethers.provider.send("hardhat_metadata", [])
	if (Number(metadata.forkedNetwork?.forkBlockNumber) !== initial.blockNumber) throw new Error("Initial rehearsal fork mismatch")
	const local: any = { transactions: [] }
	const [signer] = await ethers.getSigners()
	await ethers.provider.send("hardhat_setBalance", [await signer.getAddress(), "0x3635c9adc5dea00000"])
	await deployCore(hre, ethers, input, local, directory, true)
	const core = await ethers.getContractAt(coreUpgradeABI, input.config.target.core)
	if (!initial.pause[0]) {
		const actions = [
			{ to: input.config.target.core, value: "0", data: core.interface.encodeFunctionData("pauseGlobal"), description: "Maintenance pause" },
		]
		await rehearseCoreSafePayload(
			ethers,
			input.config.target.safe,
			await prepareCoreSafePayload(ethers, input.config.target.safe, actions),
			initial.blockNumber,
		)
	}
	local.paused = await captureCoreUpgradeSnapshot(ethers, input.config)
	assertStaticBaseline(initial, local.paused)
	local.batch = { ...buildCoreUpgradeActions(ethers, input, local.paused, local.deployments) }
	local.batch.envelope = await prepareCoreSafePayload(ethers, input.config.target.safe, local.batch.actions)
	const execution = await rehearseCoreSafePayload(ethers, input.config.target.safe, local.batch.envelope, initial.blockNumber)
	await verifyCoreUpgradePostState(hre, ethers, input, local)
	if (!initial.pause[0]) {
		const actions = [
			{
				to: input.config.target.core,
				value: "0",
				data: core.interface.encodeFunctionData("unpauseGlobal"),
				description: "Restore global pause flag",
			},
		]
		await rehearseCoreSafePayload(
			ethers,
			input.config.target.safe,
			await prepareCoreSafePayload(ethers, input.config.target.safe, actions),
			initial.blockNumber,
		)
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
	if (input.apiVersion !== CORE_UPGRADE_API || process.env.SYMMIO_CORE_UPGRADE_INPUT !== inputDigest)
		throw new Error("Use the registered Core upgrade task")
	if (
		execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== input.sourceCommit ||
		execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()
	)
		throw new Error("Core upgrade source changed or has tracked edits")
	const connection = await getConnection(hre),
		{ ethers } = connection
	const forkPhase = phase.startsWith("rehearse-")
	assertCoreUpgradeExecution(phase, connection, Number((await ethers.provider.getNetwork()).chainId))
	const report = JSON.parse(fs.readFileSync(output, "utf8")),
		directory = path.dirname(output)
	if (report.inputDigest !== inputDigest) throw new Error("Core report/input binding changed")
	const bindings = JSON.parse(process.env.SYMMIO_CORE_UPGRADE_EVIDENCE || "{}")
	for (const [field, hash] of Object.entries(bindings)) assertCoreEvidence(report, field, hash as string)
	if (phase !== "inspect" && !bindings.initial) throw new Error("Missing bound initial snapshot")
	const t = input.config.target,
		core = await ethers.getContractAt(coreUpgradeABI, t.core)
	const persist = () => write(output, report)
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
				removedSelectors: input.config.allowedRemovedSelectors,
				changes: [
					"getSymbolAdjustment(uint256) now returns 17 fields instead of 15",
					"startRestatement(uint256,uint256) requires the liquidation nonce",
					"Separate pause/unpause PartyB open-position methods and roles",
					"Symbol Manager needs SYMBOL_LISTING_ROLE; review registrar, metadata and limits operators before cutover",
					"Pledge deposits require an explicit manager-reviewed token whitelist; no token, including trading collateral, is automatically approved",
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
			return
		}
		if (phase === "rehearse-initial") {
			report.initialRehearsal = await rehearseInitialCoreUpgrade(hre, ethers, input, report, directory)
			return
		}
		if (!bindings.initialRehearsal || report.initialRehearsal.status !== "complete" || report.initialRehearsal.initialDigest !== bindings.initial)
			throw new Error("A bound initial fork rehearsal is required")
		if (phase === "deploy") {
			assertStaticBaseline(report.initial, await captureCoreUpgradeSnapshot(ethers, input.config, false, undefined, true))
			await deployCore(hre, ethers, input, report, directory, false)
			return
		}
		if (!bindings.deployments) throw new Error("Missing bound deployment evidence")
		const records = await assertCoreDeployments(hre, ethers, report.deployments)
		if (phase === "publish") {
			report.publicationProgress ||= {}
			for (const record of records) {
				if (report.publicationProgress[record.name] === record.codeHash) continue
				try {
					await verifyContract(
						{
							address: record.address,
							constructorArgs: [],
							contract: await resolveVerificationContractName(hre.artifacts, record.artifact),
							libraries: record.libraries,
							provider: verificationProviderForChain(42161),
						},
						hre,
					)
				} catch (error) {
					if (!(error instanceof Error && /already verified/i.test(error.message))) throw error
				}
				report.publicationProgress[record.name] = record.codeHash
				persist()
			}
			report.publication = { records, deploymentDigest: bindings.deployments }
			return
		}
		if (!bindings.publication || report.publication.deploymentDigest !== bindings.deployments)
			throw new Error("Bound explorer publication is required")
		const exportKey = process.env.SYMMIO_CORE_UPGRADE_BATCH || "cut"
		if (phase === "check-export" && exportKey !== "cut") {
			if (!["pause", "unpause"].includes(exportKey) || !bindings[`${exportKey}Batch`]) throw new Error("Missing bound Safe export")
			if (exportKey === "pause") assertStaticBaseline(report.initial, await captureCoreUpgradeSnapshot(ethers, input.config, false, undefined, true))
			else {
				if (!bindings.verifiedCut) throw new Error("Verify the cut before unpausing")
				await verifyCoreUpgradePostState(hre, ethers, input, report)
			}
			const batch = report[`${exportKey}Batch`]
			same(batch.envelope, await prepareCoreSafePayload(ethers, t.safe, batch.actions), "Safe nonce or payload changed before export")
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
			return { actions, envelope: await prepareCoreSafePayload(ethers, t.safe, actions), blockNumber: Number(await ethers.provider.getBlockNumber()) }
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
				report.pauseReceipt = await verifyCoreSafeReceipt(ethers, t.safe, report.pauseBatch.envelope, receiptHash, report.pauseBatch.blockNumber)
			const current = await captureCoreUpgradeSnapshot(ethers, input.config)
			if (!current.pause[0]) throw new Error("Core must remain globally paused")
			assertStaticBaseline(report.initial, current)
			if (report.paused) assertCoreSnapshotPreserved(report.paused, current)
			else report.paused = current
			return
		}
		if (!bindings.paused) throw new Error("A fresh bound paused snapshot is required")
		if (phase === "plan-cut" || phase === "check-export") {
			assertCoreSnapshotPreserved(report.paused, await captureCoreUpgradeSnapshot(ethers, input.config))
			const batch = buildCoreUpgradeActions(ethers, input, report.paused, report.deployments)
			if (!report.batch)
				report.batch = {
					...batch,
					envelope: await prepareCoreSafePayload(ethers, t.safe, batch.actions),
					pausedDigest: bindings.paused,
					deploymentDigest: bindings.deployments,
				}
			else same(batch.actions, report.batch.actions, "Saved Core actions changed")
			if (phase === "check-export" && (!bindings.cutRehearsal || report.cutRehearsal.batchDigest !== bindings.batch))
				throw new Error("Exact Safe payload rehearsal is required before export")
			if (phase === "check-export")
				same(report.batch.envelope, await prepareCoreSafePayload(ethers, t.safe, report.batch.actions), "Safe nonce or payload changed before export")
			return
		}
		if (!bindings.batch || report.batch.pausedDigest !== bindings.paused || report.batch.deploymentDigest !== bindings.deployments)
			throw new Error("Missing bound atomic Core batch")
		if (phase === "rehearse-cut") {
			assertCoreSnapshotPreserved(report.paused, await captureCoreUpgradeSnapshot(ethers, input.config))
			const execution = await rehearseCoreSafePayload(ethers, t.safe, report.batch.envelope, report.paused.blockNumber)
			await verifyCoreUpgradePostState(hre, ethers, input, report)
			report.cutRehearsal = { status: "complete", batchDigest: bindings.batch, execution, blockNumber: report.paused.blockNumber }
			return
		}
		if (!bindings.cutRehearsal || report.cutRehearsal.batchDigest !== bindings.batch) throw new Error("Missing bound Safe rehearsal")
		if (phase === "verify-cut") {
			report.cutReceipt = await verifyCoreSafeReceipt(ethers, t.safe, report.batch.envelope, receiptHash, report.paused.blockNumber)
			await verifyCoreUpgradePostState(hre, ethers, input, report, report.cutReceipt.blockNumber)
			await verifyCoreUpgradePostState(hre, ethers, input, report)
			report.verifiedCut = { receipt: report.cutReceipt, batchDigest: bindings.batch }
			return
		}
		if (!bindings.verifiedCut) throw new Error("Verify the executed Core cut before restoring service")
		if (phase === "plan-unpause") {
			await verifyCoreUpgradePostState(hre, ethers, input, report)
			if (!report.unpauseBatch) report.unpauseBatch = report.initial.pause[0] ? { alreadyPaused: true } : await makeBatch("unpauseGlobal")
			return
		}
		if (phase === "verify-unpause") {
			if (!bindings.unpauseBatch) throw new Error("Missing bound unpause plan")
			if (!report.unpauseBatch.alreadyPaused) {
				report.unpauseReceipt = await verifyCoreSafeReceipt(
					ethers,
					t.safe,
					report.unpauseBatch.envelope,
					receiptHash,
					report.unpauseBatch.blockNumber,
				)
				// The cut was verified while paused. Transactions later in the unpause
				// block may legitimately trade; do not freeze their economic state.
				await verifyCoreUpgradePostState(hre, ethers, input, report, report.verifiedCut.receipt.blockNumber)
				const current = await captureCoreUpgradeSnapshot(ethers, input.config, true, undefined, true)
				for (const key of ["preserved", "wiring", "code"]) same(report.paused[key], current[key], `Post-unpause ${key} changed`)
				if (
					!current.roles.listing ||
					current.roles.migration !== report.paused.roles.migration ||
					current.roles.pledgeTokenManager !== report.paused.roles.pledgeTokenManager
				)
					throw new Error("Post-unpause role mismatch")
			} else await verifyCoreUpgradePostState(hre, ethers, input, report)
			same(report.batch.desired, await selectorsAt(ethers, t.core), "Selectors changed after upgrade")
			same(Array.from(await core.pauseState()), report.initial.pause, "Final pause flags differ from their original values")
			report.status = "complete"
			return
		}
	} finally {
		persist()
		if (eventFd !== undefined) process.env.SYMMIO_TASK_EVENT_FD = eventFd
	}
}

export const arbitrumCoreUpgradeTask = task("internal:arbitrum-core-upgrade", "Internal adapter for the current Arbitrum Core-only workflow")
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
