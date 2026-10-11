import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { BaseContract, BigNumberish, ContractTransactionReceipt, ethers } from "ethers"

import type { InstantLayer } from "../../src/types/index.js"
import { cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import { getBlockTimestamp } from "../utils/Common.js"
import { runTx } from "../utils/TxUtils.js"
import type { RunContext } from "./RunContext.js"
import { User } from "./User.js"
import type { QuoteRequest } from "./requestModels/QuoteRequest.js"

export type FuzzLayerRoute = "account-layer" | "instant-layer"

export async function configureFuzzLayers(context: RunContext): Promise<void> {
	await runTx(
		context.controlFacet
			.connect(context.signers.admin)
			.grantRole(await context.instantLayer.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("INSTANT_LAYER_ROLE"))),
	)
	await runTx(context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, context.accountLayerDiamond))
	await runTx(context.symmioPartyB.connect(context.signers.admin).grantRole(ethers.id("SETTER_ROLE"), context.signers.admin.address))
}

/** A trading address distinct from its owner, using the production layer routers. */
export class FuzzLayerUser extends User {
	private operationSequence = 0
	public lastSignedOperation?: { operation: InstantLayer.SignedOperationStruct; signature: string; hash: string }

	constructor(
		context: RunContext,
		signer: HardhatEthersSigner,
		public readonly route: FuzzLayerRoute,
		private account?: string,
		private readonly isolationType = 3, // CUSTOM keeps the ordinary fuzz actor's trading address stable.
	) {
		super(context, signer)
	}

	public override get address(): string {
		if (this.account === undefined) throw new Error("The fuzz layer account has not been created")
		return this.account
	}

	public override async getAddress(): Promise<string> {
		return this.address
	}

	public override async setup(): Promise<void> {
		if (this.account === undefined) {
			const data = [
				{ name: `fuzz-${this.route}`, metadata: "0x", symmioCore: this.context.diamond, isolationType: this.isolationType, singleVAMode: false },
			]
			const affiliate = await this.context.accountManager.getAddress()
			const accounts = await this.context.alCoreFacet.connect(this.signer).createSubAccounts.staticCall(affiliate, data)
			await runTx(this.context.alCoreFacet.connect(this.signer).createSubAccounts(affiliate, data))
			this.account = accounts[0]
		}
		await super.setup()
	}

	public override async setBalances(collateralAmount?: BigNumberish, depositAmount?: BigNumberish, allocatedAmount?: BigNumberish): Promise<void> {
		await runTx(this.context.collateral.connect(this.signer).approve(this.context.diamond, ethers.MaxUint256))
		if (collateralAmount) await runTx(this.context.collateral.connect(this.signer).mint(this.signer.address, collateralAmount))
		if (depositAmount) await this.executeAccountLayerCall(this.context.alCoreFacet, "depositForAccount", [this.address, depositAmount])
		if (allocatedAmount) await this.executeCoreCall(this.context.accountFacet, "allocate", [allocatedAmount])
	}

	protected override async executeCoreCall(contract: BaseContract, method: string, args: readonly unknown[]): Promise<ContractTransactionReceipt> {
		const callData = contract.interface.encodeFunctionData(method, args)
		if (this.route === "instant-layer") return this.executeSignedCall(this.context.diamond, callData)
		return runTx(this.context.alCoreFacet.connect(this.signer)._call(this.address, [callData]))
	}

	public async executeSymmioCall(contract: BaseContract, method: string, args: readonly unknown[]): Promise<ContractTransactionReceipt> {
		return this.executeCoreCall(contract, method, args)
	}

	public async encodeSendQuote(request: QuoteRequest): Promise<string> {
		const core: BaseContract = this.context.partyAFacet
		return core.interface.encodeFunctionData("sendQuoteWithAffiliate", await this.sendQuoteArguments(request))
	}

	public quoteIdFromLayerReceipt(receipt: ContractTransactionReceipt): bigint {
		return this.quoteIdFromReceipt(receipt)
	}

	public async executeAccountLayerCall(contract: BaseContract, method: string, args: readonly unknown[]): Promise<ContractTransactionReceipt> {
		if (this.route === "instant-layer") {
			return this.executeSignedCall(this.context.accountLayerDiamond, contract.interface.encodeFunctionData(method, args))
		}
		return runTx(contract.connect(this.signer).getFunction(method)(...args))
	}

	public async sendQuoteWithMargin(request: QuoteRequest, isolationType: number, marginAmount: bigint): Promise<bigint> {
		const core: BaseContract = this.context.partyAFacet
		const callData = core.interface.encodeFunctionData("sendQuoteWithAffiliate", await this.sendQuoteArguments(request))
		return this.quoteIdFromReceipt(
			await this.executeAccountLayerCall(this.context.alCoreFacet, "_callWithMargin", [
				this.address,
				isolationType,
				request.symbolId,
				marginAmount,
				[callData],
			]),
		)
	}

	private async executeSignedCall(target: string, callData: string): Promise<ContractTransactionReceipt> {
		const instantLayer = this.context.instantLayer
		const nonceBefore = await instantLayer.nonces(this.address)
		const sequence = ++this.operationSequence
		// Exercise ordered and unordered authorizations without weakening one-use replay protection.
		const nonce = sequence % 2 === 0 ? nonceBefore + 1n : 0n
		const operation: InstantLayer.SignedOperationStruct = {
			signer: this.signer.address,
			target,
			callData,
			signerAccount: { addr: this.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: {
				nonce,
				deadline: await getBlockTimestamp(100_000n),
				salt: ethers.keccak256(ethers.toUtf8Bytes(`fuzz:${this.address}:${nonceBefore}:${sequence}`)),
			},
		}
		const domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await instantLayer.runner!.provider!.getNetwork()).chainId,
			verifyingContract: await instantLayer.getAddress(),
		}
		const signature = await this.signer.signTypedData(domain, cloneTypes(), operation)
		const hash = await instantLayer.getOperationHash(operation)
		// The executor differs from the owner, so SignatureChecker must actually verify the signature.
		const receipt = await runTx(instantLayer.connect(this.context.signers.admin).executeBatch([operation], [signature], [[]], [[]]))
		this.lastSignedOperation = { operation, signature, hash }
		if ((await instantLayer.operationUsageCount(hash)) !== 1n) throw new Error(`InstantLayer did not consume operation ${hash} exactly once`)
		if ((await instantLayer.nonces(this.address)) !== nonceBefore + (nonce === 0n ? 0n : 1n)) {
			throw new Error(`InstantLayer nonce drift for ${this.address}`)
		}
		await this.assertExecutionContextCleared()
		return receipt
	}

	public async assertExecutionContextCleared(): Promise<void> {
		const admin = this.context.signers.admin
		const [coreSigner, layerSigner, scope, instantExecution] = await Promise.all([
			this.context.viewFacet.connect(admin).getSigner(),
			this.context.alViewFacet.connect(admin).getSigner(),
			this.context.alViewFacet.getSignerScope(),
			this.context.viewFacet.isCallFromInstantLayer(),
		])
		if (coreSigner !== admin.address || layerSigner !== admin.address || scope !== ethers.ZeroAddress || instantExecution) {
			throw new Error(`Layer execution context leaked after a call for ${this.address}`)
		}
	}
}
