import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { id, ZeroHash } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import {
	ACCOUNT_FACETS,
	NEW_GASLESS_LIBRARIES,
	GASLESS_LIBRARIES,
	UPGRADE_DEPLOYMENTS,
	digest,
	assertConfigurationParity,
	IMPLEMENTATION_SLOT,
	planAccountCut,
	validateUpgradeConfig,
	flowDiscovery,
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
	readPartyBUpgradeAuthority,
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
	"client-handoff",
	"plan-account-cut",
	"verify-account-cut",
	"plan-configure-instant",
	"verify-instant",
	"plan-party-b",
	"plan-wire",
	"verify-wire",
	"canary",
	"plan-retire",
	"plan-retire-party-b",
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
	if (snapshot.flow) {
		expected.registeredPartyBs = unique([...expected.registeredPartyBs, ...snapshot.flow.partyBs])
		for (const [role, member] of [
			[ZeroHash, snapshot.flow.safe],
			[id("SETTER_ROLE"), snapshot.flow.safe],
			...unique([snapshot.flow.gaslessLayer, ...snapshot.flow.partyBs]).map(member => [id("OPERATOR_ROLE"), member]),
		])
			addRoleMember(expected.roles, role, member)
	}
	return expected
}

function addRoleMember(roles: any[], role: string, member: string) {
	let entry = roles.find(r => r.role === role)
	if (!entry) roles.push((entry = { role, admin: ZeroHash, members: [] }))
	entry.members = unique([...entry.members, member])
	roles.sort((a, b) => a.role.localeCompare(b.role))
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
	if (implementation === report.deployments?.GaslessLayer?.address) {
		const upgraded = await ethers.getContractAt("GaslessLayer", input.config.target.gaslessLayer)
		if ((await upgraded.walletCreationFee({ blockTag: block })) !== 0n) throw new Error("Upgraded Gasless walletCreationFee must remain disabled")
	}
	const accountSelectors = await selectorsAt(ethers, input.config.target.accountLayer, block)
	if (ACCOUNT_FACETS.every(name => report.deployments?.[name]))
		planAccountCut(snapshot.accountSelectors, accountSelectors, Object.fromEntries(ACCOUNT_FACETS.map(name => [name, report.deployments[name]])))
	else assertConfigurationParity(snapshot.accountSelectors, accountSelectors)
	logger.info("Checking Gasless, InstantLayer and protocol configuration values")
	const observed = {
		gasless: await readGaslessConfiguration(ethers, input.config.target.gaslessLayer, block, flowDiscovery(input.config)),
		instant: await readInstantConfiguration(ethers, input.config.target.instantLayer, block, flowDiscovery(input.config)),
		preserved: await readPreservedState(ethers, input.config.target, block),
		coreSelectors: await selectorsAt(ethers, input.config.target.core, block),
	}
	const gasless = structuredClone(snapshot.gasless)
	// Permit only the requested missing grants; existing memberships and all settings remain pinned.
	for (const [name, member] of [
		["CONFIG_ADMIN_ROLE", input.config.target.safe],
		["RELAYER_ROLE", input.config.target.relayer],
	])
		if (hasRole(ethers, observed.gasless.roles, name, member)) addRoleMember(gasless.roles, roleHash(ethers, name), member)
	const preserved = structuredClone(snapshot.preserved)
	for (const field of ["operationalFeeCharger", "accountGaslessCreator"] as const) if (!preserved[field]) preserved[field] = observed.preserved[field]
	const newInstant = report.deployments?.InstantLayer?.address
	if (newInstant && observed.gasless.instantLayer === lower(newInstant)) gasless.instantLayer = lower(newInstant)
	report.lastObservedConfiguration = observed
	assertConfigurationParity({ gasless, instant: snapshot.instant, preserved, coreSelectors: snapshot.coreSelectors }, observed)
	logger.info("Checking preserved contract runtime hashes")
	for (const [address, hash] of Object.entries(snapshot.codeHashes)) {
		if (ethers.keccak256(await ethers.provider.getCode(address)) !== hash) throw new Error(`Baseline runtime changed at ${address}`)
	}
	return block
}

const gaslessLibraryArtifact = (name: string) => `contracts/gaslessLayer/libraries/${name}.sol:${name}`

