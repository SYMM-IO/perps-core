import {
	getAddress,
	getCreate2Address,
	getCreateAddress,
	keccak256,
	type BaseContract,
	type ContractTransactionReceipt,
	type ContractTransactionResponse,
} from "ethers"

// Awaiting a contract call in ethers v6 resolves as soon as the transaction is
// BROADCAST, not when it is mined. deploy:system wraps its setup calls in
// checkpointedStep(), which marks a step complete the moment its action resolves — so
// without an explicit wait(), a dropped or reverted transaction is recorded as done and
// then skipped on resume, with no error anywhere.
//
// send() closes that gap and doubles as the deploy path's transaction log: every
// privileged call gets its hash and gas usage printed, which is the difference between
// a debuggable mainnet failure and a silent one.

export interface DeploymentTransactionRecord {
	label: string
	hash: string
	replacementHash?: string
	nonce: number
	status: "confirmed" | "replaced" | "failed" | "timed_out" | "unresolved"
	from?: string
	to?: string | null
	data?: string
	value?: string
	submittedAt: string
	confirmedAt?: string
	durationMs: number
	confirmations: number
	blockNumber?: number
	gasUsed?: string
	effectiveGasPrice?: string
	nativeCostWei?: string
	error?: string
	/** Exact contract-creation intent, used to restore a missing component checkpoint. */
	deployment?: DeploymentCreationBinding
}

export type DeploymentCreationBinding =
	| {
			kind: "create"
			component: string
			expectedAddress: string
			initCodeHash: string
			constructorArgs?: unknown[]
			runtimeCodeHash?: string
	  }
	| {
			kind: "create2"
			component: string
			expectedAddress: string
			factoryAddress: string
			salt: string
			initCodeHash: string
			factoryCallDataHash: string
			constructorArgs?: unknown[]
			runtimeCodeHash?: string
	  }

export interface SendOptions {
	deployment?: DeploymentCreationBinding
	onSubmitted?: (record: DeploymentTransactionRecord) => void | Promise<void>
}

export interface DeploymentConfirmationOptions {
	component: string
	constructorArgs?: unknown[]
	onSubmitted?: (record: DeploymentTransactionRecord) => void | Promise<void>
}

export interface DeploymentTransactionSettings {
	confirmations: number
	timeoutSeconds: number
	slowNoticeSeconds: number
}

const transactionJournal: DeploymentTransactionRecord[] = []
let transactionWriteAheadSink: ((record: DeploymentTransactionRecord) => void | Promise<void>) | undefined

type ReconciliationProvider = {
	getBlockNumber(): Promise<number>
	getTransaction(hash: string): Promise<any | null>
	getTransactionReceipt(hash: string): Promise<any | null>
	getTransactionCount(address: string, blockTag: "latest" | "pending"): Promise<number>
	getCode?(address: string): Promise<string>
}

function transactionIdentity(tx: ContractTransactionResponse | any): Pick<DeploymentTransactionRecord, "from" | "to" | "data" | "value"> {
	return {
		from: typeof tx.from === "string" ? tx.from : undefined,
		to: tx.to === null ? null : typeof tx.to === "string" ? tx.to : undefined,
		data: typeof tx.data === "string" ? tx.data : undefined,
		value: tx.value === undefined || tx.value === null ? undefined : BigInt(tx.value).toString(),
	}
}

