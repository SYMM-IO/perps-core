import { digest } from "../../deployment-tooling/arbitrum-core-upgrade.js"
import { coreGovernanceKind, coreUpgradeAuthority, coreUpgradeNetwork } from "../../deployment-tooling/core-upgrade-input.js"
import { lower } from "./accountInstantSnapshot.js"
import { prepareCoreSafePayload, rehearseCoreSafePayload, verifyCoreSafeReceipt } from "./coreUpgradeSafe.js"
import { completeGovernanceTransactionRequest } from "./governanceActions.js"
import { reconcileDeploymentTransactions, send } from "./tx.js"

export async function prepareCoreGovernancePayload(ethers: any, config: any, actions: any[]) {
	const owner = coreUpgradeAuthority(config)
	if (coreGovernanceKind(config) === "safe") return prepareCoreSafePayload(ethers, owner, actions)
	if (!actions.length || actions.some(a => a.value !== "0" || lower(a.to) !== lower(config.target.core)))
		throw new Error("Core governance requires reviewed zero-value Core actions")
	const nonce = await ethers.provider.getTransactionCount(owner)
	if ((await ethers.provider.getTransactionCount(owner, "pending")) !== nonce)
		throw new Error("Resolve pending owner transactions before preparing governance")
	const payload = {
		kind: "eoa",
		from: owner,
		chainId: coreUpgradeNetwork(config).chainId,
		nonce,
		actions,
	}
	return { actionsDigest: digest(actions), payload, payloadDigest: digest(payload) }
}

function assertEoaEnvelope(config: any, envelope: any) {
	const p = envelope.payload
	if (
		p?.kind !== "eoa" ||
		digest(p) !== envelope.payloadDigest ||
		lower(p.from || "") !== lower(coreUpgradeAuthority(config)) ||
		p.chainId !== coreUpgradeNetwork(config).chainId ||
		!Number.isSafeInteger(p.nonce) ||
		p.nonce < 0 ||
		!Array.isArray(p.actions) ||
		!p.actions.length ||
		p.actions.some(
			(a: any) => a.value !== "0" || lower(a.to || "") !== lower(config.target.core) || !/^0x(?:[a-fA-F0-9]{2}){4,}$/.test(a.data || ""),
		) ||
		envelope.actionsDigest !== digest(p.actions)
	)
		throw new Error("EOA governance envelope changed")
}

