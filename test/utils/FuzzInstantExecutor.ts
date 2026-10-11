import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"
import { ethers } from "ethers"

import type { InstantLayer } from "../../src/types/index.js"
import { cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import type { RunContext } from "../models/RunContext.js"
import { getBlockTimestamp } from "./Common.js"
import { runTx } from "./TxUtils.js"

export type FuzzSignedOperation = {
	operation: InstantLayer.SignedOperationStruct
	signature: string
	hash: string
}

/** Real owner, delegate and EIP-1271 signatures, with one-use and account nonce invariants. */
export class FuzzInstantExecutor {
	private sequence = 0

	constructor(
		private readonly context: RunContext,
		private readonly label: string,
	) {}

	public async domain() {
		return {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await this.context.instantLayer.runner!.provider!.getNetwork()).chainId,
			verifyingContract: await this.context.instantLayer.getAddress(),
		}
	}

	public async sign(
		signer: HardhatEthersSigner,
		account: string,
		target: string,
		callData: string,
		options: { isPartyB?: boolean; nonce?: bigint; flexFields?: InstantLayer.FlexFieldStruct[]; deadline?: bigint } = {},
	): Promise<FuzzSignedOperation> {
		const sequence = ++this.sequence
		const nonce = options.nonce ?? (await this.context.instantLayer.nonces(account)) + 1n
		const deadline = options.deadline ?? (await getBlockTimestamp(100_000n))
		const operation: InstantLayer.SignedOperationStruct = {
			signer: options.isPartyB ? account : signer.address,
			target,
			callData,
			signerAccount: { addr: account, isPartyB: options.isPartyB ?? false },
			flexFields: options.flexFields ?? [],
			maxUses: 1,
			replayAttackHeader: {
				nonce,
				deadline,
				salt: ethers.id(`${this.label}:${account}:${sequence}:${nonce}:${deadline}:${callData}`),
			},
		}
		return {
			operation,
			signature: await signer.signTypedData(await this.domain(), cloneTypes(), operation),
			hash: await this.context.instantLayer.getOperationHash(operation),
		}
	}

	public async execute(operations: FuzzSignedOperation[], options: { templateId?: bigint; fills?: string[][]; fillerSignatures?: string[][] } = {}) {
		const il = this.context.instantLayer.connect(this.context.signers.admin)
		const nonces = new Map<string, bigint>()
		for (const { operation, hash } of operations) {
			const account = String(operation.signerAccount.addr)
			if (!nonces.has(account)) nonces.set(account, await il.nonces(account))
			expect(await il.operationUsageCount(hash)).to.equal(0n)
		}
		const args = [
			operations.map(entry => entry.operation),
			operations.map(entry => entry.signature),
			options.fills ?? operations.map(() => []),
			options.fillerSignatures ?? operations.map(() => []),
		] as const
		const receipt = await runTx(options.templateId === undefined ? il.executeBatch(...args) : il.executeTemplate(options.templateId, ...args))
		for (const { operation, hash } of operations) {
			expect(await il.operationUsageCount(hash)).to.equal(1n)
			if (BigInt(String(operation.replayAttackHeader.nonce)) !== 0n) {
				const account = String(operation.signerAccount.addr)
				nonces.set(account, nonces.get(account)! + 1n)
			}
		}
		for (const [account, nonce] of nonces) expect(await il.nonces(account)).to.equal(nonce)
		await this.assertContextCleared()
		return receipt
	}

	public async assertUnused(operations: FuzzSignedOperation[], nonces: Map<string, bigint>) {
		for (const { hash } of operations) expect(await this.context.instantLayer.operationUsageCount(hash)).to.equal(0n)
		for (const [account, nonce] of nonces) expect(await this.context.instantLayer.nonces(account)).to.equal(nonce)
		await this.assertContextCleared()
	}

	public async assertContextCleared() {
		const { context } = this
		expect(await context.viewFacet.connect(context.signers.admin).getSigner()).to.equal(context.signers.admin.address)
		expect(await context.alViewFacet.connect(context.signers.admin).getSigner()).to.equal(context.signers.admin.address)
		expect(await context.alViewFacet.getSignerScope()).to.equal(ethers.ZeroAddress)
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	}
}