function parseHash(value: string, source: string): string {
	const normalized = value.trim().toLowerCase()
	if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${source} contains an invalid transaction hash: ${JSON.stringify(value)}`)
	return normalized
}

function parseReplacementMap(raw: string | undefined): Map<string, string> {
	const result = new Map<string, string>()
	if (!raw) return result
	for (const entry of raw.split(",")) {
		const [original, replacement, extra] = entry.split("=")
		if (!original || !replacement || extra !== undefined) {
			throw new Error("DEPLOY_TX_REPLACEMENTS must be comma-separated originalHash=replacementHash pairs")
		}
		const originalHash = parseHash(original, "DEPLOY_TX_REPLACEMENTS")
		const replacementHash = parseHash(replacement, "DEPLOY_TX_REPLACEMENTS")
		if (originalHash === replacementHash) throw new Error(`DEPLOY_TX_REPLACEMENTS maps ${originalHash} to itself`)
		if (result.has(originalHash)) throw new Error(`DEPLOY_TX_REPLACEMENTS repeats ${originalHash}`)
		result.set(originalHash, replacementHash)
	}
	return result
}

function parseHashSet(raw: string | undefined, name: string): Set<string> {
	if (!raw) return new Set()
	const hashes = raw.split(",").map(value => parseHash(value, name))
	if (new Set(hashes).size !== hashes.length) throw new Error(`${name} contains a duplicate transaction hash`)
	return new Set(hashes)
}

function receiptConfirmations(receipt: any, currentBlock: number): number {
	return Math.max(0, currentBlock - Number(receipt.blockNumber) + 1)
}

function applyReceipt(
	record: DeploymentTransactionRecord,
	receipt: any,
	status: "confirmed" | "replaced" | "failed",
	replacementHash?: string,
	error?: string,
): void {
	const effectiveGasPrice = receipt.gasPrice === undefined ? undefined : BigInt(receipt.gasPrice)
	record.status = status
	record.replacementHash = replacementHash
	record.confirmedAt = new Date().toISOString()
	record.durationMs = Math.max(record.durationMs, Date.now() - Date.parse(record.submittedAt))
	record.blockNumber = Number(receipt.blockNumber)
	record.gasUsed = BigInt(receipt.gasUsed).toString()
	record.effectiveGasPrice = effectiveGasPrice?.toString()
	record.nativeCostWei = effectiveGasPrice === undefined ? undefined : (BigInt(receipt.gasUsed) * effectiveGasPrice).toString()
	if (error) record.error = error
	else delete record.error
}

function sameTransactionIntent(record: DeploymentTransactionRecord, replacement: any, fallbackFrom?: string): boolean {
	const expectedFrom = (record.from ?? fallbackFrom)?.toLowerCase()
	const expectedTo = record.to === null ? null : record.to?.toLowerCase()
	const expectedData = record.data?.toLowerCase()
	const expectedValue = record.value
	if (!expectedFrom || expectedTo === undefined || expectedData === undefined || expectedValue === undefined) return false
	return (
		typeof replacement.from === "string" &&
		replacement.from.toLowerCase() === expectedFrom &&
		Number(replacement.nonce) === record.nonce &&
		(replacement.to === null ? null : typeof replacement.to === "string" ? replacement.to.toLowerCase() : undefined) === expectedTo &&
		typeof replacement.data === "string" &&
		replacement.data.toLowerCase() === expectedData &&
		BigInt(replacement.value ?? 0).toString() === expectedValue
	)
}

function isPlainNonceCancellation(replacement: any): boolean {
	return (
		typeof replacement.from === "string" &&
		typeof replacement.to === "string" &&
		replacement.from.toLowerCase() === replacement.to.toLowerCase() &&
		(typeof replacement.data !== "string" || replacement.data === "0x") &&
		BigInt(replacement.value ?? 0) === 0n
	)
}

function normalizedHash(value: string, label: string): string {
	if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} is not a bytes32 hash: ${JSON.stringify(value)}`)
	return value.toLowerCase()
}

function assertCreationBindingShape(binding: DeploymentCreationBinding): void {
	if (!/^contracts\.[A-Za-z0-9_.]+$/.test(binding.component) && !/^deployments\.[A-Za-z0-9_.]+$/.test(binding.component)) {
		throw new Error(`Invalid deployment component key: ${JSON.stringify(binding.component)}`)
	}
	binding.expectedAddress = getAddress(binding.expectedAddress)
	binding.initCodeHash = normalizedHash(binding.initCodeHash, `${binding.component} initCodeHash`)
	if (binding.runtimeCodeHash !== undefined) {
		binding.runtimeCodeHash = normalizedHash(binding.runtimeCodeHash, `${binding.component} runtimeCodeHash`)
	}
	if (binding.kind === "create2") {
		binding.factoryAddress = getAddress(binding.factoryAddress)
		binding.salt = normalizedHash(binding.salt, `${binding.component} CREATE2 salt`)
		binding.factoryCallDataHash = normalizedHash(binding.factoryCallDataHash, `${binding.component} CREATE2 factory calldata hash`)
	}
}

