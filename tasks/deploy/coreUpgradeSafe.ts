import Safe from "@safe-global/protocol-kit"

import { digest } from "../../deployment-tooling/arbitrum-core-upgrade.js"
import { json, lower } from "./accountInstantSnapshot.js"

export const SAFE_EXECUTION_ABI = [
	"function getOwners() view returns(address[])",
	"function getThreshold() view returns(uint256)",
	"function approveHash(bytes32)",
	"function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns(bool)",
	"event ExecutionSuccess(bytes32 txHash,uint256 payment)",
	"event ExecutionFailure(bytes32 txHash,uint256 payment)",
]

export async function prepareCoreSafePayload(ethers: any, safeAddress: string, actions: any[]) {
	if (!actions.length || actions.some(a => a.value !== "0")) throw new Error("Core governance requires nonempty zero-value actions")
	const protocol = await (Safe as any).init({
		provider: { request: ({ method, params }: any) => ethers.provider.send(method, params || []) },
		safeAddress,
	})
	const transaction = await protocol.createTransaction({
		transactions: actions.map(a => ({ to: a.to, data: a.data, value: "0", operation: 0 })),
		onlyCalls: true,
	})
	const payload = json(transaction.data)
	return { actionsDigest: digest(actions), payload, safeTxHash: await protocol.getTransactionHash(transaction), payloadDigest: digest(payload) }
}

/** Only called inside an explicitly checked EDR fork, never against a live provider. */
export async function rehearseCoreSafePayload(ethers: any, safeAddress: string, envelope: any, expectedForkBlock: number) {
	const metadata = await ethers.provider.send("hardhat_metadata", [])
	if (Number(metadata.forkedNetwork?.forkBlockNumber) !== expectedForkBlock) throw new Error("Safe rehearsal requires the pinned fork")
	const safe = await ethers.getContractAt(SAFE_EXECUTION_ABI, safeAddress)
	const owners = Array.from(await safe.getOwners())
		.map(a => lower(a as string))
		.sort()
		.slice(0, Number(await safe.getThreshold()))
	if (!owners.length) throw new Error("Safe has no signing threshold")
	try {
		for (const owner of owners) {
			await ethers.provider.send("hardhat_impersonateAccount", [owner])
			await ethers.provider.send("hardhat_setBalance", [owner, "0x3635c9adc5dea00000"])
			await (await safe.connect(await ethers.getSigner(owner)).approveHash(envelope.safeTxHash)).wait()
		}
		const signatures = "0x" + owners.map(owner => owner.slice(2).padStart(64, "0") + "0".repeat(64) + "01").join("")
		const p = envelope.payload
		const tx = await safe
			.connect(await ethers.getSigner(owners[0]))
			.execTransaction(p.to, p.value, p.data, p.operation, p.safeTxGas, p.baseGas, p.gasPrice, p.gasToken, p.refundReceiver, signatures)
		const receipt = await tx.wait()
		await verifyCoreSafeReceipt(ethers, safeAddress, envelope, receipt.hash, expectedForkBlock)
		return { hash: receipt.hash, gasUsed: String(receipt.gasUsed), safeTxHash: envelope.safeTxHash, payloadDigest: envelope.payloadDigest }
	} finally {
		for (const owner of owners) await ethers.provider.send("hardhat_stopImpersonatingAccount", [owner])
	}
}

export async function verifyCoreSafeReceipt(ethers: any, safeAddress: string, envelope: any, hash: string, afterBlock: number) {
	if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Provide the successful Safe execution transaction hash")
	if (digest(envelope.payload) !== envelope.payloadDigest) throw new Error("Safe payload changed")
	const receipt = await ethers.provider.getTransactionReceipt(hash)
	if (!receipt || receipt.status !== 1 || lower(receipt.to || "") !== lower(safeAddress) || receipt.blockNumber <= afterBlock)
		throw new Error("Safe execution receipt is missing, failed, or predates the reviewed plan")
	const tx = await ethers.provider.getTransaction(hash)
	if (!tx) throw new Error("Safe execution calldata is unavailable; retry with a provider retaining transaction history")
	const iface = new ethers.Interface(SAFE_EXECUTION_ABI)
	const parsed = iface.parseTransaction({ data: tx.data, value: tx.value })
	if (parsed?.name !== "execTransaction") throw new Error("Expected a Safe execTransaction receipt")
	for (const key of ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver"])
		if (String(parsed.args[key]).toLowerCase() !== String(envelope.payload[key]).toLowerCase())
			throw new Error(`Executed Safe ${key} differs from rehearsed payload`)
	const events = receipt.logs
		.filter((l: any) => lower(l.address) === lower(safeAddress))
		.flatMap((l: any) => {
			try {
				return [iface.parseLog(l)]
			} catch {
				return []
			}
		})
	if (
		events.some((e: any) => e?.name === "ExecutionFailure") ||
		!events.some((e: any) => e?.name === "ExecutionSuccess" && e.args.txHash === envelope.safeTxHash)
	)
		throw new Error("Receipt does not prove successful execution of the exact Safe transaction")
	const block = await ethers.provider.getBlock(receipt.blockNumber)
	if (block?.hash !== receipt.blockHash) throw new Error("Safe receipt block is no longer canonical")
	return { hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, safeTxHash: envelope.safeTxHash }
}
