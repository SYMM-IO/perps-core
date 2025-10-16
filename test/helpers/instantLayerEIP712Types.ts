// test/helpers/eip712Types.ts
export type TypedDataEntry = Readonly<{ name: string; type: string }>
export type DelegateTypedDataTypes = Readonly<Record<string, readonly TypedDataEntry[]>>

export const DELEGATE_TYPES = {
	Account: [
		{ name: "multiAccount", type: "address" },
		{ name: "addr", type: "address" },
	],
	ReplayAttackHeader: [
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "salt", type: "bytes32" },
	],
	DelegationInfo: [
		{ name: "account", type: "Account" },
		{ name: "delegatedSigner", type: "address" },
		{ name: "selectors", type: "bytes4[]" },
		{ name: "expiryTimestamp", type: "uint256" },
	],
	SignedDelegation: [
		{ name: "delegationInfo", type: "DelegationInfo" },
		{ name: "replayAttackHeader", type: "ReplayAttackHeader" },
	],
}

export type TypedDataTypes = Record<string, Array<{ name: string; type: string }>>
export const BASE_TYPES = Object.freeze({
	Account: Object.freeze([
		{ name: "multiAccount", type: "address" },
		{ name: "addr", type: "address" },
	]),
	ReplayAttackHeader: Object.freeze([
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "salt", type: "bytes32" },
	]),
	ParamCallDataSignable: Object.freeze([{ name: "callData", type: "bytes" }]),
	SignedOperation: Object.freeze([
		{ name: "signer", type: "address" },
		{ name: "params", type: "ParamCallDataSignable" },
		{ name: "signerInfo", type: "Account" },
		{ name: "replayAttackHeader", type: "ReplayAttackHeader" },
	]),
})

/** Per-test deep clone so modifications don’t bleed across tests. */
export function cloneTypes(): TypedDataTypes {
	return {
		Account: [...BASE_TYPES.Account],
		ReplayAttackHeader: [...BASE_TYPES.ReplayAttackHeader],
		ParamCallDataSignable: [...BASE_TYPES.ParamCallDataSignable],
		SignedOperation: [...BASE_TYPES.SignedOperation],
	}
}