async function validateDeploymentLanding(
	record: DeploymentTransactionRecord,
	receipt: any,
	provider: Pick<ReconciliationProvider, "getCode">,
	effectiveTransaction?: any,
): Promise<void> {
	const binding = record.deployment
	if (!binding) return
	assertCreationBindingShape(binding)
	if (Number(receipt.status) !== 1) throw new Error(`${binding.component} creation transaction reverted`)
	if (effectiveTransaction && !sameTransactionIntent(record, effectiveTransaction)) {
		throw new Error(`${binding.component} mined transaction does not match its recorded sender, nonce, target, calldata, and value`)
	}

	const from = typeof effectiveTransaction?.from === "string" ? effectiveTransaction.from : record.from
	const to = effectiveTransaction?.to !== undefined ? effectiveTransaction.to : record.to
	const data = typeof effectiveTransaction?.data === "string" ? effectiveTransaction.data : record.data
	const value = effectiveTransaction?.value === undefined ? record.value : BigInt(effectiveTransaction.value).toString()
	const nonce = effectiveTransaction?.nonce === undefined ? record.nonce : Number(effectiveTransaction.nonce)
	if (!from || typeof data !== "string" || value === undefined) {
		throw new Error(`${binding.component} creation record is missing sender, calldata, or value`)
	}
	BigInt(value)
	if (nonce !== record.nonce) throw new Error(`${binding.component} creation receipt cannot be bound to nonce ${record.nonce}`)

	if (binding.kind === "create") {
		if (to !== null) throw new Error(`${binding.component} was recorded as CREATE, but transaction target is ${String(to)}`)
		if (keccak256(data).toLowerCase() !== binding.initCodeHash) {
			throw new Error(`${binding.component} CREATE init code does not match its recorded hash`)
		}
		const derivedAddress = getCreateAddress({ from: getAddress(from), nonce })
		if (derivedAddress.toLowerCase() !== binding.expectedAddress.toLowerCase()) {
			throw new Error(
				`${binding.component} expected address ${binding.expectedAddress} does not match CREATE(${getAddress(from)}, ${nonce}) = ${derivedAddress}`,
			)
		}
		if (typeof receipt.contractAddress !== "string" || receipt.contractAddress.toLowerCase() !== binding.expectedAddress.toLowerCase()) {
			throw new Error(
				`${binding.component} receipt contract address ${String(receipt.contractAddress)} does not match expected ${binding.expectedAddress}`,
			)
		}
	} else {
		if (typeof to !== "string" || getAddress(to) !== binding.factoryAddress) {
			throw new Error(`${binding.component} CREATE2 transaction was not sent to recorded factory ${binding.factoryAddress}`)
		}
		if (keccak256(data).toLowerCase() !== binding.factoryCallDataHash) {
			throw new Error(`${binding.component} CREATE2 factory calldata does not match its recorded hash`)
		}
		const derivedAddress = getCreate2Address(binding.factoryAddress, binding.salt, binding.initCodeHash)
		if (derivedAddress.toLowerCase() !== binding.expectedAddress.toLowerCase()) {
			throw new Error(`${binding.component} expected address ${binding.expectedAddress} does not match recorded CREATE2 intent ${derivedAddress}`)
		}
	}

	if (!provider.getCode) throw new Error(`${binding.component} deployment provider cannot verify runtime bytecode`)
	const runtimeCode = await provider.getCode(binding.expectedAddress)
	if (!runtimeCode || runtimeCode === "0x") {
		throw new Error(`${binding.component} creation receipt succeeded, but ${binding.expectedAddress} has no runtime bytecode`)
	}
	const runtimeCodeHash = keccak256(runtimeCode).toLowerCase()
	if (binding.runtimeCodeHash && binding.runtimeCodeHash !== runtimeCodeHash) {
		throw new Error(
			`${binding.component} runtime bytecode hash ${runtimeCodeHash} does not match recorded ${binding.runtimeCodeHash} at ${binding.expectedAddress}`,
		)
	}
	binding.runtimeCodeHash = runtimeCodeHash
}