export async function verifyCoreGovernanceReceipt(ethers: any, config: any, envelope: any, hashes: string, afterBlock: number) {
	const owner = coreUpgradeAuthority(config)
	if (coreGovernanceKind(config) === "safe") {
		const result = await verifyCoreSafeReceipt(ethers, owner, envelope, hashes, afterBlock)
		if (config.execution && (await ethers.provider.getBlockNumber()) - result.blockNumber + 1 < config.execution.confirmations)
			throw new Error("Governance receipt lacks the configured confirmations")
		return result
	}
	assertEoaEnvelope(config, envelope)
	const list = JSON.parse(hashes)
	if (!Array.isArray(list) || list.length !== envelope.payload.actions.length)
		throw new Error("Every reviewed EOA action needs its execution receipt")
	const receipts = []
	for (let i = 0; i < list.length; i++) {
		if (!/^0x[0-9a-fA-F]{64}$/.test(list[i])) throw new Error("Invalid governance receipt hash")
		const receipt = await ethers.provider.getTransactionReceipt(list[i]),
			tx = await ethers.provider.getTransaction(list[i])
		const action = envelope.payload.actions[i]
		if (
			!receipt ||
			receipt.status !== 1 ||
			receipt.blockNumber <= afterBlock ||
			!tx ||
			lower(tx.from) !== lower(owner) ||
			lower(tx.to || "") !== lower(action.to) ||
			tx.data !== action.data ||
			String(tx.value) !== action.value ||
			tx.nonce !== envelope.payload.nonce + i ||
			Number(tx.chainId) !== envelope.payload.chainId
		)
			throw new Error("EOA receipt differs from its exact reviewed action, owner, nonce or chain")
		if ((await ethers.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash)
			throw new Error("Governance receipt is no longer canonical")
		if ((await ethers.provider.getBlockNumber()) - receipt.blockNumber + 1 < config.execution.confirmations)
			throw new Error("Governance receipt lacks the configured confirmations")
		receipts.push({ hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash })
	}
	return { hashes: list, receipts, blockNumber: receipts.at(-1)!.blockNumber, payloadDigest: envelope.payloadDigest }
}

export async function rehearseCoreGovernancePayload(ethers: any, config: any, envelope: any, expectedForkBlock: number) {
	const owner = coreUpgradeAuthority(config)
	if (coreGovernanceKind(config) === "safe") {
		const result = await rehearseCoreSafePayload(ethers, owner, envelope, expectedForkBlock)
		if (config.execution?.confirmations > 1) await ethers.provider.send("hardhat_mine", [ethers.toQuantity(config.execution.confirmations - 1)])
		await verifyCoreGovernanceReceipt(ethers, config, envelope, result.hash, expectedForkBlock)
		return result
	}
	assertEoaEnvelope(config, envelope)
	const metadata = await ethers.provider.send("hardhat_metadata", [])
	if (Number(metadata.forkedNetwork?.forkBlockNumber) !== expectedForkBlock) throw new Error("EOA rehearsal requires the pinned fork")
	await ethers.provider.send("hardhat_impersonateAccount", [owner])
	await ethers.provider.send("hardhat_setBalance", [owner, "0x3635c9adc5dea00000"])
	try {
		const signer = await ethers.getSigner(owner),
			hashes = []
		for (const [i, action] of envelope.payload.actions.entries()) {
			const receipt = await (await signer.sendTransaction({ to: action.to, data: action.data, value: 0n, nonce: envelope.payload.nonce + i })).wait()
			hashes.push(receipt.hash)
		}
		// A one-block mining fork must also earn any configured confirmation depth.
		if (config.execution.confirmations > 1) await ethers.provider.send("hardhat_mine", [ethers.toQuantity(config.execution.confirmations - 1)])
		return verifyCoreGovernanceReceipt(ethers, config, envelope, JSON.stringify(hashes), expectedForkBlock)
	} finally {
		await ethers.provider.send("hardhat_stopImpersonatingAccount", [owner])
	}
}

/** Persist the exact submitted intent before waiting; an uncertain transaction is never resent. */
export async function executeCoreGovernancePayload(
	ethers: any,
	config: any,
	envelope: any,
	journal: any,
	persist: () => void,
	checkProgress?: (confirmed: number) => Promise<void>,
) {
	if (coreGovernanceKind(config) !== "eoa") throw new Error("Invalid direct governance plan")
	assertEoaEnvelope(config, envelope)
	if (Number((await ethers.provider.getNetwork()).chainId) !== envelope.payload.chainId) throw new Error("Governance provider chain changed")
	const owner = coreUpgradeAuthority(config),
		[signer] = await ethers.getSigners()
	if (!signer || lower(await signer.getAddress()) !== lower(owner)) throw new Error("Governance signer is not the configured owner")
	if (journal.payloadDigest && journal.payloadDigest !== envelope.payloadDigest) throw new Error("Governance recovery payload changed")
	journal.payloadDigest = envelope.payloadDigest
	journal.transactions ||= []
	try {
		await reconcileDeploymentTransactions(journal.transactions, ethers.provider, owner)
	} finally {
		persist()
	}
	if (journal.transactions.length > envelope.payload.actions.length) throw new Error("Unexpected extra governance transactions")
	const verifyPrefix = async (count: number) => {
		const payload = { ...envelope.payload, actions: envelope.payload.actions.slice(0, count) }
		await verifyCoreGovernanceReceipt(
			ethers,
			config,
			{ ...envelope, payload, actionsDigest: digest(payload.actions), payloadDigest: digest(payload) },
			JSON.stringify(journal.transactions.slice(0, count).map((r: any) => r.replacementHash || r.hash)),
			0,
		)
	}
	for (const [i, action] of envelope.payload.actions.entries()) {
		const existing = journal.transactions[i]
		if (existing) {
			if (
				lower(existing.to || "") !== lower(action.to) ||
				existing.data !== action.data ||
				existing.value !== action.value ||
				existing.nonce !== envelope.payload.nonce + i
			)
				throw new Error("Recorded governance intent changed")
			if (!["confirmed", "replaced"].includes(existing.status)) throw new Error("Reconcile the submitted governance transaction before continuing")
			await verifyPrefix(i + 1)
			continue
		}
		if (checkProgress) await checkProgress(i)
		if ((await ethers.provider.getTransactionCount(owner, "pending")) !== envelope.payload.nonce + i)
			throw new Error("Owner nonce changed since the reviewed plan")
		await ethers.provider.call({ from: owner, to: action.to, data: action.data, value: 0n })
		const request = await completeGovernanceTransactionRequest(ethers.provider, { from: owner, to: action.to, data: action.data, value: 0n })
		request.nonce = envelope.payload.nonce + i
		try {
			await send(signer.sendTransaction(request), action.description, config.execution.confirmations, {
				onSubmitted: (record: any) => {
					journal.transactions[i] = record
					persist()
				},
			})
		} finally {
			persist()
		}
		await verifyPrefix(i + 1)
	}
	if (checkProgress) await checkProgress(journal.transactions.length)
	return JSON.stringify(journal.transactions.map((r: any) => r.replacementHash || r.hash))
}
