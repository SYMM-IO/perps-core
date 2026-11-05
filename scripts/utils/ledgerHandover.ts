import { getAddress } from "ethers"

export function ledgerArguments(derivationPath: string): string[] {
	return ["--ledger", "--mnemonic-derivation-path", derivationPath]
}

export function ledgerCandidatePaths(count: number): string[] {
	if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) throw new Error("Ledger scan count must be between 1 and 1000")
	const candidates: string[] = []
	// Ledger Live creates Ethereum accounts by advancing the hardened account component.
	for (let index = 0; index < count; index++) candidates.push(`m/44'/60'/${index}'/0/0`)
	// Also cover wallets that advance the final BIP-44 address-index component.
	for (let index = 0; index < count; index++) candidates.push(`m/44'/60'/0'/0/${index}`)
	return [...new Set(candidates)]
}

export function ledgerAddressFromOutput(output: string, derivationPath: string): string {
	const matches = output.match(/0x[0-9a-fA-F]{40}/gu)
	if (!matches?.length) throw new Error(`cast did not return a Ledger address for ${derivationPath}`)
	try {
		return getAddress(matches[matches.length - 1])
	} catch {
		throw new Error(`cast returned an invalid Ledger address for ${derivationPath}`)
	}
}

export function receiptHash(output: string): string {
	try {
		const receipt = JSON.parse(output) as { transactionHash?: unknown; status?: unknown }
		if (receipt.status === "0x0" || receipt.status === 0) throw new Error("transaction receipt has failed status 0")
		if (typeof receipt.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/u.test(receipt.transactionHash)) {
			return receipt.transactionHash
		}
	} catch (error) {
		if (error instanceof Error && error.message === "transaction receipt has failed status 0") throw error
	}
	const match = output.match(/0x[0-9a-fA-F]{64}/u)
	if (!match) throw new Error("cast returned success without a transaction hash")
	return match[0]
}