function upgradeLibraries(report: any, artifact: any) {
	const bindings: Record<string, string> = {}
	for (const [source, names] of Object.entries(artifact.linkReferences))
		for (const name of Object.keys(names as any)) {
			if (!GASLESS_LIBRARIES.includes(name) || !report.deployments[name]?.address) throw new Error(`Missing replacement library ${name}`)
			bindings[`${source}:${name}`] = report.deployments[name].address
		}
	return bindings
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
		...ACCOUNT_FACETS.map(name => ({
			name,
			artifact: FacetSpecs.accountLayer[name].artifact,
			args: [],
			libraries: {},
		})),
		{
			name: "InstantLayer",
			artifact: "contracts/instantLayer/InstantLayer.sol:InstantLayer",
			args: [input.config.target.core, input.config.target.safe],
			libraries: {},
		},
		...NEW_GASLESS_LIBRARIES.map(name => ({ name, artifact: gaslessLibraryArtifact(name), args: [], libraries: {} })),
		{ name: "GaslessLayer", artifact: "contracts/gaslessLayer/GaslessLayer.sol:GaslessLayer", args: [], libraries: {} },
	]
	for (const spec of specs) {
		const artifact = await hre.artifacts.readArtifact(spec.artifact)
		if (spec.name.startsWith("Gasless")) spec.libraries = upgradeLibraries(report, artifact)
		if (spec.name === "CoreFacet")
			spec.libraries = linkedLibrariesFor("accountLayer", FacetSpecs.accountLayer.CoreFacet, {
				LibQuoteParams: report.deployments.LibQuoteParams.address,
			})
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
					key: `${spec.name === "InstantLayer" ? "peripherals" : spec.name.startsWith("Gasless") ? "gaslessLayer" : "accountLayer"}/${spec.name}`,
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
		const creation = (checkpoint.transactions || []).find(
			tx => tx.deployment?.component === component && ["confirmed", "replaced"].includes(tx.status),
		)
		if (!creation || creation.deployment?.kind !== "create") throw new Error(`${spec.name} has no confirmed direct creation in the receipt journal`)
		report.deployments[spec.name] = {
			...saved,
			address: lower(address),
			deploymentTransaction: creation.replacementHash || creation.hash,
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
						: NEW_GASLESS_LIBRARIES.includes(name)
							? gaslessLibraryArtifact(name)
							: FacetSpecs.accountLayer[name].artifact
		const artifact = await hre.artifacts.readArtifact(artifactName)
		const iface = new ethers.Interface(name === "LibQuoteParams" ? [] : artifact.abi)
		const selectors = iface.fragments
			.filter((f: any) => f.type === "function")
			.map((f: any) => iface.getFunction(f.format("sighash")).selector)
			.sort()
		const libraries =
			name === "GaslessLayer" || NEW_GASLESS_LIBRARIES.includes(name)
				? upgradeLibraries(report, artifact)
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
	if (!(await instant.hasRole(ethers.ZeroHash, input.config.target.safe)))
		throw new Error("New InstantLayer administration differs from the reviewed Safe")
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

export async function planInstantConfiguration(ethers: any, input: any, snapshot: any, report: any) {
	const safe = lower(input.config.target.safe)
	const contract = await ethers.getContractAt("InstantLayer", report.deployments.InstantLayer.address)
	if (!(await contract.hasRole(ethers.ZeroHash, safe))) throw new Error("Reviewed Safe lacks replacement InstantLayer default-admin authority")
	const expected = expectedInstantConfiguration(snapshot, report.deployments.InstantLayer.address)
	const actions: any[] = []
	const call = (method: string, args: any[]) =>
		actions.push({
			authority: safe,
			to: String(contract.target),
			value: "0",
			data: contract.interface.encodeFunctionData(method, args),
			description: `InstantLayer ${method}`,
		})
	if (!(await contract.hasRole(ethers.id("SETTER_ROLE"), safe))) call("grantRole", [ethers.id("SETTER_ROLE"), safe])
	const oldAccount = lower(await contract.accountLayer())
	const changesAccount = oldAccount !== expected.accountLayer
	if (changesAccount) call("setAccountLayer", [expected.accountLayer])
	for (const target of expected.whitelist)
		if (!(await contract.whitelistedTargets(target)) && !(changesAccount && target === expected.accountLayer))
			call("setTargetWhitelist", [target, true])
	for (const target of [expected.symmio, expected.accountLayer])
		if (!expected.whitelist.includes(target) && ((await contract.whitelistedTargets(target)) || (changesAccount && target === expected.accountLayer)))
			call("setTargetWhitelist", [target, false])
	const registered = new Set<string>()
	for (const partyB of expected.registeredPartyBs)
		if (!(await contract.registeredPartyBs(partyB))) {
			call("registerPartyBs", [[partyB]])
			registered.add(partyB)
		}
	if (String(await contract.revocationCooldown()) !== expected.revocationCooldown) call("setRevocationCooldown", [expected.revocationCooldown])
	if ((await contract.transientContextEnabled()) !== expected.transientContextEnabled)
		call("setTransientContextEnabled", [expected.transientContextEnabled])
	const count = Number(await contract.nextTemplateId())
	if (count > expected.templates.length) throw new Error("Replacement InstantLayer contains unexpected templates")
	for (const template of expected.templates) {
		let active = true,
			instantOpenMode = false
		if (template.id >= count) call("addTemplate", [template.name, template.operations])
		else {
			const actual = await contract.getTemplate(template.id)
			const operations = actual.operations.map((o: any) => ({
				insertionPoints: Array.from(o.insertionPoints, String),
				sourceIndices: Array.from(o.sourceIndices, String),
				sourceOffsets: Array.from(o.sourceOffsets, String),
			}))
			assertConfigurationParity({ name: template.name, operations: template.operations }, { name: actual.name, operations })
			active = actual.active
			instantOpenMode = await contract.templateInstantOpenMode(template.id)
		}
		if (active !== template.active) call("setTemplateActive", [template.id, template.active])
		if (instantOpenMode !== template.instantOpenMode) call("setTemplateInstantOpenMode", [template.id, template.instantOpenMode])
	}
	for (const role of expected.roles)
		for (const member of role.members)
			if (
				!(await contract.hasRole(role.role, member)) &&
				!(role.role === ethers.id("OPERATOR_ROLE") && registered.has(member)) &&
				!(role.role === ethers.id("SETTER_ROLE") && member === safe)
			)
				call("grantRole", [role.role, member])
	for (const partyB of expected.registeredPartyBs)
		if (
			!hasRole(ethers, expected.roles, "OPERATOR_ROLE", partyB) &&
			((await contract.hasRole(ethers.id("OPERATOR_ROLE"), partyB)) || registered.has(partyB))
		)
			call("revokeRole", [ethers.id("OPERATOR_ROLE"), partyB])
	// The constructor grants Safe OPERATOR_ROLE; retain it only when in the reviewed scope.
	if (!hasRole(ethers, expected.roles, "OPERATOR_ROLE", safe) && (await contract.hasRole(ethers.id("OPERATOR_ROLE"), safe)))
		call("revokeRole", [ethers.id("OPERATOR_ROLE"), safe])
	return actions
}

/** Local/fork execution seam; live configuration is exported through the CLI's Safe stage. */
export async function configureReplacementInstant(ethers: any, input: any, snapshot: any, report: any) {
	await executeUpgradeActions(ethers, await planInstantConfiguration(ethers, input, snapshot, report), input.config.target.safe)
	await verifyReplacementInstant(ethers, snapshot, report)
}

export async function verifyReplacementInstant(ethers: any, snapshot: any, report: any) {
	assertConfigurationParity(
		expectedInstantConfiguration(snapshot, report.deployments.InstantLayer.address),
		await readInstantConfiguration(
			ethers,
			report.deployments.InstantLayer.address,
			await ethers.provider.getBlockNumber(),
			snapshot.discovery ||
				report.rehearsalDiscovery || {
					deploymentTransactions: { [report.deployments.InstantLayer.address]: report.deployments.InstantLayer.deploymentTransaction },
				},
		),
	)
}

export async function planPartyBUpgrade(ethers: any, snapshot: any, report: any, retire = false) {
	const actions = []
	const instant = retire ? snapshot.gasless.instantLayer : report.deployments.InstantLayer.address
	for (const [partyB, rawAuthority] of Object.entries(snapshot.partyBAdmins)) {
		const authority = lower(rawAuthority as string)
		const contract = await ethers.getContractAt("SymmioPartyB", partyB)
		const { manager } = await readPartyBUpgradeAuthority(ethers, partyB, authority)
		const trusted = await contract.hasRole(ethers.id("TRUSTED_ROLE"), instant),
			allowed = await contract.multicastWhitelist(instant)
		if (allowed !== !retire && !manager)
			actions.push({
				authority,
				to: partyB,
				value: "0",
				data: contract.interface.encodeFunctionData("grantRole", [ethers.id("MANAGER_ROLE"), authority]),
				description: `Grant PartyB MANAGER_ROLE to ${authority} before updating the multicast whitelist`,
			})
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
		for (const [name, member] of [
			["CONFIG_ADMIN_ROLE", t.safe],
			["RELAYER_ROLE", t.relayer],
		]) {
			const role = ethers.id(name)
			if (!(await gasless.hasRole(role, member))) {
				const admin = await gasless.getRoleAdmin(role)
				if (!(await gasless.hasRole(admin, t.safe)))
					throw new Error(`Safe cannot grant GaslessLayer ${name}; provide the administrator for role ${admin}`)
				actions.push({
					authority: lower(t.safe),
					to: t.gaslessLayer,
					value: "0",
					data: gasless.interface.encodeFunctionData("grantRole", [role, member]),
					description: `Grant GaslessLayer ${name} to ${member}`,
				})
			}
		}
		const account = await ethers.getContractAt(diamondABI, t.accountLayer)
		if (!(await account.hasRole(t.gaslessLayer, ethers.id("ACCOUNT_CREATOR_ROLE"))))
			actions.push({
				authority: lower(t.safe),
				to: t.accountLayer,
				value: "0",
				data: account.interface.encodeFunctionData("grantRole", [t.gaslessLayer, ethers.id("ACCOUNT_CREATOR_ROLE")]),
				description: `Grant AccountLayer ACCOUNT_CREATOR_ROLE to GaslessLayer ${t.gaslessLayer}`,
			})
		const core = await ethers.getContractAt(
			[...diamondABI, "function isOperationalFeeCharger(address) view returns(bool)", "function registerOperationalFeeCharger(address)"],
			t.core,
		)
		if (!(await core.isOperationalFeeCharger(t.gaslessLayer))) {
			if (!(await core.hasRole(t.safe, ethers.id("FEE_ADMIN_ROLE"))))
				actions.push({
					authority: lower(t.safe),
					to: t.core,
					value: "0",
					data: core.interface.encodeFunctionData("grantRole", [t.safe, ethers.id("FEE_ADMIN_ROLE")]),
					description: "Grant Core FEE_ADMIN_ROLE to the Dev Safe for operational-fee charger registration",
				})
			actions.push({
				authority: lower(t.safe),
				to: t.core,
				value: "0",
				data: core.interface.encodeFunctionData("registerOperationalFeeCharger", [t.gaslessLayer]),
				description: `Register GaslessLayer ${t.gaslessLayer} as a Core operational-fee charger; preserve its current receiver`,
			})
		}
		const implementation = lower(`0x${(await ethers.provider.getStorage(t.gaslessLayer, IMPLEMENTATION_SLOT)).slice(-40)}`)
		const replacement = report.deployments.GaslessLayer.address
		if (!(await gasless.hasRole(ethers.ZeroHash, t.safe)))
			throw new Error("Safe lacks GaslessLayer upgrade authority; provide its current administrator")
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

export async function buildUpgradeClientHandoff(hre: any, input: any, report: any) {
	const gasless = await hre.artifacts.readArtifact("GaslessLayer")
	const instant = await hre.artifacts.readArtifact("InstantLayer")
	return {
		apiVersion: "operations.symm.io/gasless-client-upgrade-v2",
		chainId: 42161,
		inputDigest: digest(input),
		snapshotDigest: report.snapshotDigest,
		gaslessLayer: input.config.target.gaslessLayer,
		gaslessImplementation: report.deployments.GaslessLayer.address,
		instantLayer: report.deployments.InstantLayer.address,
		walletCreationFeePolicy: { requiredValue: "0", unit: "collateral token decimals", setDuringUpgrade: false },
		gaslessABI: gasless.abi,
		instantABI: instant.abi,
		instantSigningDomain: { name: "SymmioInstantLayer", version: "1", chainId: 42161, verifyingContract: report.deployments.InstantLayer.address },
		instructions: [
			"Stage the indexed-wallet ABI before the Gasless Safe cutover; activate it when that upgrade executes.",
			"relayInstantBatch requires walletIds with one entry per signed operation. Use 0 for InstantLayer operations and the original wallet.",
			"Wallet address, deposit settlement, recovery and fee/nonce reads now take wallet IDs. walletOperationNonces(owner, walletId, signerAccount) returns the last consumed nonce; use that value plus one.",
			"Wallet ID 0 keeps the original address and legacy nonce stream. Positive IDs use separate wallet addresses and nonces.",
			"Update event consumers for GaslessWalletDeployed, WalletDepositSettled, WalletNonCollateralTokenRecovered, WalletCreationFeeUpdated and WalletCreationFeeCollected using the attached ABI.",
			"Wallet creation fees remain disabled: the upgrade verifies slot 20 is zero and does not call setWalletCreationFee. The standalone deployment recipe's fee does not apply to this upgrade.",
			"previewFeeQuote is an estimate. Use quoteGaslessFee from scripts/gaslessLayer/fee-quote.ts in exact mode with the submitting relayer/admin as from and the intended native value; simulation returns FeeQuoteResult through a revert and must use eth_call.",
			"FeeQuote monetary fields and executeWithFeeLimit maxTotalDebit use 18 decimals. WalletCreationFeeUpdated/Collected and walletCreationFee use collateral token decimals. totalDebit includes collateral exchanged for native gas; totalFee excludes that exchanged principal.",
			"Fee quotes cover Gasless charges, excluding Core trading fees, bridge fees and transaction gas. Execute the same encoded action directly or through executeWithFeeLimit; the wrapper retains the underlying roles.",
			"Optional signed caps: set gaslessFeeLimitSalt before signing operation/delegation typed data; use signCappedNativeGasTopUp for capped top-ups. Existing untagged salts and legacy top-up signatures remain supported.",
			"Use the new InstantLayer address/domain and grant fresh user delegations; old InstantLayer delegations and replay state are not migrated.",
			"GaslessGateway wallet signatures continue to use the existing Gasless proxy domain and signed wallet target.",
		],
	}
}

export const accountInstantUpgradeTask = task(
	"internal:account-instant-upgrade",
	"Configuration-preserving AccountLayer and InstantLayer upgrade adapter",
)
	.addOption({ name: "phase", type: ArgumentType.STRING, defaultValue: "inspect" })
	.addOption({ name: "input", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "output", type: ArgumentType.STRING, defaultValue: "" })
	.setAction(async () => ({
		default: async ({ phase, input: inputFile, output }, hre) => {
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
			const mutates = phase === "deploy"
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
				if (phase === "client-handoff") {
					const handoff = await buildUpgradeClientHandoff(hre, input, report)
					write(path.join(path.dirname(output), "client-upgrade.json"), handoff)
					report.clientHandoffDigest = digest(handoff)
					return
				}
				const cut = await accountUpgradeCut(ethers, input, snapshot, report)
				if (phase === "plan-account-cut") {
					report.actions = cut
					return
				}
				if (cut.length) throw new Error("AccountLayer cut must be executed and verified first")
				if (phase === "verify-account-cut") return
				if (phase === "plan-configure-instant") {
					report.actions = await planInstantConfiguration(ethers, input, snapshot, report)
					return
				}
				await verifyReplacementInstant(ethers, snapshot, report)
				if (phase === "verify-instant") return
				if (phase === "plan-party-b") {
					report.actions = await planPartyBUpgrade(ethers, snapshot, report)
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
				if (phase === "plan-retire-party-b") {
					report.actions = await planPartyBUpgrade(ethers, snapshot, report, true)
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
	const local: any = {
		compatibility,
		transactions: [],
		rehearsalDiscovery: flowDiscovery(input.config),
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
	await execute(await planInstantConfiguration(ethers, input, snapshot, local))
	await verifyReplacementInstant(ethers, snapshot, local)
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
