import { ethers, run } from "hardhat"

import { createRunContext, RunContext } from "./models/RunContext"
import { decimal } from "./utils/Common"
import { toUtf8Bytes } from "ethers"
import type { ExternalTransferRelayer as SymmioExternalTransferRelayer, VirtualProvider } from "../src/types";

export async function initializeFixture(): Promise<RunContext> {
	let collateral = await run("deploy:stablecoin")
	let diamond = await run("deploy:diamond", {
		logData: false,
		genABI: false,
		reportGas: true,
	})
	let multicall = process.env.DEPLOY_MULTICALL == "true" ? await run("deploy:multicall") : undefined
	const admin = process.env.ADMIN_PUBLIC_KEY || (await (await ethers.getSigners())[0].getAddress())
	const multiAccount = await run("deploy:multiAccount", {
		symmioAddress: await diamond.getAddress(),
		admin: admin,
	})

	const multiAccount2 = await run("deploy:multiAccount", {
		symmioAddress: await diamond.getAddress(),
		admin: admin,
	})

	const symmioPartyB = await run("deploy:symmioPartyB", {
		symmioAddress: await diamond.getAddress(),
		admin: admin,
	})

	const instantLayer = await run("deploy:InstantLayer", {
		symmioAddress: await diamond.getAddress(),
		admin: admin,
	})

	let context = await createRunContext(await diamond.getAddress(), await collateral.getAddress(), true)
	context.instantLayer = instantLayer
	context.multiAccount = multiAccount
	context.multiAccount2 = multiAccount2
	context.symmioPartyB = symmioPartyB

	await context.controlFacet.connect(context.signers.admin).setAdmin(context.signers.admin.getAddress())

	await context.controlFacet.connect(context.signers.admin).setCollateral(await context.collateral.getAddress())

	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("SYMBOL_MANAGER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("SETTER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("PAUSER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("PARTY_B_MANAGER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("SUSPENDER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("DISPUTE_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("AFFILIATE_MANAGER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("MUON_SETTER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("LIQUIDATOR_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.liquidator.getAddress(), ethers.keccak256(toUtf8Bytes("LIQUIDATOR_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.liquidator.getAddress(), ethers.keccak256(toUtf8Bytes("PARTYB_LIQUIDATOR_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("DEALLOCATE_COOLDOWN_SETTER_ROLE")))
	await context.controlFacet
		.connect(context.signers.admin)
		.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("SUSPENDED_FUNDS_WITHDRAWER_ROLE")))

	await context.controlFacet.grantRole(context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))

	// // Set Muon configuration with sufficient validity time for tests
	// await context.controlFacet.connect(context.signers.admin).setMuonConfig(3600, 3600) // 1 hour validity
	// await context.controlFacet.connect(context.signers.admin).setMuonIds(1, ethers.ZeroAddress, { x: 0, parity: 0 })

	await context.controlFacet
		.connect(context.signers.admin)
		.addSymbol("BTCUSDT", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
	await context.controlFacet.connect(context.signers.admin).setSymbolTypes([1], [1])
	await context.controlFacet.whitelistSymbolType(context.signers.hedger.address, 1)
	await context.controlFacet.whitelistSymbolType(context.signers.hedger2.address, 1)
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
	await context.controlFacet.connect(context.signers.admin).setInvalidBridgedAmountsPool(context.signers.feeCollector.getAddress())
	await context.controlFacet.connect(context.signers.admin).registerPartyB(context.signers.hedger.getAddress())
	await context.controlFacet.connect(context.signers.admin).registerPartyB(context.signers.hedger2.getAddress())
	await context.controlFacet.connect(context.signers.admin).registerAffiliate(context.multiAccount)
	await context.controlFacet.connect(context.signers.admin).registerAffiliate(context.multiAccount2!)
	await context.controlFacet.connect(context.signers.admin).setFeeCollector(context.multiAccount, context.signers.feeCollector.address)
	await context.controlFacet.connect(context.signers.admin).setFeeCollector(context.multiAccount2!, context.signers.feeCollector2.address)

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

	const setterRole = ethers.keccak256(toUtf8Bytes("SETTER_ROLE"))
	const pauserRole = ethers.keccak256(toUtf8Bytes("PAUSER_ROLE"))
	const unpauserRole = ethers.keccak256(toUtf8Bytes("UNPAUSER_ROLE"))

	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, setterRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, pauserRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, unpauserRole)

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

	const setterRole = ethers.keccak256(toUtf8Bytes("SETTER_ROLE"))
	const pauserRole = ethers.keccak256(toUtf8Bytes("PAUSER_ROLE"))
	const unpauserRole = ethers.keccak256(toUtf8Bytes("UNPAUSER_ROLE"))
	const virtualRole = ethers.keccak256(toUtf8Bytes("VIRTUAL_DEPOSITOR_ROLE"))

	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, setterRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, pauserRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(adminAddress, unpauserRole)

	await target.controlFacet.connect(target.signers.admin).setCollateral(await source.collateral.getAddress())
	await target.controlFacet.connect(target.signers.admin).setBalanceLimitPerUser(decimal(10000n))

	await source.controlFacet.connect(source.signers.admin).grantRole(await provider.getAddress(), virtualRole)
	await target.controlFacet.connect(target.signers.admin).grantRole(await provider.getAddress(), virtualRole)

	await source.controlFacet.connect(source.signers.admin).registerVirtualProvider(await provider.getAddress())
	await target.controlFacet.connect(target.signers.admin).registerVirtualProvider(await provider.getAddress())

	return {
		source,
		target,
		provider
	}
}