function successfulDeploymentRecords(records: DeploymentTransactionRecord[], component: string): DeploymentTransactionRecord[] {
	return records.filter(record => record.deployment?.component === component && (record.status === "confirmed" || record.status === "replaced"))
}

/**
 * Return a previously confirmed creation address only after re-proving its receipt,
 * CREATE/CREATE2 address derivation, exact transaction intent, and runtime bytecode.
 */
export async function recoverConfirmedDeployment(
	records: DeploymentTransactionRecord[],
	component: string,
	provider: ReconciliationProvider,
): Promise<string | null> {
	const candidates = successfulDeploymentRecords(records, component)
	if (candidates.length === 0) return null

	const identities = new Set(
		candidates.map(record => {
			const binding = record.deployment!
			return binding.kind === "create"
				? `${binding.kind}:${binding.expectedAddress.toLowerCase()}:${binding.initCodeHash.toLowerCase()}`
				: `${binding.kind}:${binding.expectedAddress.toLowerCase()}:${binding.factoryAddress.toLowerCase()}:${binding.salt.toLowerCase()}:${binding.initCodeHash.toLowerCase()}:${binding.factoryCallDataHash.toLowerCase()}`
		}),
	)
	if (identities.size !== 1) {
		throw new Error(`${component} has ${identities.size} distinct successful creation records; refusing to choose one and orphan another deployment`)
	}

	for (const record of candidates) {
		const effectiveHash = record.replacementHash || record.hash
		const receipt = await provider.getTransactionReceipt(effectiveHash)
		if (!receipt || Number(receipt.status) !== 1) {
			throw new Error(`${component} recovery record ${effectiveHash} has no successful receipt on the connected chain`)
		}
		const currentBlock = await provider.getBlockNumber()
		const confirmations = receiptConfirmations(receipt, currentBlock)
		if (confirmations < record.confirmations) {
			throw new Error(`${component} recovery receipt has ${confirmations}/${record.confirmations} confirmations`)
		}
		const effectiveTransaction = await provider.getTransaction(effectiveHash)
		if (record.status === "replaced") {
			if (!effectiveTransaction || !sameTransactionIntent(record, effectiveTransaction)) {
				throw new Error(`${component} replacement ${effectiveHash} no longer proves the original creation intent`)
			}
		}
		await validateDeploymentLanding(record, receipt, provider, effectiveTransaction || undefined)
	}

	return getAddress(candidates[0].deployment!.expectedAddress)
}

/**
 * Reconcile broadcasts whose receipt was unknown when the previous process stopped.
 * No incomplete checkpoint step may run again until each hash is proven mined,
 * replaced/cancelled, reverted, or explicitly confirmed dropped against this RPC.
 */
