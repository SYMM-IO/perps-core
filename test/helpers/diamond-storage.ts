import { expect } from "chai"
import type { BaseContract } from "ethers"

import { ethers } from "./hardhat-connection.js"

/** Discovers a scalar getter's storage slot through the diamond, without assuming a Layout offset. */
export async function scalarGetterSlot(contract: BaseContract, getter: string, args: readonly unknown[]): Promise<bigint> {
	const trace = (await ethers.provider.send("debug_traceCall", [
		{ to: await contract.getAddress(), data: contract.interface.encodeFunctionData(getter, args) },
		"latest",
		{ disableMemory: true, disableStorage: true },
	])) as { failed: boolean; structLogs: Array<{ op: string; depth: number; stack: string[] }> }
	expect(trace.failed, `${getter} trace failed`).to.equal(false)
	// Depth one is the diamond's selector lookup; the delegated getter runs at depth two.
	const reads = trace.structLogs.filter(step => step.op === "SLOAD" && step.depth > 1)
	expect(reads, `${getter} must read exactly one storage slot`).to.have.length(1)
	return BigInt(`0x${reads[0].stack.at(-1)!.replace(/^0x/, "")}`)
}

export async function setSignedStorage(contractAddress: string, slot: bigint, value: bigint): Promise<void> {
	await ethers.provider.send("hardhat_setStorageAt", [contractAddress, ethers.toBeHex(slot, 32), ethers.toBeHex(ethers.toTwos(value, 256), 32)])
}
