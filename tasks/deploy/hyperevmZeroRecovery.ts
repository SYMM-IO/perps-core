import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { AbiCoder, Contract, ZeroAddress, getCreateAddress, id, keccak256, toBeHex, formatUnits } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import fs from "node:fs"
import path from "node:path"

import {
	ABI,
	ARTIFACT,
	TARGET,
	ROLE,
	SELECTOR,
	digest,
	iface,
	json,
	planCut,
	recoveryEvent,
	recoveryAction,
	requireValidation,
	requireRecipientConfirmation,
	sameAddress,
	selectorMap,
	validateInput,
} from "../../deployment-tooling/hyperevm-zero-recovery.js"
import { atomicWriteFile } from "../utils/fs.js"
import { acquireCheckpointLock, setCheckpointSimulated } from "./checkpoint.js"
import { completeGovernanceTransactionRequest } from "./governanceActions.js"
import { send } from "./tx.js"

const globalSlot = BigInt(id("diamond.standard.storage.global"))
const coder = AbiCoder.defaultAbiCoder()
export const balanceSlot = (address: string) => keccak256(coder.encode(["address", "bytes32"], [address, id("diamond.standard.storage.account")]))
const write = (file: string, value: any) => atomicWriteFile(file, json(value) + "\n", 0o600)
const check = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message)
}
const action = (method: string, args: any[]) => ({ to: TARGET.core, value: "0", data: iface.encodeFunctionData(method, args) })
const coreAt = (provider: any) => new Contract(TARGET.core, ABI, provider)

