export type MuonFunctionName =
	| "Trading"
	| "AccountManagement"
	| "Settlement"
	| "ForceClose"
	| "Funding"
	| "LiquidationPartyA"
	| "LiquidationPartyB"
	| "RemoveMargin"
	| "ExpressCredit"
export type MuonFunctionIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export const MUON_FUNCTIONS: readonly { readonly name: MuonFunctionName; readonly index: MuonFunctionIndex }[]