export async function reconcileDeploymentTransactions(
	records: DeploymentTransactionRecord[],
	provider: ReconciliationProvider,
	deployerAddress?: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const uncertain = records.filter(record => record.status === "timed_out" || record.status === "unresolved")
	if (uncertain.length === 0) return 0

	const replacements = parseReplacementMap(env.DEPLOY_TX_REPLACEMENTS)
	const confirmedDropped = parseHashSet(env.CONFIRM_DROPPED_TX_HASHES, "CONFIRM_DROPPED_TX_HASHES")
	const currentBlock = await provider.getBlockNumber()
	const unresolved: string[] = []
	let reconciled = 0

	for (const record of uncertain) {
		const originalHash = record.hash.toLowerCase()
		const originalReceipt = await provider.getTransactionReceipt(record.hash)
		if (originalReceipt) {
			const confirmations = receiptConfirmations(originalReceipt, currentBlock)
			if (confirmations < record.confirmations) {
				unresolved.push(
					`${record.hash} is mined in block ${originalReceipt.blockNumber} but has ${confirmations}/${record.confirmations} confirmations`,
				)
				continue
			}
			if (Number(originalReceipt.status) === 1) {
				try {
					const original = record.deployment ? await provider.getTransaction(record.hash) : undefined
					await validateDeploymentLanding(record, originalReceipt, provider, original || undefined)
				} catch (error) {
					unresolved.push(
						`${record.hash} (${record.deployment?.component || record.label}) failed deployment binding: ${error instanceof Error ? error.message : String(error)}`,
					)
					continue
				}
				applyReceipt(record, originalReceipt, "confirmed")
			} else applyReceipt(record, originalReceipt, "failed", undefined, `Transaction reverted in block ${originalReceipt.blockNumber}`)
			reconciled++
			continue
		}

		const replacementHash = replacements.get(originalHash)
		if (replacementHash) {
			const replacementReceipt = await provider.getTransactionReceipt(replacementHash)
			if (!replacementReceipt) {
				unresolved.push(`replacement ${replacementHash} for ${record.hash} has no receipt`)
				continue
			}
			const confirmations = receiptConfirmations(replacementReceipt, currentBlock)
			if (confirmations < record.confirmations) {
				unresolved.push(`replacement ${replacementHash} has ${confirmations}/${record.confirmations} confirmations`)
				continue
			}
			const replacement = await provider.getTransaction(replacementHash)
			if (!replacement || Number(replacement.nonce) !== record.nonce) {
				unresolved.push(`replacement ${replacementHash} cannot be bound to nonce ${record.nonce}`)
				continue
			}
			const original = await provider.getTransaction(record.hash)
			if ((record.to === undefined || !record.data || record.value === undefined) && original) {
				Object.assign(record, transactionIdentity(original))
			}
			const sameIntent = sameTransactionIntent(record, replacement, deployerAddress)
			if (Number(replacementReceipt.status) === 1 && sameIntent) {
				try {
					await validateDeploymentLanding(record, replacementReceipt, provider, replacement)
				} catch (error) {
					unresolved.push(
						`replacement ${replacementHash} (${record.deployment?.component || record.label}) failed deployment binding: ${error instanceof Error ? error.message : String(error)}`,
					)
					continue
				}
				applyReceipt(record, replacementReceipt, "replaced", replacementHash)
			} else if (Number(replacementReceipt.status) === 1 && record.deployment && !isPlainNonceCancellation(replacement)) {
				unresolved.push(
					`replacement ${replacementHash} consumed ${record.deployment.component}'s nonce with a different non-cancellation intent; refusing to redeploy until the resulting state/address is reviewed`,
				)
				continue
			} else {
				const reason =
					Number(replacementReceipt.status) !== 1
						? `Replacement ${replacementHash} reverted in block ${replacementReceipt.blockNumber}`
						: `Replacement ${replacementHash} used nonce ${record.nonce} but did not execute the original transaction intent`
				applyReceipt(record, replacementReceipt, "failed", replacementHash, reason)
			}
			reconciled++
			continue
		}

		if (confirmedDropped.has(originalHash)) {
			const sender = record.from ?? deployerAddress
			const original = await provider.getTransaction(record.hash)
			if (!sender) {
				unresolved.push(`${record.hash} has no recorded sender; cannot prove nonce ${record.nonce} is reusable`)
				continue
			}
			if (original) {
				unresolved.push(`${record.hash} is still visible to the RPC and cannot be confirmed dropped`)
				continue
			}
			const [latestNonce, pendingNonce] = await Promise.all([
				provider.getTransactionCount(sender, "latest"),
				provider.getTransactionCount(sender, "pending"),
			])
			if (latestNonce > record.nonce || pendingNonce > record.nonce) {
				unresolved.push(
					`${record.hash} nonce ${record.nonce} is already consumed/pending (latest=${latestNonce}, pending=${pendingNonce}); provide DEPLOY_TX_REPLACEMENTS`,
				)
				continue
			}
			record.status = "failed"
			record.error = `Operator confirmed ${record.hash} dropped after RPC nonce reconciliation`
			record.durationMs = Math.max(record.durationMs, Date.now() - Date.parse(record.submittedAt))
			reconciled++
			continue
		}

		unresolved.push(`${record.hash} (${record.label}, nonce ${record.nonce}) has no confirmed receipt`)
	}

	if (unresolved.length > 0) {
		throw new Error(
			`Deployment resume is blocked by ${unresolved.length} unresolved broadcast(s):\n- ${unresolved.join("\n- ")}\n` +
				"Wait and rerun, or set DEPLOY_TX_REPLACEMENTS=originalHash=replacementHash. Only after proving a hash absent and its nonce reusable may you set CONFIRM_DROPPED_TX_HASHES=hash.",
		)
	}
	return reconciled
}

