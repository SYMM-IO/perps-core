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
	SignedOperation: Object.freeze([
		{ name: "signer", type: "address" },
		{ name: "callData", type: "bytes" },
		{ name: "signerAccount", type: "Account" },
		{ name: "replayAttackHeader", type: "ReplayAttackHeader" },
	]),
});

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
					{ name: "reqId", type: "uint256" },
					{ name: "gatewaySignature", type: "bytes" },
				],
			},
		],
		outputs: [{ name: "", type: "uint256" }],
	},
];

const TemplateOperationComponents = [
	{ name: "insertionPoints", type: "uint256[]" },
	{ name: "sourceIndices", type: "uint256[]" },
];

// If you want an explicit "Operation" tuple reference:
export const TemplateOperationTuple = [...TemplateOperationComponents];

export const InstantLayerAbi = [
	{
		type: "function",
		name: "getLastTemplateID",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "function",
		name: "addTemplate",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "name", type: "string" },
			{
				name: "operations",
				type: "tuple[]",
				components: [...TemplateOperationTuple],
			},
		],
		outputs: [],
	},
	{
		type: "function",
		name: "grantRole",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "role", type: "bytes32" },
			{ name: "account", type: "address" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "OPERATOR_ROLE",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "bytes32" }],
	},
	{
		type: "function",
		name: "executeBatch",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "signedOps",
				type: "tuple[]",
				components: [
					{ name: "signer", type: "address" },
					{
						name: "params",
						type: "tuple",
						components: [
							{ name: "callData", type: "bytes" },
							{ name: "functionSignature", type: "string" },
						],
					},
					{
						name: "account",
						type: "tuple",
						components: [
							{ name: "multiAccount", type: "address" },
							{ name: "addr", type: "address" },
							{ name: "owner", type: "address" },
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
			{
				name: "sigCalldDta",
				type: "tuple[]",
				components: [{ name: "signature", type: "bytes" }],
			},
		],
		outputs: [],
	},
];

// ===========================
// Canonical function signature string
// ===========================
export const FN_SIGNATURE =
	"sendQuoteWithAffiliate(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(int256,uint256,uint256,uint256,bytes))";
