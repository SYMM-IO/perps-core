export const FacetNames = [
	"AccountFacet",
	"PartyBAccountFacet",
	"ExternalTransferFacet",
	"BindingFacet",
	"PledgeFacet",
	"MigrationFacet",
	"contracts/core/facets/Control/ControlFacet.sol:ControlFacet",
	"SymbolControlFacet",
	"PauseControlFacet",
	"DiamondLoupeFacet",
	"PartyALiquidationFacet",
	"PartyALiquidationSnapshotFacet",
	"PartyBLiquidationFacet",
	"PartyAFacet",
	"BridgeFacet",
	"contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet",
	"ViewFacetSymbol",
	"ViewFacetQuote",
	"ViewFacetAggregate",
	"FundingRateFacet",
	"ForceActionsFacet",
	"ForceCloseStepsFacet",
	"SettlementFacet",
	"PartyBPositionActionsFacet",
	"PartyBQuoteActionsFacet",
	"ClearingHouseFacet",
	"PartyBBatchActionsFacet",
	"PartyBEmergencyActionsFacet",
	"WithdrawFacet",
]

// Deployment log files for verification
export const DEPLOYMENT_LOG_FILE = "deployed.json" // Core Diamond contracts
export const ACCOUNTLAYER_DEPLOYMENT_FILE = "accountlayer.json"
export const INSTANTLAYER_DEPLOYMENT_FILE = "instantlayer.json"
export const PARTYB_DEPLOYMENT_FILE = "partyb.json"
export const LIQUIDATOR_DEPLOYMENT_FILE = "liquidator.json"
export const STABLECOIN_DEPLOYMENT_FILE = "stablecoin.json"
export const SYMBOLMANAGER_DEPLOYMENT_FILE = "symbolmanager.json"

// Failed verifications — written by verify:all, consumed by verify:all --retry-failed
export const VERIFY_FAILED_FILE = "verify-failed.json"
