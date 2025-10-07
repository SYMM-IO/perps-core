// test/helpers/eip712Types.ts
export type TypedDataTypes = Record<string, Array<{ name: string; type: string }>>

export const BASE_TYPES = Object.freeze({
	Account: Object.freeze([
		{ name: "multiAccount", type: "address" },
		{ name: "partyA_AccountAddress", type: "address" },
		{ name: "accountOwner", type: "address" },
		{ name: "selector", type: "bytes4" },
	]),
	ReplayAttackHeader: Object.freeze([
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "salt", type: "bytes32" },
	]),
	ParamCallDataSignable: Object.freeze([
		{ name: "targetContract", type: "address" },
		{ name: "callDataHash", type: "bytes32" },
		{ name: "keyValueHash", type: "bytes32" },
		{ name: "functionSignature", type: "string" },
	]),
	SignedOperation: Object.freeze([
		{ name: "signer", type: "address" },
		{ name: "params", type: "ParamCallDataSignable" },
		{ name: "side", type: "uint8" },
		{ name: "delegator", type: "Account" },
		{ name: "replayAttackHeader", type: "ReplayAttackHeader" },
	]),
} as const)

/** Per-test deep clone so modifications don’t bleed across tests. */
export function cloneTypes(): TypedDataTypes {
	return {
		Account: [...BASE_TYPES.Account],
		ReplayAttackHeader: [...BASE_TYPES.ReplayAttackHeader],
		ParamCallDataSignable: [...BASE_TYPES.ParamCallDataSignable],
		SignedOperation: [...BASE_TYPES.SignedOperation],
	}
}
