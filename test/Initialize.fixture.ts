import { toUtf8Bytes } from "ethers"
import { ethers, run } from "hardhat"

import { AccountHub, AffiliateHub } from "../src/types"
import type { ExternalTransferRelayer as SymmioExternalTransferRelayer, VirtualProvider } from "../src/types"
import { createRunContext, RunContext } from "./models/RunContext"
import { decimal } from "./utils/Common"

export async function initializeFixture(): Promise<RunContext> {
	const collateral = await run("deploy:stablecoin")
	const diamond = await run("deploy:diamond", {
		logData: false,
		genABI: false,
		reportGas: true,
	})

	const admin = process.env.ADMIN_PUBLIC_KEY || (await (await ethers.getSigners())[0].getAddress())

	const symmioPartyB = await run("deploy:symmioPartyB", {
		symmioaddress: await diamond.getAddress(),
		admin: admin,
	})

	const instantLayer = await run("deploy:InstantLayer", {
		symmioaddress: await diamond.getAddress(),
		admin: admin,
	})

	const context = await createRunContext(await diamond.getAddress(), await collateral.getAddress(), true)

	const affiliateHub: AffiliateHub = await run("deploy:affiliateHub", {
		admin: context.signers.admin.address,
		symmiofeereceiver: context.signers.symmioFeeReceiver.address,
		logData: false,
	})

	const accountHub: AccountHub = await run("deploy:accountHub", {
		admin: context.signers.admin.address,
		affiliatehubaddress: await affiliateHub.getAddress(),
		logData: false,
	})

	// Grant roles to affiliate hub
	await affiliateHub.connect(context.signers.admin).grantRole(ethers.keccak256(toUtf8Bytes("SETTER_ROLE")), context.signers.admin.address)
	await affiliateHub.connect(context.signers.admin).grantRole(ethers.keccak256(toUtf8Bytes("APPROVER_ROLE")), context.signers.admin.address)

	await affiliateHub.connect(context.signers.admin).setWhitelistedSymmioCore(diamond, true)
	await affiliateHub.connect(context.signers.admin).setAccountHub(await accountHub.getAddress())

	await accountHub.connect(context.signers.admin).grantRole(ethers.keccak256(toUtf8Bytes("SETTER_ROLE")), context.signers.admin.address)
	await accountHub.connect(context.signers.admin).grantRole(ethers.keccak256(toUtf8Bytes("PAUSER_ROLE")), context.signers.admin.address)
	await accountHub.connect(context.signers.admin).grantRole(ethers.keccak256(toUtf8Bytes("UNPAUSER_ROLE")), context.signers.admin.address)
	await accountHub.connect(context.signers.admin).grantRole(ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")), await instantLayer.getAddress())
	// Grant AffiliateHub DEPLOYER_ROLE on AccountHub so it can deploy AccountManagers
	await accountHub.connect(context.signers.admin).grantRole(ethers.keccak256(toUtf8Bytes("DEPLOYER_ROLE")), await affiliateHub.getAddress())

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

	const affiliateAddress = await affiliateHub.requestToRegisterAffiliate.staticCall(affiliateData)
	await affiliateHub.requestToRegisterAffiliate(affiliateData)

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

	const affiliate2Address = await affiliateHub.requestToRegisterAffiliate.staticCall(affiliate2Data)
	await affiliateHub.requestToRegisterAffiliate(affiliate2Data)

	// Approve affiliates
	await context.controlFacet.connect(context.signers.admin).setAdmin(context.signers.admin.address)
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(await affiliateHub.getAddress(), ethers.keccak256(toUtf8Bytes("AFFILIATE_MANAGER_ROLE")))
	await affiliateHub.connect(context.signers.admin).approveAffiliate(affiliateAddress)
	await affiliateHub.connect(context.signers.admin).approveAffiliate(affiliate2Address)

	// Set up account managers (stored in AffiliateHub)
	const accManagerAddress = await affiliateHub.getAffiliateAccountManager(affiliateAddress)
	const accManager2Address = await affiliateHub.getAffiliateAccountManager(affiliate2Address)
	context.accountManager = await ethers.getContractAt("AccountManager", accManagerAddress)
	context.accountManager2 = await ethers.getContractAt("AccountManager", accManager2Address)
	context.accountHub = accountHub
	context.affiliateHub = affiliateHub
	context.symmioPartyB = symmioPartyB
	context.instantLayer = instantLayer

	// set AccountHub for InstantLayer
	await instantLayer.setAccountHub(await accountHub.getAddress())

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
		.grantRole(await accountHub.getAddress(), ethers.keccak256(toUtf8Bytes("SIGNER_ADMIN_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(await accountHub.getAddress(), ethers.keccak256(toUtf8Bytes("INTERNAL_TRANSFER_TO_BALANCE_ROLE")))

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

	const targetDiamond = await run("deploy:diamond", {
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

	const targetDiamond = await run("deploy:diamond", {
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
