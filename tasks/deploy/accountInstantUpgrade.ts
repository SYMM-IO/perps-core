import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import {
	ACCOUNT_FACETS,
	UPGRADE_DEPLOYMENTS,
	digest,
	assertConfigurationParity,
	IMPLEMENTATION_SLOT,
	planAccountCut,
	validateUpgradeConfig,
} from "../../deployment-tooling/account-instant-upgrade.js"
import { FacetSpecs, LibrarySpecs, linkedLibrariesFor } from "../../utils/deploymentManifest.js"
import { atomicWriteFile } from "../utils/fs.js"
import {
	captureAccountInstantSnapshot,
	compileGaslessCompatibility,
	diamondABI,
	json,
	lower,
	readGaslessConfiguration,
	readInstantConfiguration,
	readPreservedState,
	roleHash,
	selectorsAt,
	unique,
	verifyGaslessCompatibility,
} from "./accountInstantSnapshot.js"
import { assertRoundingRuntime } from "./arbitrumRoundingUpgrade.js"
import { deploymentOnlyArtifact } from "./artifacts.js"
import {
	acquireCheckpointLock,
	assertCheckpointManifest,
	createCheckpoint,
	createDeploymentManifest,
	loadCheckpoint,
	saveCheckpoint,
	setCheckpointSimulated,
	type DeploymentCheckpoint,
} from "./checkpoint.js"
import { persistSubmittedTransaction } from "./deploymentRecovery.js"
import { resolveVerificationContractName, verificationProviderForChain } from "./explorer.js"
import { completeGovernanceTransactionRequest } from "./governanceActions.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	getDeploymentTransactionJournal,
	reconcileDeploymentTransactions,
	recoverConfirmedDeployment,
	resetDeploymentTransactionJournal,
	send,
} from "./tx.js"
import { deployContract } from "./vanityDeploy.js"

const PHASES = [
	"inspect",
	"rehearse",
	"deploy",
	"publish",
	"plan-account-cut",
	"verify-account-cut",
	"configure-instant",
	"verify-instant",
	"plan-party-b",
	"execute-party-b",
	"plan-wire",
	"verify-wire",
	"canary",
	"plan-retire",
	"plan-retire-party-b",
	"execute-retire-party-b",
	"verify-final",
	"reconcile",
]
const write = (file: string, value: any) => atomicWriteFile(file, JSON.stringify(json(value), null, 2) + "\n", 0o600)
const configurationFile = (output: string) => path.join(path.dirname(output), "configuration-input.json")
const hasRole = (ethers: any, roles: any[], name: string, member: string) =>
	roles.some(r => r.role === roleHash(ethers, name) && r.members.includes(lower(member)))

export function expectedInstantConfiguration(snapshot: any, replacement: string) {
	const expected = structuredClone(snapshot.instant)
	expected.whitelist = unique(expected.whitelist.map((a: string) => (a === lower(snapshot.gasless.instantLayer) ? replacement : a)))
	return expected
}

export async function assertUpgradePreservation(ethers: any, input: any, snapshot: any, report: any) {
	const block = await ethers.provider.getBlockNumber()
	logger.info(`Checking configuration snapshot ancestry at block ${block}`)
	const canonical = await ethers.provider.getBlock(snapshot.blockNumber)
	if (canonical?.hash !== snapshot.blockHash) throw new Error("Configuration snapshot block is no longer canonical")
	logger.info("Checking Gasless implementation and AccountLayer selectors")
	const implementation = lower(`0x${(await ethers.provider.getStorage(input.config.target.gaslessLayer, IMPLEMENTATION_SLOT, block)).slice(-40)}`)
	if (![snapshot.gaslessImplementation, report.deployments?.GaslessLayer?.address].includes(implementation))
		throw new Error("GaslessLayer implementation drift")
	const accountSelectors = await selectorsAt(ethers, input.config.target.accountLayer, block)
	if (ACCOUNT_FACETS.every(name => report.deployments?.[name]))
		planAccountCut(snapshot.accountSelectors, accountSelectors, Object.fromEntries(ACCOUNT_FACETS.map(name => [name, report.deployments[name]])))
	else assertConfigurationParity(snapshot.accountSelectors, accountSelectors)
	logger.info("Checking Gasless, InstantLayer and protocol configuration values")
	const observed = {
		gasless: await readGaslessConfiguration(ethers, input.config.target.gaslessLayer, block, report.rehearsalDiscovery || input.config.discovery),
		instant: await readInstantConfiguration(ethers, input.config.target.instantLayer, block, report.rehearsalDiscovery || input.config.discovery),
		preserved: await readPreservedState(ethers, input.config.target, block),
		coreSelectors: await selectorsAt(ethers, input.config.target.core, block),
	}
	const gasless = structuredClone(snapshot.gasless)
	const newInstant = report.deployments?.InstantLayer?.address
	if (newInstant && observed.gasless.instantLayer === lower(newInstant)) gasless.instantLayer = lower(newInstant)
	report.lastObservedConfiguration = observed
	assertConfigurationParity({ gasless, instant: snapshot.instant, preserved: snapshot.preserved, coreSelectors: snapshot.coreSelectors }, observed)
	logger.info("Checking preserved contract runtime hashes")
	for (const [address, hash] of Object.entries(snapshot.codeHashes)) {
		if (ethers.keccak256(await ethers.provider.getCode(address)) !== hash) throw new Error(`Baseline runtime changed at ${address}`)
	}
	return block
}

