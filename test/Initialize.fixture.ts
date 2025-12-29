import { toUtf8Bytes } from "ethers";

import { AccountHub, AccountHubLens, AffiliateHub } from "../src/types/index.js";
import type { ExternalTransferRelayer as SymmioExternalTransferRelayer, VirtualProvider } from "../src/types/index.js";
import { deployAccountHub } from "../tasks/deploy/accountHub.js";
import { deployAffiliateHub } from "../tasks/deploy/affiliateHub.js";
import { deployAccountLayerDiamond } from "../tasks/deploy/accountLayerDiamond.js";
import { deployDiamond } from "../tasks/deploy/diamond.js";
import { deployInstantLayer } from "../tasks/deploy/instantLayer.js";
import { deploySymmioPartyB } from "../tasks/deploy/partyB.js";
import { deployStablecoin } from "../tasks/deploy/stablecoin.js";
import { ethers, hre } from "./helpers/hardhat-connection.js";
import { createRunContext, RunContext } from "./models/RunContext.js";
import { decimal } from "./utils/Common.js";











































































































































export async function initializeFixture(): Promise<RunContext> {
	const collateral = await deployStablecoin(hre, { logData: false })
	const diamond = await deployDiamond(hre, {
		logData: false,
		genABI: false,
		reportGas: true,
	})

	const admin = process.env.ADMIN_PUBLIC_KEY || (await (await ethers.getSigners())[0].getAddress())

	const symmioPartyB = await deploySymmioPartyB(hre, {
		symmioAddress: await diamond.getAddress(),
		admin: admin,
	})

	const instantLayer = await deployInstantLayer(hre, {
		symmioaddress: await diamond.getAddress(),
		admin: admin,
	})

	const context = await createRunContext(await diamond.getAddress(), await collateral.getAddress(), true)

	// Deploy AccountLayer Diamond (replaces AccountHub + AffiliateHub)
	const accountLayerResult = await deployAccountLayerDiamond(hre, {
		admin: context.signers.admin,
		symmioFeeReceiver: context.signers.symmioFeeReceiver,
		logData: false,
	})

	const accountLayerDiamondAddress = accountLayerResult.diamond

	// Attach AccountLayer facets to context
	context.accountLayerDiamond = accountLayerDiamondAddress
	context.alCoreFacet = await ethers.getContractAt("contracts/accountLayer/facets/Core/CoreFacet.sol:CoreFacet", accountLayerDiamondAddress)
	context.alMarginFacet = await ethers.getContractAt("contracts/accountLayer/facets/Margin/MarginFacet.sol:MarginFacet", accountLayerDiamondAddress)
	context.alSymmioHookFacet = await ethers.getContractAt("contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet", accountLayerDiamondAddress)
	context.alControlFacet = await ethers.getContractAt("contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet", accountLayerDiamondAddress)
	context.alViewFacet = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", accountLayerDiamondAddress)
	context.alAffiliateFacet = await ethers.getContractAt("contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet", accountLayerDiamondAddress)

	// Grant additional roles via AccountLayer ControlFacet (admin already has DEFAULT_ADMIN_ROLE, SETTER_ROLE, PAUSER_ROLE, UNPAUSER_ROLE, APPROVER_ROLE from init)
	await context.alControlFacet.connect(context.signers.admin).grantRole(await instantLayer.getAddress(), ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))

	// Whitelist the Symmio core
	await context.alControlFacet.connect(context.signers.admin).setWhitelistedSymmioCore(await diamond.getAddress(), true)

	const MockMultiAccount = await ethers.getContractFactory("MockMultiAccount")
	const multiAccountMock = await MockMultiAccount.deploy(diamond)

	// Register first affiliate
	const affiliateData = {
		name: "test affiliate",
		brandColor: "d69d00",
		admin: context.signers.admin.address,
		stakeholders: [
			{
				receiver: context.signers.admin.address,
				share: decimal(9n, 17),
			},
		],
		symmioShare: decimal(1n, 17),
		metadata: "0x",
		legacyMultiAccounts: [await multiAccountMock.getAddress()],
		symmioCores: [await diamond.getAddress()],
	}

	const affiliateAddress = await context.alAffiliateFacet.requestToRegisterAffiliate.staticCall(affiliateData)
	await context.alAffiliateFacet.requestToRegisterAffiliate(affiliateData)

	// Register second affiliate
	const affiliate2Data = {
		name: "test affiliate 2",
		brandColor: "d69d00",
		admin: context.signers.admin.address,
		stakeholders: [
			{
				receiver: context.signers.admin.address,
				share: decimal(9n, 17),
			},
		],
		symmioShare: decimal(1n, 17),
		metadata: "0x",
		legacyMultiAccounts: [await multiAccountMock.getAddress()],
		symmioCores: [await diamond.getAddress()],
	}

	const affiliate2Address = await context.alAffiliateFacet.requestToRegisterAffiliate.staticCall(affiliate2Data)
	await context.alAffiliateFacet.requestToRegisterAffiliate(affiliate2Data)

	// Approve affiliates - grant AFFILIATE_MANAGER_ROLE to accountLayer diamond on core diamond first
	await context.controlFacet.connect(context.signers.admin).setAdmin(context.signers.admin.address)
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(accountLayerDiamondAddress, ethers.keccak256(toUtf8Bytes("AFFILIATE_MANAGER_ROLE")))
	await context.alAffiliateFacet.connect(context.signers.admin).approveAffiliate(affiliateAddress)
	await context.alAffiliateFacet.connect(context.signers.admin).approveAffiliate(affiliate2Address)

	// Set up account managers (via ViewFacet)
	const accManagerAddress = await context.alViewFacet.getAffiliateAccountManager(affiliateAddress)
	const accManager2Address = await context.alViewFacet.getAffiliateAccountManager(affiliate2Address)
	context.accountManager = await ethers.getContractAt("contracts/accountLayer/AccountManager.sol:AccountManager", accManagerAddress)
	context.accountManager2 = await ethers.getContractAt("contracts/accountLayer/AccountManager.sol:AccountManager", accManager2Address)
	context.symmioPartyB = symmioPartyB
	context.instantLayer = instantLayer

	// set AccountLayer diamond address for InstantLayer
	await instantLayer.setAccountHub(accountLayerDiamondAddress)

	// Grant roles to admin
	const rolesToGrant = [
		"SYMBOL_MANAGER_ROLE",
		"PAUSER_ROLE",
		"PARTY_B_MANAGER_ROLE",
		"SUSPENDER_ROLE",
		"DISPUTE_ROLE",
		"AFFILIATE_MANAGER_ROLE",
		"MUON_SETTER_ROLE",
		"LIQUIDATOR_ROLE",
		"DEALLOCATE_COOLDOWN_SETTER_ROLE",
		"INSTANT_LAYER_ROLE",
		"PARTYB_LIQUIDATOR_ROLE",
		"PROTOCOL_CONFIG_ROLE",
		"FEE_ADMIN_ROLE",
		"COOLDOWN_ADMIN_ROLE",
		"PROVIDER_ADMIN_ROLE",
		"INTEGRATION_ADMIN_ROLE",
		"BRIDGE_MANAGER_ROLE",
		"SIGNER_ADMIN_ROLE",
		"EMERGENCY_ADMIN_ROLE",
		"UNSUSPENDER_ROLE",
		"MIGRATION_ROLE",
	]

	for (const role of rolesToGrant) {
		await context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, ethers.keccak256(toUtf8Bytes(role)))
	}

	// Grant liquidator roles (PARTYB_LIQUIDATOR_ROLE is now merged into LIQUIDATOR_ROLE)
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("LIQUIDATOR_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("PARTYB_LIQUIDATOR_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(accountLayerDiamondAddress, ethers.keccak256(toUtf8Bytes("SIGNER_ADMIN_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(accountLayerDiamondAddress, ethers.keccak256(toUtf8Bytes("INTERNAL_TRANSFER_TO_BALANCE_ROLE")))

	// Configure system
	await context.controlFacet.connect(context.signers.admin).setCollateral(await context.collateral.getAddress())
	await context.symbolControlFacet
		.connect(context.signers.admin)
		.addSymbol("BTCUSDT", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("DEALLOCATE_COOLDOWN_SETTER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("SUSPENDED_FUNDS_WITHDRAWER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE")))
	// BINDABLE_SETTER_ROLE merged into PARTY_B_MANAGER_ROLE - no need to grant separately
	await context.controlFacet.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))

	// // Set Muon configuration with sufficient validity time for tests
	// await context.controlFacet.connect(context.signers.admin).setMuonConfig(3600, 3600) // 1 hour validity
	// await context.controlFacet.connect(context.signers.admin).setMuonIds(1, ethers.ZeroAddress, { x: 0, parity: 0 })

	await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([1], [1])
	await context.symbolControlFacet.whitelistSymbolType(context.signers.hedger.address, 1)
	await context.symbolControlFacet.whitelistSymbolType(context.signers.hedger2.address, 1)
	await context.controlFacet.setMaxPartyAConnectionLimit(5)
	await context.controlFacet.connect(context.signers.admin).setPendingQuotesValidLength(10)
	await context.controlFacet.connect(context.signers.admin).setLiquidatorShare(decimal(1n, 17))
	await context.controlFacet.connect(context.signers.admin).setLiquidationTimeout(100)
	await context.controlFacet.connect(context.signers.admin).setDeallocateCooldown(120)
	await context.controlFacet.connect(context.signers.admin).setSettlementCooldown(300)
	await context.controlFacet.connect(context.signers.admin).setDeallocateDebounceTime(120)
	await context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(decimal(10000n))
	await context.controlFacet.connect(context.signers.admin).setForceCloseCooldowns(300, 120)
	await context.controlFacet.connect(context.signers.admin).setForceCancelCooldown(300)
	await context.controlFacet.connect(context.signers.admin).setForceCancelCloseCooldown(300)
	await context.controlFacet.connect(context.signers.admin).setInvalidBridgedAmountsPool(context.signers.feeCollector.address)
	await context.controlFacet.connect(context.signers.admin).registerPartyB(context.signers.hedger.address)
	await context.controlFacet.connect(context.signers.admin).registerPartyB(context.signers.hedger2.address)

	return context
}

export async function initializeExternalTransferRelayerFixture(): Promise<{
	source: RunContext
	target: RunContext
	relayer: SymmioExternalTransferRelayer
}> {
	const source = await initializeFixture()

	const relayerFactory = await ethers.getContractFactory("contracts/helpers/SymmioExternalTransferRelayer.sol:ExternalTransferRelayer")
	const relayer = (await relayerFactory.deploy(await source.signers.admin.getAddress())) as unknown as SymmioExternalTransferRelayer
	await relayer.waitForDeployment()

	const targetDiamond = await deployDiamond(hre, {
		logData: false,
		genABI: false,
		reportGas: true,
	})

	const target = await createRunContext(await targetDiamond.getAddress(), await source.collateral.getAddress(), true)
	const adminAddress = await target.signers.admin.getAddress()

	await target.controlFacet.connect(target.signers.admin).setAdmin(adminAddress)

	const pauserRole = ethers.keccak256(toUtf8Bytes("PAUSER_ROLE"))
	const unpauserRole = ethers.keccak256(toUtf8Bytes("UNPAUSER_ROLE"))
	const protocolConfigRole = ethers.keccak256(toUtf8Bytes("PROTOCOL_CONFIG_ROLE"))

	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, pauserRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, unpauserRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, protocolConfigRole)

	await target.controlFacet.connect(target.signers.admin).setCollateral(await source.collateral.getAddress())
	await target.controlFacet.connect(target.signers.admin).setBalanceLimitPerUser(decimal(10000n))

	const callerRole = await relayer.CALLER_ROLE()
	await relayer.grantRole(callerRole, source.diamond)

	return {
		source,
		target,
		relayer,
	}
}

export async function initializeVirtualFixture(): Promise<{
	source: RunContext
	target: RunContext
	provider: VirtualProvider
}> {
	const source = await initializeFixture()

	const targetDiamond = await deployDiamond(hre, {
		logData: false,
		genABI: false,
		reportGas: true,
	})

	const MockVirtualProvider = await ethers.getContractFactory("contracts/test/MockVirtualProvider.sol:VirtualProvider")
	const provider = (await MockVirtualProvider.deploy(await targetDiamond.getAddress())) as unknown as VirtualProvider
	await provider.waitForDeployment()

	const target = await createRunContext(await targetDiamond.getAddress(), await source.collateral.getAddress(), true)
	const adminAddress = await target.signers.admin.getAddress()

	await target.controlFacet.connect(target.signers.admin).setAdmin(adminAddress)

	const pauserRole = ethers.keccak256(toUtf8Bytes("PAUSER_ROLE"))
	const unpauserRole = ethers.keccak256(toUtf8Bytes("UNPAUSER_ROLE"))
	const virtualRole = ethers.keccak256(toUtf8Bytes("VIRTUAL_DEPOSITOR_ROLE"))
	const protocolConfigRole = ethers.keccak256(toUtf8Bytes("PROTOCOL_CONFIG_ROLE"))
	const providerAdminRole = ethers.keccak256(toUtf8Bytes("PROVIDER_ADMIN_ROLE"))

	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, pauserRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, unpauserRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, protocolConfigRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, providerAdminRole)

	await target.controlFacet.connect(target.signers.admin).setCollateral(await source.collateral.getAddress())
	await target.controlFacet.connect(target.signers.admin).setBalanceLimitPerUser(decimal(10000n))

	await source.controlFacet.connect(source.signers.admin).grantRole(await provider.getAddress(), virtualRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(await provider.getAddress(), virtualRole)

	await source.controlFacet.connect(source.signers.admin).registerVirtualProvider(await provider.getAddress())
	await target.controlFacet.connect(target.signers.admin).registerVirtualProvider(await provider.getAddress())

	return {
		source,
		target,
		provider,
	}
}
