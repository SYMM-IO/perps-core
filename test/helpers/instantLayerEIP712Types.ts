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

export const PartyAFacetAbi = [
	{
		type: "function",
		name: "sendQuoteWithAffiliate",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "partyBsWhiteList", type: "address[]" },
			{ name: "symbolId", type: "uint256" },
			{ name: "positionType", type: "uint8" },
			{ name: "orderType", type: "uint8" },
			{ name: "price", type: "uint256" },
			{ name: "quantity", type: "uint256" },
			{ name: "cva", type: "uint256" },
			{ name: "lf", type: "uint256" },
			{ name: "partyAmm", type: "uint256" },
			{ name: "partyBmm", type: "uint256" },
			{ name: "maxFundingRate", type: "uint256" },
			{ name: "deadline", type: "uint256" },
			{ name: "affiliate", type: "address" },
			{
				name: "upnlSig",
				type: "tuple",
				components: [
					{ name: "upnl", type: "int256" },
					{ name: "price", type: "uint256" },
					{ name: "timestamp", type: "uint256" },
					{ name: "requestId", type: "uint256" },
					{ name: "sig", type: "bytes" },
				],
			},
		],
		outputs: [{ name: "", type: "uint256" }],
	},
]

export const InstantLayerAbi = [
	{
		type: "function",
		name: "executeBatch",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "ops",
				type: "tuple[]",
				components: [
					{ name: "signer", type: "address" },
					{
						name: "params",
						type: "tuple",
						components: [
							{ name: "targetContract", type: "address" },
							{ name: "callDataHash", type: "bytes32" },
							{ name: "keyValueHash", type: "bytes32" },
							{ name: "functionSignature", type: "string" },
						],
					},
					{ name: "side", type: "uint8" },
					{
						name: "delegator",
						type: "tuple",
						components: [
							{ name: "multiAccount", type: "address" },
							{ name: "partyA_AccountAddress", type: "address" },
							{ name: "accountOwner", type: "address" },
							{ name: "selector", type: "bytes4" },
						],
					},
					{
						name: "replayAttackHeader",
						type: "tuple",
						components: [
							{ name: "nonce", type: "uint256" },
							{ name: "deadline", type: "uint256" },
							{ name: "salt", type: "bytes32" },
						],
					},
				],
			},
			{ name: "sigs", type: "tuple[]", components: [{ name: "signature", type: "bytes" }] },
			{
				name: "transports",
				type: "tuple[]",
				components: [
					{ name: "targetContract", type: "address" },
					{ name: "callData", type: "bytes" },
					{ name: "callDataHash", type: "bytes32" },
					{ name: "functionSignature", type: "string" },
					{ name: "keyValue", type: "string" },
				],
			},
		],
		outputs: [],
	},
]