export async function deployAccountInstantSelection(
	hre: any,
	ethers: any,
	input: any,
	snapshot: any,
	report: any,
	checkpoint: DeploymentCheckpoint,
	persist: () => void,
) {
	const [signer] = await ethers.getSigners()
	const deployer = lower(await signer.getAddress())
	if (deployer === lower(input.config.target.safe)) throw new Error("Use a separate deployment signer")
	if (report.deployer && report.deployer !== deployer) throw new Error("Deployment signer changed")
	report.deployer = deployer
	report.deployments ||= {}
	for (const role of snapshot.instant.roles) {
		if (role.admin !== ethers.ZeroHash) throw new Error("InstantLayer role-admin hierarchy cannot be reproduced by this contract")
		if (role.members.includes(deployer)) throw new Error("Deployment signer must not be a preserved InstantLayer role holder")
	}
	const specs = [
		{ name: "LibQuoteParams", artifact: LibrarySpecs.accountLayer.LibQuoteParams.artifact, args: [], libraries: {} },
		...ACCOUNT_FACETS.map(name => ({ name, artifact: FacetSpecs.accountLayer[name].artifact, args: [], libraries: {} })),
		{
			name: "InstantLayer",
			artifact: "contracts/instantLayer/InstantLayer.sol:InstantLayer",
			args: [input.config.target.core, deployer],
			libraries: {},
		},
		{ name: "GaslessLayer", artifact: "contracts/gaslessLayer/GaslessLayer.sol:GaslessLayer", args: [], libraries: report.compatibility.libraries },
	]
	for (const spec of specs) {
		if (spec.name === "CoreFacet")
			spec.libraries = linkedLibrariesFor("accountLayer", FacetSpecs.accountLayer.CoreFacet, {
				LibQuoteParams: report.deployments.LibQuoteParams.address,
			})
		const artifact = await hre.artifacts.readArtifact(spec.artifact)
		const factory = await ethers.getContractFactoryFromArtifact(spec.name === "LibQuoteParams" ? deploymentOnlyArtifact(artifact) : artifact, {
			libraries: spec.libraries,
			signer,
		})
		const component = `contracts.accountInstantUpgrade.${spec.name}`
		const recovered = await recoverConfirmedDeployment(checkpoint.transactions || [], component, ethers.provider)
		const saved = report.deployments[spec.name]
		if (saved && (!recovered || lower(recovered) !== lower(saved.address)))
			throw new Error(`${spec.name} deployment report conflicts with the receipt journal`)
		const address =
			recovered ||
			(
				await deployContract(null, {
					key: `${spec.name === "InstantLayer" ? "peripherals" : spec.name === "GaslessLayer" ? "gaslessLayer" : "accountLayer"}/${spec.name}`,
					component,
					label: spec.name,
					factory: {
						...factory,
						deploy: async (...args: any[]) => {
							const request = await completeGovernanceTransactionRequest(ethers.provider, {
								...(await factory.getDeployTransaction(...args)),
								from: deployer,
							})
							return factory.deploy(...args, {
								gasLimit: request.gasLimit,
								gasPrice: request.gasPrice,
								maxFeePerGas: request.maxFeePerGas,
								maxPriorityFeePerGas: request.maxPriorityFeePerGas,
							})
						},
					},
					constructorArgs: spec.args,
					checkpoint,
				})
			).address
		await assertRoundingRuntime(ethers, artifact, address, spec.libraries)
		report.deployments[spec.name] = {
			...saved,
			address: lower(address),
			artifact: spec.artifact,
			constructorArguments: spec.args,
			libraries: spec.libraries,
			codeHash: ethers.keccak256(await ethers.provider.getCode(address)),
			selectors: factory.interface.fragments
				.filter((f: any) => f.type === "function")
				.map((f: any) => factory.interface.getFunction(f.format("sighash")).selector)
				.sort(),
		}
		persist()
	}
}

