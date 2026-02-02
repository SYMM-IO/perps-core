import { tasks } from "hardhat"

import { createRunContext, RunContext } from "../test/models/RunContext.js"
import { decimal } from "../test/utils/Common.js"
import { runTx } from "../test/utils/TxUtils.js"
import { ControlFacet } from "../src/types/index.js"
import { symbolsMock } from "../test/models/SymbolManager.js"
import { Addresses, loadAddresses, saveAddresses } from "./utils/file.js"
import { keccak256, toUtf8Bytes } from "ethers"
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"

// Import to initialize the hardhat connection
import "../test/helpers/hardhat-connection.js"

export async function initialize(): Promise<RunContext> {
	const runTask = (taskName: string, params: Record<string, unknown> = {}) => tasks.getTask(taskName).run(params)
	let collateral = await runTask("deploy:stablecoin")
	let diamond = await runTask("deploy:diamond", {
		logData: false,
		genABI: false,
		reportGas: true,
	})
	let multicall = process.env.DEPLOY_MULTICALL == "true" ? await runTask("deploy:multicall") : undefined

	const multiAccount = await runTask("deploy:multiAccount", { symmioAddress: diamond.address, admin: process.env.ADMIN_PUBLIC_KEY });

	let context = await createRunContext(diamond.address, collateral.address, multiAccount.address)

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
		context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.getAddress(), keccak256(toUtf8Bytes("AFFILIATE_MANAGER_ROLE"))),
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

	const addSymbolAsync = async (controlFacet: ControlFacet, adminSigner: HardhatEthersSigner, sym: any) => {
		await runTx(
			controlFacet
				.connect(adminSigner)
				.addSymbol(sym.name, sym.min_acceptable_quote_value, sym.min_acceptable_portion_lf, sym.trading_fee, decimal(100n, 18), 28800, 900),
		)
	}

	for (const sym of symbolsMock.symbols)
		await addSymbolAsync(context.controlFacet, context.signers.admin, sym);

	await runTx(context.controlFacet.connect(context.signers.admin).setPendingQuotesValidLength(100))
	await runTx(context.controlFacet.connect(context.signers.admin).setLiquidatorShare(decimal(1n, 17)))
	await runTx(context.controlFacet.connect(context.signers.admin).setLiquidationTimeout(100))
	await runTx(context.controlFacet.connect(context.signers.admin).setDeallocateCooldown(120))
	await runTx(context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(decimal(100000n)))
	await runTx(context.controlFacet.connect(context.signers.admin).registerAffiliate(context.accountManager))
	await runTx(context.controlFacet.connect(context.signers.admin).setFeeCollector(context.accountManager, context.signers.feeCollector.address))

	let output: Addresses = loadAddresses()
	output.collateralAddress = collateral.address
	output.symmioAddress = diamond.address
	output.MulticallAddress = multicall?.address
	saveAddresses(output)
	return context
}

await initialize()
console.log("Initialized successfully")
