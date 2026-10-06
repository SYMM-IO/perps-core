// Append-only protocol IDs, shared by deployment and upgrade tooling.
export const MUON_FUNCTIONS = Object.freeze(
	[
		{ name: "Trading", index: 0 },
		{ name: "AccountManagement", index: 1 },
		{ name: "Settlement", index: 2 },
		{ name: "ForceClose", index: 3 },
		{ name: "Funding", index: 4 },
		{ name: "LiquidationPartyA", index: 5 },
		{ name: "LiquidationPartyB", index: 6 },
		{ name: "RemoveMargin", index: 7 },
		{ name: "ExpressCredit", index: 8 },
	].map(Object.freeze),
);