export async function assertUpgradeDeployments(hre: any, ethers: any, input: any, report: any, publication = false) {
	for (const name of UPGRADE_DEPLOYMENTS) {
		const entry = report.deployments?.[name]
		if (!entry || (publication && !entry.published)) throw new Error(`${name} deployment/publication is incomplete`)
		const artifactName =
			name === "InstantLayer"
				? "contracts/instantLayer/InstantLayer.sol:InstantLayer"
				: name === "GaslessLayer"
					? "contracts/gaslessLayer/GaslessLayer.sol:GaslessLayer"
					: name === "LibQuoteParams"
						? LibrarySpecs.accountLayer.LibQuoteParams.artifact
						: FacetSpecs.accountLayer[name].artifact
		const artifact = await hre.artifacts.readArtifact(artifactName)
		const iface = new ethers.Interface(name === "LibQuoteParams" ? [] : artifact.abi)
		const selectors = iface.fragments
			.filter((f: any) => f.type === "function")
			.map((f: any) => iface.getFunction(f.format("sighash")).selector)
			.sort()
		const libraries =
			name === "GaslessLayer"
				? report.compatibility.libraries
				: name === "CoreFacet"
					? linkedLibrariesFor("accountLayer", FacetSpecs.accountLayer.CoreFacet, { LibQuoteParams: report.deployments.LibQuoteParams.address })
					: {}
		assertConfigurationParity(
			{ artifact: artifactName, libraries, selectors },
			{ artifact: entry.artifact, libraries: entry.libraries, selectors: entry.selectors },
		)
		await assertRoundingRuntime(ethers, artifact, entry.address, entry.libraries)
	}
	const instant = await ethers.getContractAt("InstantLayer", report.deployments.InstantLayer.address)
	if (lower(await instant.symmio()) !== lower(input.config.target.core)) throw new Error("New InstantLayer Core immutable differs")
	const gasless = await ethers.getContractAt("GaslessLayer", report.deployments.GaslessLayer.address)
	if ((await gasless.proxiableUUID()) !== IMPLEMENTATION_SLOT) throw new Error("New GaslessLayer implementation is not compatible UUPS")
}

export async function accountUpgradeCut(ethers: any, input: any, snapshot: any, report: any) {
	const facets = Object.fromEntries(ACCOUNT_FACETS.map(name => [name, report.deployments[name]]))
	const result = planAccountCut(snapshot.accountSelectors, await selectorsAt(ethers, input.config.target.accountLayer), facets)
	report.desiredAccountSelectors = result.desired
	return result.calldata
		? [
				{
					authority: lower(input.config.target.safe),
					to: input.config.target.accountLayer,
					value: "0",
					data: result.calldata,
					description:
						"Upgrade AccountLayer Core, Margin, Control and View facets and install TimelockFacet; no initializer or global timelock setters",
				},
			]
		: []
}