export async function recoverySnapshot(provider: any, blockTag: number | string = "latest") {
	const core = coreAt(provider),
		at = { blockTag }
	const start = await provider.getBlock(blockTag)
	check(start?.hash, "Missing snapshot block")
	const [owner, collateral, safeRole, admin, facets, zero, recipient, packed, signer, safeCode, threshold, owners, decimals] = await Promise.all([
		core.owner(at),
		core.getCollateral(at),
		core.hasRole(TARGET.recipient, ROLE, at),
		core.isRoleAdmin(TARGET.owner, ROLE, at),
		core.facets(at),
		core.balanceOf(ZeroAddress, at),
		core.balanceOf(TARGET.recipient, at),
		provider.getStorage(TARGET.core, globalSlot + 1n, blockTag),
		provider.getStorage(TARGET.core, globalSlot + 10n, blockTag),
		provider.getCode(TARGET.recipient, blockTag),
		new Contract(
			TARGET.recipient,
			["function getThreshold() view returns(uint256)", "function getOwners() view returns(address[])"],
			provider,
		).getThreshold(at),
		new Contract(TARGET.recipient, ["function getOwners() view returns(address[])"], provider).getOwners(at),
		new Contract(TARGET.collateral, ["function decimals() view returns(uint8)"], provider).decimals(at),
	])
	check(
		sameAddress(owner, TARGET.owner) && sameAddress(collateral, TARGET.collateral),
		"Core owner or collateral differs from the reviewed v0.8.5 target",
	)
	check(admin, "Reviewed owner is not the recovery role admin")
	check(safeCode !== "0x" && threshold > 0n && threshold <= BigInt(owners.length), "Recipient is not a configured Safe")
	check(decimals === 6n, "Unexpected collateral decimals")
	const selectors = selectorMap(facets)
	const codeHashes: Record<string, string> = {}
	for (const address of new Set(Object.values(selectors))) codeHashes[address] = keccak256(await provider.getCode(address, blockTag))
	return {
		blockNumber: start.number,
		blockHash: start.hash,
		observedThroughBlock: await provider.getBlockNumber(),
		historical: typeof blockTag === "number",
		owner,
		collateral,
		safeRole,
		admin,
		threshold: threshold.toString(),
		owners: [...owners],
		selectors,
		codeHashes,
		zero: zero.toString(),
		recipient: recipient.toString(),
		packed: packed.toLowerCase(),
		signer: toBeHex(BigInt(signer) & ((1n << 160n) - 1n), 20),
		globalPaused: Boolean((BigInt(packed) >> 160n) & 255n),
		accountingPaused: Boolean((BigInt(packed) >> 176n) & 255n),
	}
}
export function requireOperational(snapshot: any) {
	check(!snapshot.globalPaused && !snapshot.accountingPaused, "Core is paused; this task does not unpause it")
	check(sameAddress(snapshot.signer, ZeroAddress), "Core persistent signer is active")
}
function requireBaseline(report: any, snapshot: any, facet = ZeroAddress) {
	planCut(report.baseline.selectors, snapshot.selectors, facet)
	for (const [a, h] of Object.entries(report.baseline.codeHashes)) check(snapshot.codeHashes[a] === h, `Baseline facet runtime changed: ${a}`)
	check(snapshot.packed === report.baseline.packed && snapshot.signer === report.baseline.signer, "Core pause/fee-collector or signer state drifted")
}
async function runtime(provider: any, artifact: any, address: string) {
	check(
		(await provider.getCode(address)).toLowerCase() === artifact.deployedBytecode.toLowerCase(),
		"Recovery runtime does not match the isolated v0.8.18 artifact",
	)
}
export async function artifactFor(hre: any) {
	const artifact = await hre.artifacts.readArtifact(ARTIFACT)
	const buildId = await hre.artifacts.getBuildInfoId(ARTIFACT)
	const file = buildId && (await hre.artifacts.getBuildInfoPath(buildId))
	check(file, "Recovery build provenance is missing; compile the isolated configuration")
	const build = JSON.parse(fs.readFileSync(file, "utf8")),
		settings = build.input.settings
	check(
		build.solcVersion === "0.8.18" &&
			settings.evmVersion === "paris" &&
			settings.viaIR === true &&
			settings.optimizer.enabled &&
			settings.optimizer.runs === 200 &&
			settings.metadata.bytecodeHash === "none",
		"Wrong compiler settings for v0.8.5 recovery",
	)
	for (const source of ["GlobalAppStorage085.sol", "ZeroBalanceRecoveryFacet085.sol"]) {
		const name = `contracts/patches/hyperevm-v085/${source}`
		const key = build.userSourceNameMap[name] || Object.keys(build.input.sources).find(k => k.endsWith(name))
		check(key && build.input.sources[key].content === fs.readFileSync(name, "utf8"), "Recovery artifact source is stale")
	}
	const outputFile = await hre.artifacts.getBuildInfoOutputPath(buildId)
	const output = JSON.parse(fs.readFileSync(outputFile, "utf8"))
	const sourceKey = build.userSourceNameMap[artifact.sourceName] || artifact.sourceName
	const built = (output.output || output).contracts[sourceKey][artifact.contractName].evm
	check(
		artifact.bytecode === "0x" + built.bytecode.object && artifact.deployedBytecode === "0x" + built.deployedBytecode.object,
		"Recovery artifact differs from compiler output",
	)
	return artifact
}

export async function archiveProbe(provider: any, blockNumber: number) {
	check(Number((await provider.getNetwork()).chainId) === TARGET.chainId, "Archive endpoint is not HyperEVM")
	const block = await provider.getBlock(blockNumber)
	check(
		block?.hash && (await provider.getCode(TARGET.core, 1)) === "0x",
		"RPC does not honor historical state (Core must not exist at block 1); configure a real archive endpoint",
	)
	check((await provider.getCode(TARGET.core, blockNumber)) !== "0x", "Archive endpoint cannot serve the rehearsal block")
	return block
}

