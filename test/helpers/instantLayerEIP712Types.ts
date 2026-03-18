// test/helpers/eip712Types.ts
export type TypedDataEntry = Readonly<{ name: string; type: string }>
export type DelegateTypedDataTypes = Readonly<Record<string, readonly TypedDataEntry[]>>

export const DELEGATE_TYPES = {
	Account: [
		{ name: "addr", type: "address" },
		{ name: "isPartyB", type: "bool" },
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
		{ name: "addr", type: "address" },
		{ name: "isPartyB", type: "bool" },
	]),
	ReplayAttackHeader: Object.freeze([
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "salt", type: "bytes32" },
	]),
	FlexField: Object.freeze([
		{ name: "offset", type: "uint256" },
		{ name: "length", type: "uint256" },
		{ name: "authorizedFlexFiller", type: "address" },
	]),
	SignedOperation: Object.freeze([
		{ name: "signer", type: "address" },
		{ name: "target", type: "address" },
		{ name: "callData", type: "bytes" },
		{ name: "signerAccount", type: "Account" },
		{ name: "flexFields", type: "FlexField[]" },
		{ name: "maxUses", type: "uint256" },
		{ name: "replayAttackHeader", type: "ReplayAttackHeader" },
	]),
})

export const FLEX_FILLER_AUTH_TYPES = {
	FlexFillAuth: [
		{ name: "opHash", type: "bytes32" },
		{ name: "fieldIndex", type: "uint256" },
		{ name: "value", type: "bytes" },
	],
}

/** Per-test deep clone so modifications don't bleed across tests. */
export function cloneTypes(): TypedDataTypes {
	return {
		Account: [...BASE_TYPES.Account],
		ReplayAttackHeader: [...BASE_TYPES.ReplayAttackHeader],
		FlexField: [...BASE_TYPES.FlexField],
		SignedOperation: [...BASE_TYPES.SignedOperation],
	}
}