export async function configureReplacementInstant(ethers: any, input: any, snapshot: any, report: any) {
	const [signer] = await ethers.getSigners()
	if (lower(await signer.getAddress()) !== report.deployer) throw new Error("Use the original deployment signer for InstantLayer configuration")
	const contract = (await ethers.getContractAt("InstantLayer", report.deployments.InstantLayer.address)).connect(signer)
	const expected = expectedInstantConfiguration(snapshot, report.deployments.InstantLayer.address)
	const call = async (method: string, args: any[]) => {
		const request = await completeGovernanceTransactionRequest(ethers.provider, {
			from: report.deployer,
			to: await contract.getAddress(),
			data: contract.interface.encodeFunctionData(method, args),
			value: 0n,
		})
		await send(signer.sendTransaction(request), `InstantLayer ${method}`)
	}
	if (lower(await contract.accountLayer()) !== expected.accountLayer) await call("setAccountLayer", [expected.accountLayer])
	for (const target of expected.whitelist) if (!(await contract.whitelistedTargets(target))) await call("setTargetWhitelist", [target, true])
	// setAccountLayer whitelists its target; remove it if the old configuration explicitly did not.
	for (const target of [expected.symmio, expected.accountLayer])
		if (!expected.whitelist.includes(target) && (await contract.whitelistedTargets(target))) await call("setTargetWhitelist", [target, false])
	for (const partyB of expected.registeredPartyBs) if (!(await contract.registeredPartyBs(partyB))) await call("registerPartyBs", [[partyB]])
	if (String(await contract.revocationCooldown()) !== expected.revocationCooldown) await call("setRevocationCooldown", [expected.revocationCooldown])
	if ((await contract.transientContextEnabled()) !== expected.transientContextEnabled)
		await call("setTransientContextEnabled", [expected.transientContextEnabled])
	let count = Number(await contract.nextTemplateId())
	if (count > expected.templates.length) throw new Error("Replacement InstantLayer contains unexpected templates")
	for (const template of expected.templates) {
		if (template.id === count) {
			await call("addTemplate", [template.name, template.operations])
			count++
		}
		const actual = await contract.getTemplate(template.id)
		const operations = actual.operations.map((o: any) => ({
			insertionPoints: Array.from(o.insertionPoints, String),
			sourceIndices: Array.from(o.sourceIndices, String),
			sourceOffsets: Array.from(o.sourceOffsets, String),
		}))
		assertConfigurationParity({ name: template.name, operations: template.operations }, { name: actual.name, operations })
		if (actual.active !== template.active) await call("setTemplateActive", [template.id, template.active])
		if ((await contract.templateInstantOpenMode(template.id)) !== template.instantOpenMode)
			await call("setTemplateInstantOpenMode", [template.id, template.instantOpenMode])
	}
	for (const role of expected.roles)
		for (const member of role.members) if (!(await contract.hasRole(role.role, member))) await call("grantRole", [role.role, member])
	// registerPartyBs also grants OPERATOR_ROLE. Preserve the snapshot even if a historical admin revoked it.
	for (const partyB of expected.registeredPartyBs)
		if (!hasRole(ethers, expected.roles, "OPERATOR_ROLE", partyB) && (await contract.hasRole(ethers.id("OPERATOR_ROLE"), partyB)))
			await call("revokeRole", [ethers.id("OPERATOR_ROLE"), partyB])
	for (const name of ["OPERATOR_ROLE", "SETTER_ROLE", "REVOKER_ROLE", "DEFAULT_ADMIN_ROLE"]) {
		const role = roleHash(ethers, name)
		if (await contract.hasRole(role, report.deployer)) await call("renounceRole", [role, report.deployer])
	}
	await verifyReplacementInstant(ethers, snapshot, report)
}

export async function verifyReplacementInstant(ethers: any, snapshot: any, report: any) {
	assertConfigurationParity(
		expectedInstantConfiguration(snapshot, report.deployments.InstantLayer.address),
		await readInstantConfiguration(
			ethers,
			report.deployments.InstantLayer.address,
			await ethers.provider.getBlockNumber(),
			report.rehearsalDiscovery,
		),
	)
}

export async function planPartyBUpgrade(ethers: any, snapshot: any, report: any, retire = false) {
	const actions = []
	const instant = retire ? snapshot.gasless.instantLayer : report.deployments.InstantLayer.address
	for (const [partyB, authority] of Object.entries(snapshot.partyBAdmins)) {
		const contract = await ethers.getContractAt("SymmioPartyB", partyB)
		for (const role of [ethers.ZeroHash, ethers.id("SETTER_ROLE")])
			if (!(await contract.hasRole(role, authority))) throw new Error(`PartyB authority changed on ${partyB}`)
		const trusted = await contract.hasRole(ethers.id("TRUSTED_ROLE"), instant),
			allowed = await contract.multicastWhitelist(instant)
		if (trusted !== !retire)
			actions.push({
				authority,
				to: partyB,
				value: "0",
				data: contract.interface.encodeFunctionData(retire ? "revokeRole" : "grantRole", [ethers.id("TRUSTED_ROLE"), instant]),
				description: `${retire ? "Revoke" : "Grant"} PartyB TRUSTED_ROLE for ${instant}`,
			})
		if (allowed !== !retire)
			actions.push({
				authority,
				to: partyB,
				value: "0",
				data: contract.interface.encodeFunctionData("setMulticastWhitelist", [instant, !retire]),
				description: `${retire ? "Remove" : "Add"} InstantLayer ${instant} in PartyB multicast whitelist`,
			})
	}
	return actions
}