export async function rehearseRecovery(hre: any, report: any, input: any, artifact: any) {
	// Never enable impersonation or storage mutation on an HTTP network.
	const live = await hre.network.create("recovery-archive")
	try {
		const pinned = report.archive
		const block = await archiveProbe(live.ethers.provider, pinned.blockNumber)
		check(block.hash === pinned.blockHash, "Archive rehearsal block changed")
		const fork = await hre.network.create("recovery-fork")
		try {
			check(
				fork.networkConfig.type === "edr-simulated" && fork.networkConfig.forking?.blockNumber === pinned.blockNumber,
				"Rehearsal requires the pinned local fork",
			)
			const { ethers, networkHelpers: nh } = fork,
				provider = ethers.provider
			const before = await recoverySnapshot(provider)
			requireOperational(before)
			requireBaseline(report, before)
			check(before.zero === pinned.snapshot.zero && before.recipient === pinned.snapshot.recipient, "Fork balances differ from archive snapshot")
			check(BigInt(before.zero) > 0n, "No zero-address balance to rehearse")
			const owner = await ethers.getImpersonatedSigner(TARGET.owner),
				safe = await ethers.getImpersonatedSigner(TARGET.recipient)
			await nh.setBalance(TARGET.owner, 10n ** 20n)
			await nh.setBalance(TARGET.recipient, 10n ** 20n)
			const [deployer, attacker, legacyUser, legacyRecipient] = await ethers.getSigners()
			const deployment = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy()
			await deployment.waitForDeployment()
			const facet = await deployment.getAddress()
			for (const a of planCut(report.baseline.selectors, before.selectors, facet)) await (await owner.sendTransaction(a)).wait()
			const core: any = coreAt(provider),
				privileged: any = core.connect(owner),
				recovery: any = core.connect(safe)
			if (!before.safeRole) await (await privileged.grantRole(TARGET.recipient, ROLE)).wait()
			const checks: string[] = []
			const mustRevert = async (name: string, promise: Promise<any>, reason: string) => {
				let error: any
				try {
					await promise
				} catch (e) {
					error = e
				}
				check(
					error?.code === "CALL_EXCEPTION" && String(error.reason || error.shortMessage || error.message).includes(reason),
					`Expected ${name} revert: ${reason}`,
				)
				checks.push(name)
			}
			await mustRevert("unauthorized", core.connect(attacker).recoverZeroAddressBalance.staticCall(TARGET.recipient), "Must have role")
			for (const [name, offset, reason] of [
				["accounting-pause", 22, "Accounting paused"],
				["global-pause", 20, "Global paused"],
			] as const) {
				await nh.setStorageAt(TARGET.core, globalSlot + 1n, BigInt(before.packed) | (1n << BigInt(offset * 8)))
				await mustRevert(name, recovery.recoverZeroAddressBalance.staticCall(TARGET.recipient), reason)
				await nh.setStorageAt(TARGET.core, globalSlot + 1n, BigInt(before.packed))
			}
			const originalSigner = await provider.getStorage(TARGET.core, globalSlot + 10n)
			await nh.setStorageAt(TARGET.core, globalSlot + 10n, (BigInt(originalSigner) & ~((1n << 160n) - 1n)) | BigInt(attacker.address))
			await mustRevert("proxy-guard", recovery.recoverZeroAddressBalance.staticCall(TARGET.recipient), "Cannot call via proxy")
			await nh.setStorageAt(TARGET.core, globalSlot + 10n, originalSigner)
			await mustRevert("zero-recipient", recovery.recoverZeroAddressBalance.staticCall(ZeroAddress), "Zero recipient")
			const unrelatedBefore = await core.balanceOf(TARGET.owner)
			const token = new Contract(TARGET.collateral, ["function balanceOf(address) view returns(uint256)"], provider)
			const tokensBefore = await token.balanceOf(TARGET.core)
			const tx = await recovery.recoverZeroAddressBalance(TARGET.recipient),
				receipt = await tx.wait()
			const evidence = recoveryEvent(receipt)
			check(evidence.amount === before.zero && evidence.recipientBefore === before.recipient, "Recovery event differs from fork prestate")
			check(
				(await core.balanceOf(ZeroAddress)) === 0n && (await core.balanceOf(TARGET.recipient)) === BigInt(before.recipient) + BigInt(before.zero),
				"Fork balances do not conserve the full raw amount",
			)
			check(
				(await core.balanceOf(TARGET.owner)) === unrelatedBefore && (await token.balanceOf(TARGET.core)) === tokensBefore,
				"Unrelated balance or Core collateral changed",
			)
			checks.push("exact-balance")
			const trace = await provider.send("debug_traceTransaction", [tx.hash, { disableMemory: true, disableStorage: true }])
			const slots = trace.structLogs
				.filter((s: any) => s.op === "SSTORE")
				.map((s: any) => {
					const v = s.stack.at(-1)
					return toBeHex(BigInt(v.startsWith("0x") ? v : "0x" + v), 32)
				})
				.sort()
			check(
				json(slots) === json([balanceSlot(ZeroAddress), balanceSlot(TARGET.recipient)].sort()),
				"Recovery wrote storage outside the two intended balance slots",
			)
			checks.push("two-storage-writes")
			await mustRevert("repeat-recovery", recovery.recoverZeroAddressBalance.staticCall(TARGET.recipient), "Empty balance")
			check(planCut(report.baseline.selectors, selectorMap(await core.facets()), facet).length === 0, "Selectors changed")
			checks.push("unchanged-selectors")
			// Synthetic balance and role grant exist only on this fork; exercise the untouched deployed AccountFacet.
			await (await privileged.grantRole(TARGET.owner, id("SUSPENDER_ROLE"))).wait()
			await (await privileged.suspendedAddress(legacyUser.address)).wait()
			await nh.setStorageAt(TARGET.core, balanceSlot(legacyUser.address), 1234567n * 10n ** 12n + 1n)
			const oldRecipient = await core.balanceOf(legacyRecipient.address)
			await (await recovery.withdrawSuspendedUserFunds(legacyUser.address, legacyRecipient.address, 1234567n)).wait()
			check(
				(await core.balanceOf(legacyUser.address)) === 1n && (await core.balanceOf(legacyRecipient.address)) === oldRecipient + 1234567n * 10n ** 12n,
				"Legacy suspended-account recovery changed",
			)
			checks.push("legacy-suspended-recovery")
			report.rehearsal = {
				passed: true,
				inputDigest: digest(input),
				runtimeHash: keccak256(artifact.deployedBytecode),
				archiveVerified: true,
				blockNumber: pinned.blockNumber,
				blockHash: pinned.blockHash,
				checks,
				evidence,
				localRecoveryTransaction: tx.hash,
				syntheticState:
					"Local owner/Safe impersonation and gas funding; pause/signer guard mutations; unrelated legacy account balance and suspender role. None broadcast.",
			}
		} finally {
			await fork.close()
		}
	} finally {
		await live.close()
	}
}

