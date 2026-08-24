export const VANITY_GROUPS = Object.freeze(["diamonds", "facets", "libraries", "peripherals"]);

const CORE_FACETS = [
	"DiamondCutFacet",
	"DiamondLoupeFacet",
	"AccountFacet",
	"PartyBAccountFacet",
	"ExternalTransferFacet",
	"BindingFacet",
	"PledgeFacet",
	"MigrationFacet",
	"ControlFacet",
	"ExecutionContextFacet",
	"SymbolControlFacet",
	"SymbolAdjustmentFacet",
	"PauseControlFacet",
	"PartyALiquidationFacet",
	"PartyALiquidationSnapshotFacet",
	"PartyBLiquidationFacet",
	"PartyAFacet",
	"BridgeFacet",
	"ViewFacet",
	"ViewFacetSymbol",
	"ViewFacetQuote",
	"ViewFacetAggregate",
	"FundingRateFacet",
	"ForceActionsFacet",
	"ForceCloseStepsFacet",
	"SettlementFacet",
	"PartyBPositionActionsFacet",
	"PartyBExecutionFacet",
	"PartyBQuoteActionsFacet",
	"ClearingHouseFacet",
	"PartyBBatchActionsFacet",
	"PartyBEmergencyActionsFacet",
	"WithdrawFacet",
];

const CORE_LIBRARIES = [
	"LibQuoteFunding",
	"LibQuoteClose",
	"PartyBPositionActionsFacetImpl",
	"ClearingHouseFacetImpl",
	"LibForceActions",
	"LibSettlement",
	"LibPartyALiquidationProcess",
	"LibPartyALiquidationSnapshotSetup",
	"LibPartyALiquidationLegacySetup",
];

const ACCOUNT_LAYER_LIBRARIES = ["LibQuoteParams"];

const ACCOUNT_LAYER_FACETS = [
	"DiamondCutFacet",
	"DiamondLoupeFacet",
	"CoreFacet",
	"MarginFacet",
	"SymmioHookFacet",
	"ControlFacet",
	"ViewFacet",
	"AffiliateFacet",
];

const EXPRESS_FACETS = ["DiamondCutFacet", "DiamondLoupeFacet", "ControlFacet", "SymmioHookFacet", "OperatorFacet", "AccelerateFacet", "ViewFacet"];

const PERIPHERALS = ["MultiAccount", "SymmioPartyB", "InstantLayer", "SymbolManager", "FeeDistributor", "MuonSignatureVerifier"];

function entries() {
	const map = {};
	map["core/Diamond"] = "diamonds";
	map["core/Init"] = "peripherals";
	map["accountLayer/Diamond"] = "diamonds";
	map["accountLayer/Init"] = "peripherals";
	map["expressProvider/Diamond"] = "diamonds";
	map["expressProvider/Init"] = "peripherals";
	map["gaslessLayer/GaslessLayer"] = "peripherals";
	map["gaslessLayer/GaslessNativeGasTopUpLib"] = "libraries";
	map["gaslessLayer/GaslessOperationalFeeLib"] = "libraries";
	map["gaslessLayer/GaslessWalletDeployerLib"] = "libraries";
	map["gaslessLayer/GaslessWalletExecutionLib"] = "libraries";
	for (const name of CORE_FACETS) map[`core/${name}`] = "facets";
	for (const name of CORE_LIBRARIES) map[`core/${name}`] = "libraries";
	for (const name of ACCOUNT_LAYER_FACETS) map[`accountLayer/${name}`] = "facets";
	for (const name of ACCOUNT_LAYER_LIBRARIES) map[`accountLayer/${name}`] = "libraries";
	for (const name of EXPRESS_FACETS) map[`expressProvider/${name}`] = "facets";
	for (const name of PERIPHERALS) map[`peripherals/${name}`] = "peripherals";
	return Object.freeze(map);
}

/** Every contract a deployment may place, keyed as `<component>/<ContractName>`. */
export const DEPLOYABLE_CONTRACTS = entries();

export function deployableGroup(key) {
	return DEPLOYABLE_CONTRACTS[key];
}