export async function planProtocolUpgrade(ethers: any, input: any, snapshot: any, report: any, retire = false) {
	const t = input.config.target,
		actions = [],
		instant = retire ? t.instantLayer : report.deployments.InstantLayer.address
	for (const [address, roles] of [
		[t.core, ["INSTANT_LAYER_ROLE"]],
		[t.accountLayer, ["SIGNER_SETTER_ROLE", "INSTANT_LAYER_ROLE"]],
	] as [string, string[]][]) {
		const contract = await ethers.getContractAt(diamondABI, address)
		if (!(await contract.hasRole(t.safe, ethers.id("DEFAULT_ADMIN_ROLE")))) throw new Error(`Safe lacks default-admin authority on ${address}`)
		for (const name of roles)
			if ((await contract.hasRole(instant, ethers.id(name))) !== !retire)
				actions.push({
					authority: lower(t.safe),
					to: address,
					value: "0",
					data: contract.interface.encodeFunctionData(retire ? "revokeRole" : "grantRole", [instant, ethers.id(name)]),
					description: `${retire ? "Revoke" : "Grant"} ${name} for InstantLayer ${instant}`,
				})
	}
	if (!retire) {
		const gasless = await ethers.getContractAt("GaslessLayer", t.gaslessLayer)
		const implementation = lower(`0x${(await ethers.provider.getStorage(t.gaslessLayer, IMPLEMENTATION_SLOT)).slice(-40)}`)
		const replacement = report.deployments.GaslessLayer.address
		if (implementation !== snapshot.gaslessImplementation && implementation !== replacement) throw new Error("GaslessLayer implementation drift")
		if (implementation !== replacement || lower(await gasless.instantLayer()) !== lower(instant))
			actions.push({
				authority: lower(t.safe),
				to: t.gaslessLayer,
				value: "0",
				data: gasless.interface.encodeFunctionData("upgradeToAndCall", [
					replacement,
					gasless.interface.encodeFunctionData("setInstantLayer", [instant]),
				]),
				description: `Upgrade existing GaslessLayer proxy and setInstantLayer(${instant}); preserve fees, relayers, treasury, nonces and usage storage`,
			})
	}
	return actions
}

export async function executeUpgradeActions(ethers: any, actions: any[], expectedAuthority?: string) {
	const [signer] = await ethers.getSigners()
	const address = lower(await signer.getAddress())
	if (expectedAuthority && address !== lower(expectedAuthority)) throw new Error("Selected signer differs from the reviewed authority")
	for (const action of actions) {
		if (address !== lower(action.authority)) throw new Error(`This action requires ${action.authority}`)
		const request = await completeGovernanceTransactionRequest(ethers.provider, {
			from: address,
			to: action.to,
			value: BigInt(action.value),
			data: action.data,
		})
		await send(signer.sendTransaction(request), action.description)
	}
}

