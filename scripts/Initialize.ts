import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { keccak256, toUtf8Bytes } from "ethers"
import hre, { tasks } from "hardhat"

import { SymbolControlFacet } from "../src/types/index.js"
// Import to initialize the hardhat connection
import "../test/helpers/hardhat-connection.js"
import { createRunContext, RunContext } from "../test/models/RunContext.js"
import { symbolsMock } from "../test/models/SymbolManager.js"
import { decimal } from "../test/utils/Common.js"
import { runTx } from "../test/utils/TxUtils.js"
import { Addresses, loadAddresses, saveAddresses } from "./utils/file.js"
import { assertLocalExecution } from "./utils/localNetworkGuard.js"

export async function initialize(): Promise<RunContext> {
	const runTask = (taskName: string, params: Record<string, unknown> = {}) => tasks.getTask(taskName).run(params)
	const connection = await hre.network.getOrCreate()
	const { ethers } = connection
	const chainId = (await ethers.provider.getNetwork()).chainId
	const runtime = assertLocalExecution(connection as any, chainId, "scripts/Initialize.ts")
	console.log(`Local initializer runtime: ${runtime}, chainId ${chainId}`)
	const [deployer] = await ethers.getSigners()
	if (!deployer) throw new Error("Local initialization requires a configured Hardhat signer")
	const admin = process.env.ADMIN_PUBLIC_KEY || deployer.address
	let collateral = await runTask("deploy:stablecoin")
	let diamond = await runTask("deploy:diamond", {
		logData: false,
		genABI: false,
		reportGas: true,
	})
	const deployMulticall = process.env.DEPLOY_MULTICALL
	if (deployMulticall !== undefined && deployMulticall !== "true" && deployMulticall !== "false") {
		throw new Error("DEPLOY_MULTICALL must be exactly true or false")
	}
	let multicall = deployMulticall === "true" ? await runTask("deploy:multicall") : undefined

	// These tasks return ethers v6 Contract objects, which have no `.address` property —
	// reading it yielded `undefined` and silently poisoned everything downstream.
	const diamondAddress = await diamond.getAddress()
	const collateralAddress = await collateral.getAddress()
	const multicallAddress = multicall ? await multicall.getAddress() : undefined

	await runTask("deploy:multiAccount", { symmioAddress: diamondAddress, admin })

	// createRunContext's third parameter is `onlyInitialize: boolean` — passing an
	// address here coerced to `true` and skipped most of the context setup.
	let context = await createRunContext(diamondAddress, collateralAddress)

	await runTx(context.controlFacet.connect(context.signers.admin).setAdmin(context.signers.admin.getAddress()))
	await runTx(context.controlFacet.connect(context.signers.admin).setCollateral(await context.collateral.getAddress()))
	await runTx(
		context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.getAddress(), keccak256(toUtf8Bytes("SYMBOL_MANAGER_ROLE"))),
	)
	await runTx(
		context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.getAddress(), keccak256(toUtf8Bytes("SETTER_ROLE"))),
	)
	await runTx(
		context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.getAddress(), keccak256(toUtf8Bytes("PAUSER_ROLE"))),
	)
	await runTx(
		context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.getAddress(), keccak256(toUtf8Bytes("PARTY_B_MANAGER_ROLE"))),
	)
	await runTx(
		context.controlFacet
			.connect(context.signers.admin)
			.grantRole(context.signers.admin.getAddress(), keccak256(toUtf8Bytes("AFFILIATE_MANAGER_ROLE"))),
	)
	await runTx(
		context.controlFacet
			.connect(context.signers.admin)
			.grantRole(context.signers.admin.getAddress(), keccak256(toUtf8Bytes("ENTITY_METADATA_MANAGER_ROLE"))),
	)
	await runTx(
		context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.getAddress(), keccak256(toUtf8Bytes("LIQUIDATOR_ROLE"))),
	)
	await runTx(
		context.controlFacet.connect(context.signers.admin).grantRole(context.signers.user.getAddress(), keccak256(toUtf8Bytes("LIQUIDATOR_ROLE"))),
	)
	await runTx(
		context.controlFacet.connect(context.signers.admin).grantRole(context.signers.user2.getAddress(), keccak256(toUtf8Bytes("LIQUIDATOR_ROLE"))),
	)

	// addSymbol moved from ControlFacet to SymbolControlFacet — calling it on
	// controlFacet no longer resolves.
	const addSymbolAsync = async (symbolControlFacet: SymbolControlFacet, adminSigner: HardhatEthersSigner, sym: any) => {
		await runTx(
			symbolControlFacet
				.connect(adminSigner)
				.addSymbol(sym.name, sym.min_acceptable_quote_value, sym.min_acceptable_portion_lf, sym.trading_fee, decimal(100n, 18), 28800, 900),
		)
	}

	for (const sym of symbolsMock.symbols) await addSymbolAsync(context.symbolControlFacet, context.signers.admin, sym)

	await runTx(context.controlFacet.connect(context.signers.admin).setPendingQuotesValidLength(100))
	await runTx(context.controlFacet.connect(context.signers.admin).setLiquidatorShare(decimal(1n, 17)))
	await runTx(context.controlFacet.connect(context.signers.admin).setLiquidationTimeout(100))
	await runTx(context.controlFacet.connect(context.signers.admin).setDeallocateCooldown(120))
	await runTx(context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(decimal(100000n)))
	await runTx(context.controlFacet.connect(context.signers.admin).registerAffiliate(context.accountManager))
	await runTx(context.controlFacet.connect(context.signers.admin).setFeeCollector(context.accountManager, context.signers.feeCollector.address))

	let output: Addresses = loadAddresses()
	output.collateralAddress = collateralAddress
	output.symmioAddress = diamondAddress
	output.MulticallAddress = multicallAddress
	saveAddresses(output)
	return context
}

await initialize()
console.log("Initialized successfully")
