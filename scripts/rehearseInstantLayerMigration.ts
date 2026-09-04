/**
 * Full rehearsal of scripts/migrateInstantLayer.ts on a fork of the target chain: real contracts,
 * real state, a hardhat-funded deployer, the Safe impersonated to execute the generated batches,
 * and a relayed one-signature delegation grant through the real GaslessLayer onto the new layer.
 *
 *   RPC_ARBITRUM=https://... npx hardhat run --no-compile scripts/rehearseInstantLayerMigration.ts --network fork-arbitrum
 *
 * Refuses to run against anything that is not a simulated (forked) network. Same address
 * overrides as migrateInstantLayer.ts, plus AFFILIATE_ACCOUNT_MANAGER (an AccountManager whose
 * addAccount creates a sub-account for the caller) and RELAYER (an address holding RELAYER_ROLE
 * on the GaslessLayer).
 */
import { JsonRpcProvider, TypedDataDomain } from "ethers"

import { loadDeploymentRecipe } from "../deployment-tooling/recipe.js"
import connection, { ethers, networkHelpers } from "../test/helpers/hardhat-connection.js"
import { cloneTypes } from "../test/helpers/instantLayerEIP712Types.js"
import { planAdditionalTemplates, roleHash, type RecipeTemplate, type SafeAction } from "./utils/instantLayerMigration.js"
import {
	checkInstantLayerWiring,
	executeSafeActions,
	findDeploymentBlock,
	snapshotInstantLayer,
	loadMigrationDefaults,
	migrateInstantLayer,
	simulateSafeActions,
	verifyInstantLayerReplacement,
} from "./utils/instantLayerMigrationRunner.js"

const DEFAULT_AFFILIATE_ACCOUNT_MANAGER: Record<string, string> = { "42161": "0x58bB5Bdc279321507DfB7AB54B9e7EF3DdA6E24D" }
const DEFAULT_RELAYER: Record<string, string> = { "42161": "0x999DA1bB819b50cc85de02D088E449351FDa8B78" }
const DEFAULT_TEMPLATES_RECIPE: Record<string, string> = { "42161": "deployment-recipes/arbitrum-vibe-production.json" }
const UPSTREAM_RPC_ENV: Record<string, string> = { "42161": "RPC_ARBITRUM", "8453": "RPC_BASE", "56": "RPC_BSC", "146": "RPC_SONIC" }

let failures = 0
function check(condition: boolean, label: string, detail = ""): void {
	console.log(`  ${condition ? "✔" : "✘"} ${label}${detail ? ` (${detail})` : ""}`)
	if (!condition) failures++
}

async function impersonated(address: string) {
	await networkHelpers.impersonateAccount(address)
	await networkHelpers.setBalance(address, 10n ** 20n)
	return ethers.getSigner(address)
}

async function executeAsSafe(safe: string, actions: SafeAction[]): Promise<void> {
	const signer = await impersonated(safe)
	const sent = await executeSafeActions(ethers, signer, actions, message => console.log(`    ${message}`))
	check(sent === actions.length, `admin sent every action (${sent}/${actions.length})`)
}