// Persist the exact nonce/intent BEFORE signing. A crash without a hash is deliberately not retried.
// The operator supplies the original/replacement hash; calldata, sender, nonce and receipt must all match.
export async function submitRecoveryOperation(
	provider: any,
	signer: any,
	report: any,
	label: string,
	request: any,
	save: () => void,
	suppliedHash?: string,
) {
	const from = await signer.getAddress()
	const intent = { from, to: request.to || null, data: request.data, value: String(request.value || 0), chainId: TARGET.chainId }
	report.operations ||= {}
	let op = report.operations[label]
	if (op) check(digest(op.intent) === digest(intent), `Saved ${label} transaction intent changed`)
	else {
		const completed = await completeGovernanceTransactionRequest(provider, { ...request, from })
		op = report.operations[label] = { intent, nonce: await provider.getTransactionCount(from, "pending"), status: "prepared" }
		save()
		// Only this newly-created intent may broadcast. Prepared intents on resume must be reconciled.
		let response
		try {
			response = await signer.sendTransaction({ ...completed, nonce: op.nonce, chainId: TARGET.chainId })
		} catch (error: any) {
			if (error?.code === "ACTION_REJECTED") {
				delete report.operations[label]
				save()
			}
			throw error
		}
		op.hash = response.hash
		op.status = "submitted"
		save()
		const mined = await send(Promise.resolve(response), `recovery ${label}`, 1, {
			onSubmitted: record => {
				op.journal = record
				save()
			},
		})
		op.hash = mined.hash
		save()
	}
	const hash = suppliedHash || op.hash
	check(hash, `Interrupted ${label} intent at nonce ${op.nonce}; supply its transaction hash for reconciliation. No automatic resend.`)
	const tx = await provider.getTransaction(hash),
		receipt = await provider.getTransactionReceipt(hash)
	check(
		tx &&
			sameAddress(tx.from, from) &&
			(intent.to ? sameAddress(tx.to, intent.to) : tx.to === null) &&
			tx.data.toLowerCase() === intent.data.toLowerCase() &&
			tx.value === BigInt(intent.value) &&
			tx.nonce === op.nonce &&
			Number(tx.chainId) === TARGET.chainId,
		"Transaction does not match the saved recovery operation",
	)
	check(receipt && receipt.status === 1, "Transaction is pending, missing or reverted; do not resend automatically")
	check((await provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash, "Transaction receipt is not on the canonical chain")
	op.hash = hash
	op.status = "confirmed"
	op.blockNumber = receipt.blockNumber
	op.blockHash = receipt.blockHash
	op.transactionIndex = receipt.index
	if (op.journal) {
		op.journal.status = "confirmed"
		op.journal.replacementHash = hash === op.journal.hash ? undefined : hash
	}
	save()
	return receipt
}

export const hyperevmZeroRecoveryTask = task("internal:hyperevm-zero-recovery", "Isolated v0.8.5 recovery workflow")
	.addOption({ name: "phase", type: ArgumentType.STRING, defaultValue: "inspect" })
	.addOption({ name: "input", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "output", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "transaction", type: ArgumentType.STRING, defaultValue: "" })
	.setAction(async () => ({
		default: async (args: any, hre: any) => {
			const input = JSON.parse(fs.readFileSync(args.input, "utf8"))
			validateInput(input, process.cwd())
			check(
				process.env.SYMMIO_RECOVERY_RPC_KEY === input.rpcKey && (process.env.SYMMIO_RECOVERY_ARCHIVE_KEY || undefined) === input.archiveRpcKey,
				"RPC references differ from task input",
			)
			setCheckpointSimulated(false)
			const lock = acquireCheckpointLock(TARGET.chainId, `zero-recovery-${digest(input).slice(0, 16)}`)
			const report = fs.existsSync(args.output) ? JSON.parse(fs.readFileSync(args.output, "utf8")) : { schema: 1, inputDigest: digest(input) }
			const save = () => write(args.output, report)
			try {
				check(report.inputDigest === digest(input), "Recovery report input changed")
				const artifact = await artifactFor(hre)
				if (args.phase === "rehearse") {
					check(input.forkEnabled, "Fork rehearsal was not requested for this task")
					await rehearseRecovery(hre, report, input, artifact)
					return
				}
				const connection = await hre.network.getOrCreate(),
					provider = connection.ethers.provider
				check(
					connection.networkConfig.type === "http" &&
						connection.networkName === "hyperevm" &&
						Number((await provider.getNetwork()).chainId) === TARGET.chainId,
					"Live phases require the explicit HyperEVM network",
				)
				if (args.phase === "reconcile") {
					for (const [label, op] of Object.entries(report.operations || {}) as any) {
						await submitRecoveryOperation(
							provider,
							{ getAddress: async () => op.intent.from },
							report,
							label,
							op.intent,
							save,
							args.transaction && op.status !== "confirmed" ? args.transaction : undefined,
						)
					}
					return
				}
				const snapshot = await recoverySnapshot(provider)
				requireOperational(snapshot)
				if (args.phase === "inspect") {
					check(BigInt(snapshot.zero) > 0n, "Zero-address balance is empty; no recovery deployment is needed")
					if (!report.baseline) {
						check(!snapshot.selectors[SELECTOR], "Recovery is already installed; resume the original task")
						report.baseline = snapshot
					}
					requireBaseline(report, snapshot, report.facet)
					if (input.forkEnabled) {
						const archive = await hre.network.create("recovery-archive")
						try {
							const block = await archiveProbe(archive.ethers.provider, snapshot.blockNumber)
							const historical = await recoverySnapshot(archive.ethers.provider, block.number)
							requireOperational(historical)
							requireBaseline(report, historical)
							check(block.hash === snapshot.blockHash, "Live and archive endpoints disagree about chain history")
							report.archive = { blockNumber: block.number, blockHash: block.hash, snapshot: historical }
						} finally {
							await archive.close()
						}
					}

					return
				}
				requireRecipientConfirmation(report.recipientConfirmation)
				requireValidation(report, input, artifact)
				requireBaseline(report, snapshot, report.facet)
				const liveOperation = async (label: string, request: any, owner = false) => {
					check(
						process.env.SYMMIO_RECOVERY_EXECUTE === "true" && process.env.CONFIRM_CHAIN_ID === "999",
						"Explicit HyperEVM execution authorization is required",
					)
					const [signer] = await connection.ethers.getSigners()
					check(signer, "No explicitly selected signer")
					const address = await signer.getAddress()
					if (owner) check(sameAddress(address, TARGET.owner), "This operation requires the reviewed Core owner / role admin")
					if (process.env.SYMMIO_EXPECTED_SIGNER) check(sameAddress(address, process.env.SYMMIO_EXPECTED_SIGNER), "Selected signer address mismatch")
					return submitRecoveryOperation(provider, signer, report, label, request, save, args.transaction)
				}
				if (args.phase === "deploy") {
					check(BigInt(snapshot.zero) > 0n, "Zero-address balance emptied before deployment; review before proceeding")
					const receipt = await liveOperation("deploy", { data: artifact.bytecode, value: 0n })
					report.facet = receipt.contractAddress
					check(
						report.facet && sameAddress(report.facet, getCreateAddress({ from: receipt.from, nonce: report.operations.deploy.nonce })),
						"Unexpected deployed facet address",
					)
					await runtime(provider, artifact, report.facet)
					return
				}
				check(report.facet, "Deploy the recovery facet first")
				await runtime(provider, artifact, report.facet)
				if (args.phase === "publish") {
					await verifyContract({ address: report.facet, constructorArgs: [], contract: ARTIFACT, provider: "etherscan" }, hre)
					report.published = { address: report.facet, runtimeHash: keccak256(artifact.deployedBytecode), verifiedAt: new Date().toISOString() }
					return
				}
				check(report.published?.address === report.facet, "Explorer publication must succeed before governance")
				if (args.phase === "cut") {
					const actions = planCut(report.baseline.selectors, snapshot.selectors, report.facet)
					if (!actions.length) check(report.operations?.cut, "Recovery installed outside this task; reconciliation required")
					const cut =
						actions[0] || action("diamondCut", [[{ facetAddress: report.facet, action: 0, functionSelectors: [SELECTOR] }], ZeroAddress, "0x"])
					await liveOperation("cut", cut, true)
					check(
						planCut(report.baseline.selectors, selectorMap(await coreAt(provider).facets()), report.facet).length === 0,
						"Cut receipt succeeded but selector verification failed",
					)
					return
				}
				check(planCut(report.baseline.selectors, snapshot.selectors, report.facet).length === 0, "Recovery selector is not installed")
				check(report.operations?.cut?.status === "confirmed", "Reconcile this task's upgrade receipt first")
				if (args.phase === "grant") {
					if (report.baseline.safeRole) {
						check(snapshot.safeRole, "The Safe's preexisting recovery role was revoked outside this task")
						return
					}
					if (snapshot.safeRole && !report.operations?.grant)
						throw new Error("Recovery role granted outside this task; review its ownership before proceeding")
					await liveOperation("grant", action("grantRole", [TARGET.recipient, ROLE]), true)
					check(await coreAt(provider).hasRole(TARGET.recipient, ROLE), "Role grant not reflected on Core")
					report.temporaryRole = true
					return
				}
				if (args.phase === "plan-recovery") {
					check(!report.recovery, "Recovery was already verified; never export another sweep")
					check(
						snapshot.safeRole && BigInt(snapshot.zero) > 0n,
						"Safe lacks recovery role or zero-address balance is empty; reconcile any prior transaction",
					)
					const tx = recoveryAction()
					const result = await provider.call({ ...tx, from: TARGET.recipient })
					check(BigInt(iface.decodeFunctionResult("recoverZeroAddressBalance", result)[0]) > 0n, "Recovery simulation returned no balance")
					report.preview = { snapshot, action: tx, note: "Sweeps the full raw balance at execution; this preview can change as funds accrue" }
					return
				}
				if (args.phase === "verify-recovery") {
					const hash = args.transaction || report.recovery?.transactionHash
					check(/^0x[0-9a-fA-F]{64}$/.test(hash || ""), "Supply the executed Safe transaction hash")
					check(!report.recovery || report.recovery.transactionHash.toLowerCase() === hash.toLowerCase(), "Recovery transaction changed")
					const receipt = await provider.getTransactionReceipt(hash)
					check(receipt && (await provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash, "Recovery receipt missing or noncanonical")
					const evidence = recoveryEvent(receipt)
					const cut = report.operations.cut
					check(
						receipt.blockNumber > cut.blockNumber || (receipt.blockNumber === cut.blockNumber && receipt.index > cut.transactionIndex),
						"Recovery predates this verified upgrade",
					)
					if (input.forkEnabled) {
						const archive = await hre.network.create("recovery-archive")
						try {
							const historical = coreAt(archive.ethers.provider)
							check(
								(await archive.ethers.provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash,
								"Archive does not agree with recovery receipt",
							)
							check(
								sameAddress(await historical.facetAddress(SELECTOR, { blockTag: receipt.blockNumber }), report.facet),
								"Recovery facet differs at execution block",
							)
							check(
								(await archive.ethers.provider.getCode(report.facet, receipt.blockNumber)).toLowerCase() === artifact.deployedBytecode.toLowerCase(),
								"Recovery runtime differs at execution block",
							)
						} finally {
							await archive.close()
						}
					}

					check(
						snapshot.zero === "0" && snapshot.recipient === evidence.recipientAfter,
						"Current balances differ from the recovery event; investigate intervening activity before final verification",
					)
					report.recovery = {
						...evidence,
						transactionHash: hash,
						blockNumber: receipt.blockNumber,
						blockHash: receipt.blockHash,
						observed: snapshot,
						amountFormatted: formatUnits(evidence.amount, 18),
						recipient: TARGET.recipient,
						proof: "Event-derived transaction-atomic before/after amounts, reconciled with fresh Core balances and current runtime",
						historicalRuntimeVerified: input.forkEnabled,
					}
					return
				}
				if (args.phase === "cleanup") {
					check(report.recovery, "Recovery evidence required before role cleanup")
					if (report.temporaryRole) {
						check(
							!report.baseline.safeRole && report.operations.grant?.status === "confirmed",
							"Cannot revoke a role that this run did not temporarily grant",
						)
						if (snapshot.safeRole || report.operations?.cleanup) await liveOperation("cleanup", action("revokeRole", [TARGET.recipient, ROLE]), true)
						check(!(await coreAt(provider).hasRole(TARGET.recipient, ROLE)), "Temporary recovery role remains")
					} else check(snapshot.safeRole === report.baseline.safeRole, "Original recovery role changed")
					report.cleanup = { temporaryRoleRemoved: Boolean(report.temporaryRole), blockNumber: await provider.getBlockNumber() }
					return
				}
				if (args.phase === "evidence") {
					check(report.recovery && report.cleanup, "Recovery and role cleanup evidence are incomplete")
					check(
						snapshot.zero === "0" && snapshot.recipient === report.recovery.recipientAfter && snapshot.safeRole === report.baseline.safeRole,
						"Final balance or recovery role drift; review before completion",
					)
					const r = report.recovery
					const text = `HyperEVM v0.8.5 zero-address recovery completed.\n\nCore: ${TARGET.core}\nRecipient (internal Core balance): ${TARGET.recipient}\nRecipient confirmed by operator: ${report.recipientConfirmation.confirmedAt}\nRecovered: ${r.amountFormatted} USDC in internal 18-decimal units (${r.amount} raw).\nRecovery transaction: https://hyperevmscan.io/tx/${r.transactionHash}\nVerified transaction-atomic balances (raw, 18 decimals):\naddress(0): ${r.zeroBefore} -> ${r.zeroAfter}\nMultisig: ${r.recipientBefore} -> ${r.recipientAfter}\nFresh balances agree at observed block ${snapshot.observedThroughBlock}.\nFacet: ${report.facet}\nUpgrade transaction: ${report.operations.cut?.hash}\nValidation: local recovery tests passed. ${input.forkEnabled ? `Optional fork passed at block ${report.rehearsal.blockNumber} (${report.rehearsal.blockHash}).` : "Fork rehearsal was not requested by the operator."}\nTemporary recovery role removed: ${report.cleanup.temporaryRoleRemoved}; original roles preserved.\n\nThis operation credited the multisig's internal Core account; it did not withdraw ERC-20 tokens.\n`
					const file = path.join(path.dirname(args.output), "recovery-summary.txt")
					atomicWriteFile(file, text, 0o600)
					report.summaryFile = file
					report.finalSnapshot = snapshot
					return
				}
				throw new Error(`Unknown recovery phase: ${args.phase}`)
			} finally {
				try {
					save()
				} finally {
					lock.release()
				}
			}
		},
	}))
	.build()