export function getDeploymentTransactionJournal(): DeploymentTransactionRecord[] {
	return transactionJournal.map(record => ({ ...record }))
}

export function resetDeploymentTransactionJournal(): void {
	transactionJournal.length = 0
}

/**
 * Install the deploy:system checkpoint sink. Every transaction is persisted as
 * `unresolved` immediately after broadcast and before receipt waiting starts, so even a
 * process kill cannot lose the hash. Per-call sinks take precedence for component-bound
 * contract creations.
 */
export function bindDeploymentTransactionWriteAhead(sink: (record: DeploymentTransactionRecord) => void | Promise<void>): void {
	if (transactionWriteAheadSink) throw new Error("A deployment transaction write-ahead sink is already bound")
	transactionWriteAheadSink = sink
}

export function clearDeploymentTransactionWriteAhead(): void {
	transactionWriteAheadSink = undefined
}

export function getDeploymentTransactionSettings(env: NodeJS.ProcessEnv = process.env): DeploymentTransactionSettings {
	const confirmations = parseIntegerEnv(env, "DEPLOY_CONFIRMATIONS", 1, 1, 64)
	const timeoutSeconds = parseIntegerEnv(env, "DEPLOY_TX_TIMEOUT", 300, 30, 86_400)
	const slowNoticeSeconds = parseIntegerEnv(env, "DEPLOY_SLOW_TX_NOTICE", 30, 5, 86_400)
	if (slowNoticeSeconds >= timeoutSeconds) {
		throw new Error(
			`DEPLOY_SLOW_TX_NOTICE (${slowNoticeSeconds}) must be less than DEPLOY_TX_TIMEOUT (${timeoutSeconds}) so the operator sees a heartbeat before timeout.`,
		)
	}
	return { confirmations, timeoutSeconds, slowNoticeSeconds }
}

export function deploymentTimeoutRecoveryHint(writeAheadPersisted: boolean): string {
	if (writeAheadPersisted) {
		return "The transaction is write-ahead checkpointed; rerun the same guided deployment so it reconciles this hash before any further mutation."
	}
	return "No durable standalone checkpoint was written. Do not broadcast this action again until the explorer and sender nonce prove whether this hash landed or was replaced."
}

const defaultSettings = getDeploymentTransactionSettings()

/** Confirmations to wait for. Raise on chains where reorgs are a real concern. */
export const DEFAULT_CONFIRMATIONS = defaultSettings.confirmations

/**
 * How long to wait for a single transaction before giving up, in seconds.
 *
 * Without a bound, `tx.wait()` waits forever: a dropped transaction, an under-priced one on
 * a congested chain, or an RPC that quietly stops responding all leave the deploy hanging
 * with no output. Failing loudly is better. Guided deployments can reconcile their
 * write-ahead checkpoint; standalone callers are explicitly told not to rebroadcast until
 * the submitted hash and sender nonce have been resolved.
 *
 * The default is generous because block times vary enormously (Arbitrum ~0.25s, Ethereum
 * ~12s, some L2s far slower under load). Raise it on a slow or congested chain.
 */
export const TX_TIMEOUT_SECONDS = defaultSettings.timeoutSeconds

/** Log a still-waiting notice if a transaction takes longer than this, in seconds. */
const SLOW_TX_NOTICE_SECONDS = defaultSettings.slowNoticeSeconds

/**
 * Send a contract transaction, wait for it to be mined, and fail loudly if it did not
 * succeed. Returns the receipt so callers can read logs or gas.
 *
 * @param txPromise   the un-awaited contract call, e.g. `controlFacet.setAdmin(addr)`
 * @param label       human-readable name used in logs and error messages
 * @param confirmations blocks to wait for (defaults to DEPLOY_CONFIRMATIONS or 1)
 */