async function main(): Promise<void> {
	const network = await ethers.provider.getNetwork()
	const chainId = network.chainId
	const connectedType = (connection as any).networkConfig?.type
	if (connectedType !== "edr-simulated") {
		throw new Error(`Rehearsals run only on a simulated fork; connected network type is ${String(connectedType)}. Use --network fork-arbitrum.`)
	}
	const defaults = loadMigrationDefaults(chainId)
	const affiliate = process.env.AFFILIATE_ACCOUNT_MANAGER || DEFAULT_AFFILIATE_ACCOUNT_MANAGER[chainId.toString()]
	const relayer = process.env.RELAYER || DEFAULT_RELAYER[chainId.toString()]
	if (!affiliate || !relayer) throw new Error("Set AFFILIATE_ACCOUNT_MANAGER and RELAYER for this chain")

	const [deployer, user, sessionKey, secondDelegate] = await ethers.getSigners()
	const log = (message: string) => console.log(`    ${message}`)

	// Historical getCode through the fork simulator is unreliable, so the deployment block of the
	// old layer (the lower bound for event scans) is found against the upstream RPC directly.
	let fromBlock = process.env.SNAPSHOT_FROM_BLOCK ? Number(process.env.SNAPSHOT_FROM_BLOCK) : undefined
	if (fromBlock === undefined) {
		const upstreamEnv = UPSTREAM_RPC_ENV[chainId.toString()]
		const upstreamUrl = process.env.UPSTREAM_RPC_URL || process.env.SYMMIO_RPC_URL_OVERRIDE || (upstreamEnv ? process.env[upstreamEnv] : undefined)
		if (!upstreamUrl) {
			throw new Error(
				`Set SNAPSHOT_FROM_BLOCK, or export the upstream RPC (${upstreamEnv || "UPSTREAM_RPC_URL"}) so the deployment block can be located`,
			)
		}
		const upstream = new JsonRpcProvider(upstreamUrl, Number(chainId), { staticNetwork: true })
		fromBlock = await findDeploymentBlock(upstream, defaults.oldInstantLayer)
		console.log(`  Old layer deployed at block ${fromBlock} (located on the upstream RPC)`)
	}

	console.log(`InstantLayer migration rehearsal on a fork of chain ${chainId} (block ${await ethers.provider.getBlockNumber()})`)
	console.log(`  Deployer (hardhat): ${deployer.address}`)
	console.log(`  Safe (impersonated): ${defaults.safe}`)

	// ── Deployer phase ──
	const templatesRecipe = process.env.TEMPLATES_RECIPE || DEFAULT_TEMPLATES_RECIPE[chainId.toString()]
	const recipeTemplates: RecipeTemplate[] | undefined =
		templatesRecipe && templatesRecipe !== "none"
			? ((loadDeploymentRecipe(templatesRecipe) as any).recipe ?? loadDeploymentRecipe(templatesRecipe)).core.protocol.instantLayerTemplates
			: undefined
	const oldTemplates = (await snapshotInstantLayer(ethers, defaults.oldInstantLayer, { fromBlock })).templates
	const additionalTemplates = recipeTemplates ? planAdditionalTemplates(oldTemplates, recipeTemplates) : []
	console.log(`  Templates: ${oldTemplates.length} replayed from the old layer, ${additionalTemplates.length} added from ${templatesRecipe}`)

	console.log("\n1. Deployer phase")
	const result = await migrateInstantLayer({
		ethers,
		deployer,
		oldInstantLayer: defaults.oldInstantLayer,
		safe: defaults.safe,
		gaslessLayer: defaults.gaslessLayer,
		gaslessLibraries: defaults.libraries,
		fromBlock,
		additionalTemplates,
		log,
	})
	check(result.snapshot.registeredPartyBs.length > 0, "old layer snapshot found registered PartyBs", result.snapshot.registeredPartyBs.join(", "))
	const freshLayer = await ethers.getContractAt("InstantLayer", result.newInstantLayer)
	for (const partyB of result.snapshot.registeredPartyBs)
		check(await freshLayer.registeredPartyBs(partyB), `PartyB registered on the new layer: ${partyB}`)
	check(result.snapshot.whitelistedTargets.length >= 2, "old layer snapshot found whitelisted targets", result.snapshot.whitelistedTargets.join(", "))
	check(
		result.cutoverActions.some(a => a.description.includes("TRUSTED_ROLE")),
		"cutover batch carries the PartyB actions",
	)
	console.log(`  New InstantLayer:            ${result.newInstantLayer}`)
	console.log(`  GaslessLayer implementation: ${result.newGaslessImplementation}`)
	console.log(`  Transactions sent:           ${result.transactionsSent}`)
	const again = await migrateInstantLayer({
		ethers,
		deployer,
		oldInstantLayer: defaults.oldInstantLayer,
		safe: defaults.safe,
		gaslessLayer: defaults.gaslessLayer,
		gaslessLibraries: defaults.libraries,
		state: result.state,
		fromBlock,
		additionalTemplates,
		log: () => {},
	})
	check(again.transactionsSent === 0 && again.newInstantLayer === result.newInstantLayer, "re-run is a no-op with the state file")

	console.log("\n2. Replacement verification")
	const replacement = await verifyInstantLayerReplacement(ethers, {
		oldSnapshot: result.expectedSnapshot,
		newInstantLayer: result.newInstantLayer,
		safe: defaults.safe,
		deployer: deployer.address,
		gaslessLayer: defaults.gaslessLayer,
	})
	check(
		replacement.ok,
		"new layer matches the old configuration plus recipe templates, admin holds every role, deployer holds none",
		replacement.findings.join("; "),
	)
	const expectedCount = oldTemplates.length + additionalTemplates.length
	check(Number(await freshLayer.nextTemplateId()) === expectedCount, `new layer has ${expectedCount} templates`)
	for (const t of additionalTemplates) {
		const onChain = await freshLayer.getTemplate(t.id)
		const last = onChain.operations.at(-1)
		check(
			onChain.name === t.name &&
				(await freshLayer.templateInstantOpenMode(t.id)) === t.instantOpenMode &&
				[...last.insertionPoints].map(String).join() === t.operations.at(-1)!.insertionPoints.map(String).join(),
			`template ${t.id} ${t.name}${t.instantOpenMode ? " (instant-open)" : ""} on the new layer`,
		)
	}

	// ── Safe batch 1 ──
	console.log("\n3. Admin cutover")
	const cutoverSim = await simulateSafeActions(ethers, defaults.safe, result.cutoverActions)
	check(
		cutoverSim.every(s => s.ok),
		"every cutover action simulates from the admin",
		cutoverSim
			.filter(s => !s.ok)
			.map(s => s.error)
			.join("; "),
	)
	await executeAsSafe(defaults.safe, result.cutoverActions)
	const partyBs = result.snapshot.registeredPartyBs
	const newWiring = await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: result.newInstantLayer })
	check(
		newWiring.ok,
		"new layer fully bound",
		newWiring.bindings
			.filter(b => !b.ok)
			.map(b => b.label)
			.join(", "),
	)
	const oldWiring = await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: defaults.oldInstantLayer })
	check(
		oldWiring.bindings.filter(b => !b.label.startsWith("gasless")).every(b => b.ok) &&
			oldWiring.bindings.filter(b => b.label.startsWith("gasless")).every(b => !b.ok),
		"old layer keeps core/AccountLayer/PartyB bindings during the transition, gateway no longer points at it",
	)
	const gateway: any = await ethers.getContractAt("GaslessLayer", defaults.gaslessLayer)
	check((await gateway.instantLayer()).toLowerCase() === result.newInstantLayer.toLowerCase(), "GaslessLayer.instantLayer() is the new layer")
	const implementationSlot = await ethers.provider.getStorage(
		defaults.gaslessLayer,
		"0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
	)
	check(
		("0x" + implementationSlot.slice(26)).toLowerCase() === result.newGaslessImplementation.toLowerCase(),
		"GaslessLayer proxy runs the new implementation",
	)
	check(
		(await gateway.depositFee()) > 0n && (await gateway.treasury()) !== ethers.ZeroAddress,
		"GaslessLayer storage intact after upgrade (depositFee, treasury readable)",
	)

	// ── Functional: one wallet signature through the real gateway onto the new layer ──
	console.log("\n4. Relayed one-signature setup on the new layer")
	const accountManager: any = await ethers.getContractAt("contracts/accountLayer/AccountManager.sol:AccountManager", affiliate)
	const [subAccount] = await accountManager.connect(user).addAccount.staticCall("il-migration-rehearsal")
	await (await accountManager.connect(user).addAccount("il-migration-rehearsal")).wait()
	const alView = await ethers.getContractAt(["function ownerOf(address) view returns (address)"], defaults.accountLayer)
	check((await alView.ownerOf(subAccount)).toLowerCase() === user.address.toLowerCase(), "fresh sub-account owned by the rehearsal user", subAccount)

	const newLayer = await ethers.getContractAt("InstantLayer", result.newInstantLayer)
	const oldLayer = await ethers.getContractAt("InstantLayer", defaults.oldInstantLayer)
	const core = await ethers.getContractAt("contracts/core/facets/Binding/BindingFacet.sol:BindingFacet", defaults.core)
	const bindSelector = core.interface.getFunction("bindToPartyB")!.selector
	const accountFacet = await ethers.getContractAt("contracts/core/facets/Account/AccountFacet.sol:AccountFacet", defaults.core)
	const approveSelector = accountFacet.interface.getFunction("approveOperationalFee")!.selector
	const latest = await ethers.provider.getBlock("latest")
	const now = BigInt(latest!.timestamp)
	const domain: TypedDataDomain = { name: "SymmioInstantLayer", version: "1", chainId, verifyingContract: result.newInstantLayer }
	const grantOp = {
		signer: user.address,
		target: result.newInstantLayer,
		callData: newLayer.interface.encodeFunctionData("grantDelegations", [
			[
				{
					account: { addr: subAccount, isPartyB: false },
					delegatedSigner: sessionKey.address,
					selectors: [approveSelector, bindSelector],
					expiryTimestamp: now + 3600n,
				},
				{
					account: { addr: subAccount, isPartyB: false },
					delegatedSigner: secondDelegate.address,
					selectors: [bindSelector],
					expiryTimestamp: now + 86400n,
				},
			],
		]),
		signerAccount: { addr: subAccount, isPartyB: false },
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce: 0n, deadline: now + 600n, salt: ethers.hexlify(ethers.randomBytes(32)) },
	}
	const grantSig = await user.signTypedData(domain, cloneTypes(), grantOp)
	check(await gateway.hasRole(roleHash("RELAYER_ROLE"), relayer), "relayer holds RELAYER_ROLE on the GaslessLayer", relayer)
	const relayerSigner = await impersonated(relayer)
	console.log(`    defaultSelectorFee on the gateway: ${await gateway.defaultSelectorFee()}`)
	try {
		const relayTx = await gateway.connect(relayerSigner).relayInstantBatch([grantOp], [grantSig], [[]], [[]])
		const receipt = await relayTx.wait()
		check(receipt?.status === 1, "relayInstantBatch with one owner signature succeeded on the new layer")
	} catch (error: any) {
		check(
			false,
			"relayInstantBatch with one owner signature succeeded on the new layer",
			(error?.shortMessage || error?.message || String(error)).slice(0, 200),
		)
	}
	check(await newLayer.isDelegationActive(subAccount, sessionKey.address, approveSelector), "session key delegated on the new layer")
	check(await newLayer.isDelegationActive(subAccount, secondDelegate.address, bindSelector), "second delegate delegated on the new layer")
	check(!(await oldLayer.isDelegationActive(subAccount, sessionKey.address, approveSelector)), "old layer untouched by the relayed grant")

	// ── Safe batch 2 ──
	console.log("\n5. Admin decommission")
	const decommissionSim = await simulateSafeActions(ethers, defaults.safe, result.decommissionActions)
	check(
		decommissionSim.every(s => s.ok),
		"every decommission action simulates from the admin",
		decommissionSim
			.filter(s => !s.ok)
			.map(s => s.error)
			.join("; "),
	)
	await executeAsSafe(defaults.safe, result.decommissionActions)
	const oldGone = await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: defaults.oldInstantLayer })
	check(
		oldGone.bindings.every(b => !b.ok),
		"old layer fully unbound",
	)
	const newStill = await checkInstantLayerWiring(ethers, { ...defaults, partyBs, instantLayer: result.newInstantLayer })
	check(newStill.ok, "new layer still fully bound")

	console.log(`\nRehearsal ${failures === 0 ? "PASSED" : `FAILED with ${failures} failing check(s)`}`)
	if (failures > 0) process.exitCode = 1
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