async function withJournal(
	ethers: any,
	input: any,
	report: any,
	simulated: boolean,
	scopeSuffix: string,
	fn: (checkpoint: DeploymentCheckpoint) => Promise<void>,
) {
	const chain = Number((await ethers.provider.getNetwork()).chainId),
		scope = `account-instant-${digest(input).slice(0, 16)}-${scopeSuffix}`
	setCheckpointSimulated(simulated)
	const lock = acquireCheckpointLock(chain, scope)
	try {
		const checkpoint = loadCheckpoint(chain, scope) || createCheckpoint(simulated ? "fork-arbitrum" : "arbitrum", chain, scope)
		const manifest = createDeploymentManifest(
			{ input, simulated, scopeSuffix },
			{ deploymentId: checkpoint.deploymentId || checkpoint.manifest?.deploymentId },
		)
		if (checkpoint.manifest) assertCheckpointManifest(checkpoint, manifest)
		checkpoint.manifest = manifest
		checkpoint.deploymentId = manifest.deploymentId
		const signer = (await ethers.getSigners())[0],
			signerAddress = signer ? lower(await signer.getAddress()) : undefined
		if (signerAddress && checkpoint.deployerAddress && lower(checkpoint.deployerAddress) !== signerAddress) throw new Error("Journal signer changed")
		checkpoint.deployerAddress ||= signerAddress
		resetDeploymentTransactionJournal()
		try {
			await reconcileDeploymentTransactions(checkpoint.transactions || [], ethers.provider, checkpoint.deployerAddress)
			bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint, record))
			await fn(checkpoint)
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

export async function verifyUpgradeCanary(ethers: any, input: any, report: any, hash: string) {
	if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Provide the successful new GaslessLayer relay transaction hash")
	const receipt = await ethers.provider.getTransactionReceipt(hash)
	if (!receipt || receipt.status !== 1 || lower(receipt.to || "") !== lower(input.config.target.gaslessLayer))
		throw new Error("Canary must be a successful transaction to the preserved GaslessLayer proxy")
	const instant = await ethers.getContractAt("InstantLayer", report.deployments.InstantLayer.address)
	const events = receipt.logs
		.filter((l: any) => lower(l.address) === lower(instant.target))
		.map((l: any) => {
			try {
				return instant.interface.parseLog(l)?.name
			} catch {
				return undefined
			}
		})
	if (!events.some((name: string) => ["DelegationGranted", "NonceIncremented"].includes(name)))
		throw new Error("Canary needs a delegation grant or ordered-nonce operation emitted by the new InstantLayer")
	report.canary = { hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, instantLayer: lower(instant.target) }
}

export const accountInstantUpgradeTask = task(
	"internal:account-instant-upgrade",
	"Configuration-preserving AccountLayer and InstantLayer upgrade adapter",
)
	.addOption({ name: "phase", type: ArgumentType.STRING, defaultValue: "inspect" })
	.addOption({ name: "input", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "output", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "authority", type: ArgumentType.STRING, defaultValue: "" })
	.setAction(async () => ({
		default: async ({ phase, input: inputFile, output, authority }, hre) => {
			if (!PHASES.includes(phase)) throw new Error("Unknown account/instant upgrade phase")
			const input = JSON.parse(fs.readFileSync(inputFile, "utf8"))
			validateUpgradeConfig(input.config)
			const inputDigest = digest(input)
			if (process.env.SYMMIO_ACCOUNT_UPGRADE_INPUT !== inputDigest) throw new Error("Start this adapter from ./symmio")
			if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== input.sourceCommit)
				throw new Error("Upgrade source commit changed")
			const connection = await getConnection(hre),
				{ ethers } = connection
			const simulated = connection.networkConfig?.type === "edr-simulated"
			if (
				Number((await ethers.provider.getNetwork()).chainId) !== 42161 ||
				(simulated ? phase !== "rehearse" : connection.networkName !== "arbitrum")
			)
				throw new Error("Incorrect network for this upgrade phase")
			const mutates = ["deploy", "configure-instant", "execute-party-b", "execute-retire-party-b"].includes(phase)
			if (mutates && (process.env.SYMMIO_ACCOUNT_UPGRADE_EXECUTE !== "true" || process.env.CONFIRM_CHAIN_ID !== "42161"))
				throw new Error("Live execution needs explicit Arbitrum authorization")
			const report: any = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : { inputDigest, transactions: [] }
			if (report.inputDigest !== inputDigest) throw new Error("Upgrade report/input mismatch")
			const persist = () => write(output, report)
			delete report.error
			try {
				if (phase === "inspect") {
					if (!report.snapshotDigest) {
						const snapshot: any = await captureAccountInstantSnapshot(ethers, input.config)
						logger.info("Verifying baseline GaslessLayer runtime, linked libraries and storage layout")
						report.compatibility = await verifyGaslessCompatibility(
							hre,
							ethers,
							snapshot,
							await compileGaslessCompatibility(hre, input.config.gaslessBaselineCommit),
						)
						snapshot.gaslessCompatibility = report.compatibility
						for (const address of Object.values(report.compatibility.libraries) as string[])
							snapshot.codeHashes[address] = ethers.keccak256(await ethers.provider.getCode(address, snapshot.blockNumber))
						write(configurationFile(output), snapshot)
						report.snapshotDigest = digest(snapshot)
						report.snapshotBlock = snapshot.blockNumber
					}
					return
				}
				const snapshot = JSON.parse(fs.readFileSync(configurationFile(output), "utf8"))
				if (digest(snapshot) !== report.snapshotDigest || process.env.SYMMIO_ACCOUNT_UPGRADE_SNAPSHOT !== report.snapshotDigest)
					throw new Error("Reviewed configuration input changed")
				assertConfigurationParity(snapshot.gaslessCompatibility, report.compatibility)
				if (phase === "reconcile") {
					report.transactions = [
						...new Map(
							[...(report.transactions || []), ...JSON.parse(process.env.SYMMIO_ACCOUNT_UPGRADE_TRANSACTIONS || "[]")].map(tx => [
								tx.hash.toLowerCase(),
								tx,
							]),
						).values(),
					]
					await reconcileDeploymentTransactions(report.transactions || [], ethers.provider)
					return
				}
				if (phase === "rehearse") {
					if (Number(process.env.FORK_BLOCK_NUMBER) !== snapshot.blockNumber) throw new Error("Fork does not match the configuration snapshot block")
					// The runner must never reconcile fork hashes against the live chain.
					const eventFd = process.env.SYMMIO_TASK_EVENT_FD
					delete process.env.SYMMIO_TASK_EVENT_FD
					try {
						report.rehearsal = await rehearseAccountInstantUpgrade(hre, ethers, input, snapshot, report.compatibility)
					} finally {
						if (eventFd !== undefined) process.env.SYMMIO_TASK_EVENT_FD = eventFd
					}
					return
				}
				await assertUpgradePreservation(ethers, input, snapshot, report)
				if (phase === "deploy") {
					if (report.rehearsal?.snapshotDigest !== report.snapshotDigest || report.rehearsal?.status !== "complete")
						throw new Error("Matching fork rehearsal is required before live deployment")
					await withJournal(ethers, input, report, false, "deployer", checkpoint =>
						deployAccountInstantSelection(hre, ethers, input, snapshot, report, checkpoint, persist),
					)
					return
				}
				await assertUpgradeDeployments(hre, ethers, input, report)
				if (phase === "publish") {
					for (const entry of Object.values(report.deployments) as any[])
						if (!entry.published) {
							await verifyContract(
								{
									address: entry.address,
									constructorArgs: entry.constructorArguments,
									contract: await resolveVerificationContractName(hre.artifacts, entry.artifact),
									libraries: entry.libraries,
									provider: verificationProviderForChain(42161),
								},
								hre,
							).catch(error => {
								if (!String(error?.message).toLowerCase().includes("already verified")) throw error
							})
							entry.published = true
							persist()
						}
					return
				}
				await assertUpgradeDeployments(hre, ethers, input, report, true)
				const cut = await accountUpgradeCut(ethers, input, snapshot, report)
				if (phase === "plan-account-cut") {
					report.actions = cut
					return
				}
				if (cut.length) throw new Error("AccountLayer cut must be executed and verified first")
				if (phase === "verify-account-cut") return
				if (phase === "configure-instant") {
					await withJournal(ethers, input, report, false, "deployer", async () => configureReplacementInstant(ethers, input, snapshot, report))
					return
				}
				await verifyReplacementInstant(ethers, snapshot, report)
				if (phase === "verify-instant") return
				if (["plan-party-b", "execute-party-b"].includes(phase)) {
					report.actions = await planPartyBUpgrade(ethers, snapshot, report)
					if (phase === "execute-party-b")
						await withJournal(ethers, input, report, false, `party-b-${lower(authority)}`, async () =>
							executeUpgradeActions(
								ethers,
								report.actions.filter((a: any) => a.authority === lower(authority)),
								authority,
							),
						)
					return
				}
				const wiring = await planProtocolUpgrade(ethers, input, snapshot, report)
				if (phase === "plan-wire") {
					if ((await planPartyBUpgrade(ethers, snapshot, report)).length)
						throw new Error("Complete the PartyB trust/whitelist actions before GaslessLayer cutover")
					report.actions = wiring
					return
				}
				if (wiring.length) throw new Error("Protocol wiring or GaslessLayer upgrade remains incomplete")
				if ((await planPartyBUpgrade(ethers, snapshot, report)).length) throw new Error("New InstantLayer PartyB wiring changed")
				if (phase === "verify-wire") return
				if (phase === "canary") {
					await verifyUpgradeCanary(ethers, input, report, process.env.SYMMIO_ACCOUNT_UPGRADE_CANARY || "")
					return
				}
				if (!report.canary) throw new Error("Verify a production canary before retiring the old layer")
				await verifyUpgradeCanary(ethers, input, report, report.canary.hash)
				if (phase === "plan-retire") {
					report.actions = await planProtocolUpgrade(ethers, input, snapshot, report, true)
					return
				}
				if ((await planProtocolUpgrade(ethers, input, snapshot, report, true)).length) throw new Error("Old InstantLayer protocol authority remains")
				if (["plan-retire-party-b", "execute-retire-party-b"].includes(phase)) {
					report.actions = await planPartyBUpgrade(ethers, snapshot, report, true)
					if (phase === "execute-retire-party-b")
						await withJournal(ethers, input, report, false, `party-b-${lower(authority)}`, async () =>
							executeUpgradeActions(
								ethers,
								report.actions.filter((a: any) => a.authority === lower(authority)),
								authority,
							),
						)
					return
				}
				if ((await planPartyBUpgrade(ethers, snapshot, report, true)).length) throw new Error("Old PartyB trust/whitelist authority remains")
				report.status = "complete"
				report.verifiedBlock = await ethers.provider.getBlockNumber()
			} catch (error) {
				report.error = error instanceof Error ? error.message : String(error)
				throw error
			} finally {
				persist()
			}
		},
	}))
	.build()

