import { AbiCoder, Contract, Signer, concat, dataSlice, getBytes, id, isError, randomBytes, toBeHex, type BlockTag } from "ethers"

export type GaslessFeePayment = {
	account: string
	payer: string
	source: number // 0: SYMMIO account, 1: wallet collateral
	operationalFee: bigint
	depositFee: bigint
	walletCreationFee: bigint
	nativeTopUpFee: bigint
	nativeGasCollateral: bigint
}

/** All monetary fields use 18 decimals. collateralDecimals describes the actual ERC-20. */
export type GaslessFeeQuote = {
	collateralToken: string
	collateralDecimals: number
	blockNumber: bigint
	timestamp: bigint
	exact: boolean
	payments: GaslessFeePayment[]
	totalFee: bigint
	totalDebit: bigint
	freeOpsApplied: bigint
	nativeSponsored: boolean
}

export type GaslessFeeQuoteOutcome =
	| { status: "quoted"; quote: GaslessFeeQuote }
	| { status: "reverted"; data: string; errorName?: string; errorArgs?: readonly unknown[] }

/** The same encoded action goes into preview, exact simulation, and submission. Never send simulateFeeQuote as a transaction. */
export async function quoteGaslessFee({
	gateway,
	callData,
	mode,
	from,
	value = 0n,
	blockTag = "latest",
}: {
	gateway: Contract
	callData: string
	mode: "preview" | "exact"
	from?: string
	value?: bigint
	blockTag?: BlockTag
}): Promise<GaslessFeeQuoteOutcome> {
	const provider = gateway.runner?.provider
	if (!provider) throw new Error("A provider is required to quote GaslessLayer fees")
	if (mode === "exact" && !from) throw new Error("Exact simulation requires the submitting relayer/admin address as from")
	const method = mode === "preview" ? "previewFeeQuote" : "simulateFeeQuote"
	const data = gateway.interface.encodeFunctionData(method, mode === "preview" ? [callData, value] : [callData])
	try {
		const result = await provider.call({ to: await gateway.getAddress(), data, from, value: mode === "exact" ? value : 0n, blockTag })
		if (mode === "exact") throw new Error("simulateFeeQuote unexpectedly returned without its quote result")
		return { status: "quoted", quote: normalizeQuote(gateway.interface.decodeFunctionResult(method, result)[0]) }
	} catch (error) {
		// JSON-RPC providers wrap reverts in CALL_EXCEPTION; EIP-1193/Hardhat providers can expose raw data directly.
		const revertData = isError(error, "CALL_EXCEPTION")
			? error.data
			: typeof error === "object" && error !== null && "data" in error
				? error.data
				: undefined
		if (typeof revertData !== "string" || !/^0x[0-9a-f]*$/i.test(revertData)) throw error
		const decoded = decodeError(gateway, revertData)
		if (mode === "exact" && decoded?.name === "FeeQuoteResult") {
			return { status: "quoted", quote: normalizeQuote(decoded.args.quote) }
		}
		const reason: string = decoded?.name === "FeeQuoteExecutionFailed" ? decoded.args.reason : revertData
		const failure = decodeError(gateway, reason)
		return { status: "reverted", data: reason, errorName: failure?.name, errorArgs: failure ? Array.from(failure.args) : undefined }
	}
}

function decodeError(gateway: Contract, data: string) {
	try {
		return gateway.interface.parseError(data)
	} catch {
		return null // Preserve empty or unrecognized revert data for the caller.
	}
}

function normalizeQuote(q: any): GaslessFeeQuote {
	return {
		collateralToken: q.collateralToken,
		collateralDecimals: Number(q.collateralDecimals),
		blockNumber: q.blockNumber,
		timestamp: q.timestamp,
		exact: q.exact,
		payments: q.payments.map((p: any) => ({
			account: p.account,
			payer: p.payer,
			source: Number(p.source),
			operationalFee: p.operationalFee,
			depositFee: p.depositFee,
			walletCreationFee: p.walletCreationFee,
			nativeTopUpFee: p.nativeTopUpFee,
			nativeGasCollateral: p.nativeGasCollateral,
		})),
		totalFee: q.totalFee,
		totalDebit: q.totalDebit,
		freeOpsApplied: q.freeOpsApplied,
		nativeSponsored: q.nativeSponsored,
	}
}

/** Put this salt into the operation/delegation replayAttackHeader BEFORE signing its existing typed data. */
export function gaslessFeeLimitSalt(maxFee: bigint, salt: string | Uint8Array = randomBytes(8)): string {
	if (maxFee < 0n || maxFee >= 1n << 128n) throw new Error("maxFee must fit uint128 and use 18 decimals")
	if (getBytes(salt).length !== 8) throw new Error("The fee-limit salt must contain exactly 8 bytes")
	return concat([dataSlice(id("SYMMIO_GASLESS_FEE_LIMIT_V1"), 0, 8), toBeHex(maxFee, 16), salt])
}

export type NativeGasTopUpRequest = {
	payerAccount: string
	recipientWallet: string
	collateralAmount: bigint
	minNativeAmountOut: bigint
	nonce: bigint
	deadline: bigint
}

export const cappedNativeGasTopUpTypes = {
	CappedNativeGasTopUpRequest: [
		{ name: "payerAccount", type: "address" },
		{ name: "recipientWallet", type: "address" },
		{ name: "collateralAmount", type: "uint256" },
		{ name: "minNativeAmountOut", type: "uint256" },
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "maxTotalCharge", type: "uint256" },
	],
}

/** A capped top-up signature cannot be stripped into a legacy signature: it signs a different EIP-712 type. */
export async function signCappedNativeGasTopUp(
	signer: Signer,
	gateway: Contract,
	request: NativeGasTopUpRequest,
	maxTotalCharge: bigint,
): Promise<string> {
	const provider = gateway.runner?.provider
	if (!provider) throw new Error("A provider is required to read the signing chain ID")
	const { chainId } = await provider.getNetwork()
	const signature = await signer.signTypedData(
		{ name: "GaslessGateway", version: "1", chainId, verifyingContract: await gateway.getAddress() },
		cappedNativeGasTopUpTypes,
		{ ...request, maxTotalCharge },
	)
	return AbiCoder.defaultAbiCoder().encode(["uint256", "bytes"], [maxTotalCharge, signature])
}