export async function send(
	txPromise: Promise<ContractTransactionResponse>,
	label: string,
	confirmations: number = DEFAULT_CONFIRMATIONS,
	options: SendOptions = {},
): Promise<ContractTransactionReceipt> {
	const tx = await txPromise
	const startedAt = Date.now()
	const submittedAt = new Date(startedAt).toISOString()
	const record: DeploymentTransactionRecord = {
		label,
		hash: tx.hash,
		nonce: tx.nonce,
		status: "unresolved",
		...transactionIdentity(tx),
		submittedAt,
		durationMs: 0,
		confirmations,
		deployment: options.deployment,
	}
	transactionJournal.push(record)
	const writeAhead = options.onSubmitted || transactionWriteAheadSink
	if (writeAhead) {
		try {
			await writeAhead(record)
		} catch (error) {
			record.error = `Failed to persist submitted transaction before receipt wait: ${error instanceof Error ? error.message : String(error)}`
			throw new Error(`${label}: transaction ${tx.hash} was broadcast, but its write-ahead record could not be persisted. ${record.error}`)
		}
	}
	console.log(`    → ${label} submitted — ${tx.hash} (nonce ${tx.nonce}, waiting for ${confirmations} confirmation${confirmations === 1 ? "" : "s"})`)

	// On a slow or congested chain a single wait can take minutes. Say something, so the
	// operator can tell "still mining" apart from "hung", and include the hash so they can
	// follow it on an explorer while they wait.
	const notice = setTimeout(() => {
		console.log(`      … still waiting on ${label} (${tx.hash}) after ${SLOW_TX_NOTICE_SECONDS}s`)
	}, SLOW_TX_NOTICE_SECONDS * 1000)

	let receipt: ContractTransactionReceipt | null
	let replacementHash: string | undefined
	let replaced = false
	try {
		try {
			receipt = await withTimeout(tx.wait(confirmations), TX_TIMEOUT_SECONDS, label, tx.hash, Boolean(writeAhead))
		} catch (error: any) {
			// ethers reports repriced/replaced transactions with the successful replacement
			// receipt attached. Treat a non-cancelled successful replacement as confirmation,
			// and record both hashes so resume/audit tooling can reconcile the nonce.
			if (error?.code === "TRANSACTION_REPLACED" && error?.cancelled !== true && error?.receipt?.status === 1) {
				receipt = error.receipt as ContractTransactionReceipt
				replacementHash = error.replacement?.hash || receipt.hash
				replaced = true
			} else {
				throw error
			}
		}
	} catch (error) {
		const durationMs = Date.now() - startedAt
		const message = error instanceof Error ? error.message : String(error)
		const errorReceipt = (error as any)?.receipt as ContractTransactionReceipt | undefined
		const cancelledReplacement = (error as any)?.code === "TRANSACTION_REPLACED" && (error as any)?.cancelled === true && errorReceipt
		record.status = message.includes("was not mined within")
			? "timed_out"
			: errorReceipt?.status === 0 || cancelledReplacement
				? "failed"
				: "unresolved"
		record.replacementHash = cancelledReplacement ? ((error as any)?.replacement?.hash ?? errorReceipt?.hash) : undefined
		record.confirmedAt = errorReceipt ? new Date().toISOString() : undefined
		record.durationMs = durationMs
		record.blockNumber = errorReceipt?.blockNumber
		record.gasUsed = errorReceipt?.gasUsed?.toString()
		record.error = message
		throw error
	} finally {
		clearTimeout(notice)
	}

	if (!receipt) {
		const message = `${label}: transaction ${tx.hash} was dropped or replaced before ${confirmations} confirmation(s)`
		record.status = "unresolved"
		record.durationMs = Date.now() - startedAt
		record.error = message
		throw new Error(message)
	}
	if (receipt.status !== 1) {
		applyReceipt(record, receipt, "failed", replacementHash, `Transaction reverted in block ${receipt.blockNumber}`)
		throw new Error(`${label}: transaction ${tx.hash} reverted in block ${receipt.blockNumber}`)
	}

	const durationMs = Date.now() - startedAt
	const seconds = durationMs / 1000
	const timing = seconds >= 5 ? ` in ${seconds.toFixed(1)}s` : ""
	applyReceipt(record, receipt, replaced ? "replaced" : "confirmed", replacementHash)
	record.durationMs = durationMs
	const displayedHash = replacementHash || tx.hash
	console.log(`    ✓ ${label} — ${displayedHash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()})${timing}`)
	return receipt
}