export async function rehearseAccountInstantUpgrade(hre: any, ethers: any, input: any, snapshot: any, compatibility: any) {
	logger.info("Checking the rehearsal fork block")
	const metadata = await ethers.provider.send("hardhat_metadata", [])
	if (Number(metadata.forkedNetwork?.forkBlockNumber) !== snapshot.blockNumber) throw new Error("Rehearsal requires the exact pinned fork")
	if (!snapshot.eventHistory) throw new Error("Rehearsal requires the pinned configuration event history; inspect again")
	const local: any = {
		compatibility,
		transactions: [],
		rehearsalDiscovery: { ...input.config.discovery, _forkBlock: snapshot.blockNumber, _history: snapshot.eventHistory },
	}
	const [deployer] = await ethers.getSigners()
	await ethers.provider.send("hardhat_setBalance", [await deployer.getAddress(), "0x3635c9adc5dea00000"])
	logger.info("Comparing the fork pre-state with the current-value snapshot")
	await assertUpgradePreservation(ethers, input, snapshot, local)
	// Rehearsal artifacts/transactions stay isolated from the live deployment journal.
	await withJournal(ethers, input, local, true, `rehearse-${Date.now()}`, checkpoint =>
		deployAccountInstantSelection(hre, ethers, input, snapshot, local, checkpoint, () => {}),
	)
	const execute = async (actions: any[]) => {
		for (const action of actions) {
			await ethers.provider.send("hardhat_impersonateAccount", [action.authority])
			await ethers.provider.send("hardhat_setBalance", [action.authority, "0x3635c9adc5dea00000"])
			const signer = await ethers.getSigner(action.authority)
			const tx = await signer.sendTransaction({ to: action.to, value: 0n, data: action.data })
			await tx.wait()
		}
	}
	await execute(await accountUpgradeCut(ethers, input, snapshot, local))
	await configureReplacementInstant(ethers, input, snapshot, local)
	await execute(await planPartyBUpgrade(ethers, snapshot, local))
	await execute(await planProtocolUpgrade(ethers, input, snapshot, local))
	if ((await accountUpgradeCut(ethers, input, snapshot, local)).length || (await planProtocolUpgrade(ethers, input, snapshot, local)).length)
		throw new Error("Fork cut/wiring did not converge")
	await assertUpgradePreservation(ethers, input, snapshot, local)
	await verifyReplacementInstant(ethers, snapshot, local)
	await execute(await planProtocolUpgrade(ethers, input, snapshot, local, true))
	await execute(await planPartyBUpgrade(ethers, snapshot, local, true))
	if ((await planProtocolUpgrade(ethers, input, snapshot, local, true)).length || (await planPartyBUpgrade(ethers, snapshot, local, true)).length)
		throw new Error("Fork retirement did not converge")
	return {
		status: "complete",
		snapshotDigest: digest(snapshot),
		baseBlockNumber: snapshot.blockNumber,
		baseBlockHash: snapshot.blockHash,
		deployments: local.deployments,
	}
}
