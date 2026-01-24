import { ethers } from "../helpers/hardhat-connection.js"

import type {
	AccountFacet,
	BridgeFacet,
	ClearingHouseFacet,
	ADLFacet,
	SymbolControlFacet,
	PauseControlFacet,
	DiamondCutFacet,
	DiamondLoupeFacet,
	ForceActionsFacet,
	ForceCloseStepsFacet,
	FundingRateFacet,
	PartyALiquidationFacet,
	PartyBLiquidationFacet,
	PartyAFacet,
	PartyBBatchActionsFacet,
	PartyBPositionActionsFacet,
	PartyBQuoteActionsFacet,
	SettlementFacet,
	ViewFacetSymbol,
	ViewFacetQuote,
	ViewFacetAggregate,
	InstantLayer,
	SymmioPartyB,
	AccountManager,
	AffiliateHub,
	AccountHub,
	AccountHubLens,
	FakeStablecoin,
	SymmioPartyA,
	WithdrawFacet,
	MasterAccountMigrationFacet,
	// AccountLayer facets
	CoreFacet as ALCoreFacet,
	MarginFacet as ALMarginFacet,
	SymmioHookFacet as ALSymmioHookFacet,
	ControlFacet as ALControlFacet,
	ViewFacet as ALViewFacet,
	AffiliateFacet as ALAffiliateFacet,
} from "../../src/types/index.js"
// Import core diamond's ControlFacet and ViewFacet from specific paths
import type { ControlFacet } from "../../src/types/facets/Control/ControlFacet.js"
import type { ViewFacet } from "../../src/types/facets/ViewFacet/ViewFacet.js";
import { TestManager } from "./TestManager.js"
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"

export class RunContext {
	// Core Diamond facets
	accountFacet!: AccountFacet
	diamondCutFacet!: DiamondCutFacet
	diamondLoupeFacet!: DiamondLoupeFacet
	adlFacet!: ADLFacet
	partyAFacet!: PartyAFacet
	partyBBatchActionsFacet!: PartyBBatchActionsFacet
	partyBQuoteActionsFacet!: PartyBQuoteActionsFacet
	partyBPositionActionsFacet!: PartyBPositionActionsFacet
	bridgeFacet!: BridgeFacet
	viewFacet!: ViewFacet
	viewFacetSymbol!: ViewFacetSymbol
	viewFacetQuote!: ViewFacetQuote
	viewFacetAggregate!: ViewFacetAggregate
	partyALiquidationFacet!: PartyALiquidationFacet
	partyBLiquidationFacet!: PartyBLiquidationFacet
	controlFacet!: ControlFacet
	symbolControlFacet!: SymbolControlFacet
	pauseControlFacet!: PauseControlFacet
	fundingRateFacet!: FundingRateFacet
	settlementFacet!: SettlementFacet
	forceActionsFacet!: ForceActionsFacet
	forceCloseStepsFacet!: ForceCloseStepsFacet
	clearingHouseFacet!: ClearingHouseFacet
	withdrawFacet!: WithdrawFacet
	masterAccountMigrationFacet!: MasterAccountMigrationFacet

	// AccountLayer Diamond facets
	alCoreFacet!: ALCoreFacet
	alMarginFacet!: ALMarginFacet
	alSymmioHookFacet!: ALSymmioHookFacet
	alControlFacet!: ALControlFacet
	alViewFacet!: ALViewFacet
	alAffiliateFacet!: ALAffiliateFacet
	accountLayerDiamond!: string

	signers!: {
		admin: HardhatEthersSigner
		user: HardhatEthersSigner
		user2: HardhatEthersSigner
		liquidator: HardhatEthersSigner
		hedger: HardhatEthersSigner
		hedger2: HardhatEthersSigner
		bridge: HardhatEthersSigner
		bridge2: HardhatEthersSigner
		feeCollector: HardhatEthersSigner
		feeCollector2: HardhatEthersSigner
		symmioFeeReceiver: HardhatEthersSigner
		others: HardhatEthersSigner[]
	}
	diamond!: string
	accountManager!: AccountManager
	accountManager2!: AccountManager
	instantLayer!: InstantLayer
	// Legacy - kept for backward compatibility during migration
	accountHub!: AccountHub
	accountHubLens!: AccountHubLens
	affiliateHub!: AffiliateHub
	symmioPartyB!: SymmioPartyB
	collateral!: FakeStablecoin
	manager!: TestManager
}

export async function createRunContext(diamond: string, collateral: string, onlyInitialize: boolean = false): Promise<RunContext> {
	let context = new RunContext()

	const signers: HardhatEthersSigner[] = await ethers.getSigners()
	context.signers = {
		admin: signers[0],
		user: signers[1],
		user2: signers[2],
		liquidator: signers[3],
		hedger: signers[4],
		hedger2: signers[5],
		bridge: signers[6],
		bridge2: signers[7],
		feeCollector: signers[8],
		feeCollector2: signers[9],
		symmioFeeReceiver: signers[10],
		others: [signers[11], signers[12]],
	}

	context.diamond = diamond

	context.collateral = await ethers.getContractAt("FakeStablecoin", collateral)
	context.accountFacet = await ethers.getContractAt("AccountFacet", diamond)
	context.diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamond)
	context.diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamond)
	context.adlFacet = await ethers.getContractAt("ADLFacet", diamond)
	context.partyAFacet = await ethers.getContractAt("PartyAFacet", diamond)
	context.partyBBatchActionsFacet = await ethers.getContractAt("PartyBBatchActionsFacet", diamond)
	context.partyBQuoteActionsFacet = await ethers.getContractAt("PartyBQuoteActionsFacet", diamond)
	context.partyBPositionActionsFacet = await ethers.getContractAt("PartyBPositionActionsFacet", diamond)
	context.bridgeFacet = await ethers.getContractAt("BridgeFacet", diamond)
	context.viewFacet = await ethers.getContractAt("contracts/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamond)
	context.viewFacetSymbol = await ethers.getContractAt("ViewFacetSymbol", diamond)
	context.viewFacetQuote = await ethers.getContractAt("ViewFacetQuote", diamond)
	context.viewFacetAggregate = await ethers.getContractAt("ViewFacetAggregate", diamond)
	context.partyALiquidationFacet = await ethers.getContractAt("PartyALiquidationFacet", diamond)
	context.partyBLiquidationFacet = await ethers.getContractAt("PartyBLiquidationFacet", diamond)
	context.controlFacet = await ethers.getContractAt("contracts/facets/Control/ControlFacet.sol:ControlFacet", diamond)
	context.symbolControlFacet = await ethers.getContractAt("SymbolControlFacet", diamond)
	context.pauseControlFacet = await ethers.getContractAt("PauseControlFacet", diamond)
	context.fundingRateFacet = await ethers.getContractAt("FundingRateFacet", diamond)
	context.settlementFacet = await ethers.getContractAt("SettlementFacet", diamond)
	context.forceActionsFacet = await ethers.getContractAt("ForceActionsFacet", diamond)
	context.forceCloseStepsFacet = await ethers.getContractAt("ForceCloseStepsFacet", diamond)
	context.clearingHouseFacet = await ethers.getContractAt("ClearingHouseFacet", diamond)
	context.withdrawFacet = await ethers.getContractAt("WithdrawFacet", diamond)
	context.masterAccountMigrationFacet = await ethers.getContractAt("MasterAccountMigrationFacet", diamond)

	context.manager = new TestManager(context, onlyInitialize)
	if (!onlyInitialize) await context.manager.start()

	return context
}