/**
 * Confirm a contract-creation transaction through the same timeout, replacement, receipt,
 * and journal path as every setup transaction. Returns the deployed address after asserting
 * code exists there; callers no longer have to use an unbounded waitForDeployment().
 */
export async function confirmDeployment(contract: BaseContract, label: string, options?: DeploymentConfirmationOptions): Promise<string> {
	return (await confirmDeploymentWithReceipt(contract, label, options)).address
}

export async function confirmDeploymentWithReceipt(
	contract: BaseContract,
	label: string,
	options?: DeploymentConfirmationOptions,
): Promise<{ address: string; receipt: ContractTransactionReceipt }> {
	const tx = contract.deploymentTransaction()
	if (!tx) throw new Error(`${label}: contract has no deployment transaction`)
	const address = await contract.getAddress()
	const provider = contract.runner?.provider
	if (!provider) throw new Error(`${label}: deployment runner has no provider; cannot verify bytecode at ${address}`)

	let deployment: DeploymentCreationBinding | undefined
	if (options) {
		if (tx.to !== null) throw new Error(`${label}: deployment transaction unexpectedly targets ${String(tx.to)}`)
		if (!tx.from || !tx.data) throw new Error(`${label}: deployment transaction is missing sender or init code`)
		const derivedAddress = getCreateAddress({ from: getAddress(tx.from), nonce: tx.nonce })
		if (derivedAddress.toLowerCase() !== address.toLowerCase()) {
			throw new Error(`${label}: contract target ${address} does not match CREATE(${tx.from}, ${tx.nonce}) = ${derivedAddress}`)
		}
		deployment = {
			kind: "create",
			component: options.component,
			expectedAddress: getAddress(address),
			initCodeHash: keccak256(tx.data).toLowerCase(),
			constructorArgs: options.constructorArgs,
		}
		assertCreationBindingShape(deployment)
	}

	const receipt = await send(Promise.resolve(tx), `deploy ${label}`, DEFAULT_CONFIRMATIONS, {
		deployment,
		onSubmitted: options?.onSubmitted,
	})
	const record = transactionJournal.find(item => item.hash.toLowerCase() === tx.hash.toLowerCase() && item.deployment === deployment)
	try {
		if (deployment && record) await validateDeploymentLanding(record, receipt, provider, tx)
		else {
			const code = await provider.getCode(address)
			if (code === "0x") throw new Error(`${label}: deployment transaction confirmed but no bytecode exists at ${address}`)
		}
	} catch (error) {
		if (record) {
			record.status = "failed"
			record.error = `Deployment binding validation failed: ${error instanceof Error ? error.message : String(error)}`
		}
		throw error
	}
	return { address, receipt }
}

function withTimeout<T>(promise: Promise<T>, seconds: number, label: string, hash: string, writeAheadPersisted: boolean): Promise<T> {
	let timer: NodeJS.Timeout
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`${label}: transaction ${hash} was not mined within ${seconds}s. ` +
							`It may still land. ${deploymentTimeoutRecoveryHint(writeAheadPersisted)} ` +
							`Raise DEPLOY_TX_TIMEOUT if the chain is simply slow.`,
					),
				),
			seconds * 1000,
		)
	})
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

function parseIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name]
	if (raw === undefined || raw === "") return fallback
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${name} must be a whole number between ${min} and ${max}; received ${JSON.stringify(raw)}.`)
	}
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be between ${min} and ${max}; received ${JSON.stringify(raw)}.`)
	}
	return value
}
