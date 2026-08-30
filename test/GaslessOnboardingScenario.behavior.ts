import { expect } from "chai"
import { TypedDataDomain, toUtf8Bytes } from "ethers"

import { deployGaslessLayerLibraries, gaslessLayerFactoryOptions } from "../scripts/gaslessLayer/layer-libraries.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { cloneTypes } from "./helpers/instantLayerEIP712Types.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { RunContext } from "./models/RunContext.js"
import { decimal, getBlockTimestamp } from "./utils/Common.js"

// End-to-end onboarding against the real core + AccountLayer + InstantLayer + GaslessLayer stack:
//
//   1. The service shows the user a deterministic deposit address (their GaslessWallet).
//   2. The user bridges collateral to it.
//   3. A relayer settles the deposit: sweep, create a user-owned sub-account, deposit into core.
//   4. ONE user signature (a delegation-grant operation for a session key) plus session-key-signed
//      operations finish account setup — binding to a solver and approving the operational-fee
//      charger — all inside a single relayed batch, billed atomically after execution.
describe("GaslessLayer onboarding scenario", function () {
	const DEPOSIT_FEE = decimal(2n)
	const MIN_DEPOSIT = decimal(5n)
	const OP_FEE = decimal(1n)
	const BRIDGED_AMOUNT = decimal(100n)
	const FEE_ALLOWANCE = decimal(10n)

	let context: RunContext
	let gateway: any
	let gatewayAddr: string
	let user: any, relayer: any, sessionKey: any, treasury: any
	let symmioAddress: string
	let instantLayerAddress: string
	let domain: TypedDataDomain
	let types: ReturnType<typeof cloneTypes>
	let deadline: bigint

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = context.signers.user
		relayer = context.signers.others[0]
		sessionKey = context.signers.others[1]
		treasury = context.signers.feeCollector

		symmioAddress = context.diamond
		instantLayerAddress = await context.instantLayer.getAddress()

		// Core-side instant layer wiring (mirrors InstantLayer.behavior setup)
		await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		await context.controlFacet.connect(context.signers.admin).registerPartyB(await context.symmioPartyB.getAddress())
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(await context.symmioPartyB.getAddress(), true)

		// Deploy the GaslessLayer gateway (UUPS proxy) against the real stack
		const libraries = await deployGaslessLayerLibraries(ethers)
		const Gateway = await ethers.getContractFactory("GaslessLayer", gaslessLayerFactoryOptions(libraries))
		const impl = await Gateway.deploy()
		const initData = Gateway.interface.encodeFunctionData("initialize", [
			context.signers.admin.address,
			symmioAddress,
			context.accountLayerDiamond,
			instantLayerAddress,
			treasury.address,
			DEPOSIT_FEE,
			MIN_DEPOSIT,
		])
		const Proxy = await ethers.getContractFactory("contracts/gaslessLayer/mocks/LayerProxy.sol:LayerProxy")
		const proxy = await Proxy.deploy(await impl.getAddress(), initData)
		gatewayAddr = await proxy.getAddress()
		gateway = await ethers.getContractAt("GaslessLayer", gatewayAddr)

		// Gateway permissions: relay for the bot, execute on the InstantLayer, create accounts on the AccountLayer
		await gateway.connect(context.signers.admin).grantRole(await gateway.RELAYER_ROLE(), relayer.address)
		await context.instantLayer.grantRole(ethers.keccak256(toUtf8Bytes("OPERATOR_ROLE")), gatewayAddr)
		await context.alControlFacet.connect(context.signers.admin).grantRole(gatewayAddr, ethers.keccak256(toUtf8Bytes("ACCOUNT_CREATOR_ROLE")))

		// Every relayed operation costs a flat operational fee; the gateway must be a registered
		// charger in core before chargeOperationalFee accepts it
		await gateway.connect(context.signers.admin).setDefaultSelectorFee(OP_FEE)
		await context.controlFacet.connect(context.signers.admin).registerOperationalFeeCharger(gatewayAddr)

		domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: instantLayerAddress,
		}
		types = cloneTypes()
		deadline = await getBlockTimestamp(300n)
	})

	function createSignedOperation(signer: string, target: string, callData: string, account: string) {
		return {
			signer,
			target,
			callData,
			signerAccount: { addr: account, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 0n, deadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
		}
	}

	it("onboards a user end to end: deposit address, account creation, then one user signature + session-key setup", async function () {
		// ── 1. Show the user their deposit address ─────────────────────────────
		const depositAddress = await gateway.getGaslessWalletAddress(user.address)

		// ── 2. User bridges collateral to it ───────────────────────────────────
		await context.collateral.mint(depositAddress, BRIDGED_AMOUNT)

		// ── 3. Relayer settles: sweep + create user-owned account + deposit ────
		const affiliate = await context.accountManager.getAddress()
		const accountData = {
			name: "gasless-account",
			metadata: "0x",
			symmioCore: ethers.ZeroAddress, // gateway overrides to its configured core
			isolationType: 3, // CUSTOM
			singleVAMode: false,
		}
		const subAccount = await gateway.connect(relayer).settleDepositToNewAccount.staticCall(user.address, affiliate, accountData)
		await gateway.connect(relayer).settleDepositToNewAccount(user.address, affiliate, accountData)

		expect(await context.alViewFacet.ownerOf(subAccount)).to.equal(user.address)
		expect(await context.viewFacet.balanceOf(subAccount)).to.equal(BRIDGED_AMOUNT - DEPOSIT_FEE)
		expect(await context.collateral.balanceOf(treasury.address)).to.equal(DEPOSIT_FEE)

		// ── 4. One user signature + session-key ops finish setup in one batch ──
		const bindSelector = context.bindingFacet.interface.getFunction("bindToPartyB")!.selector
		const approveSelector = context.accountFacet.interface.getFunction("approveOperationalFee")!.selector
		const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [await context.symmioPartyB.getAddress()])
		const approveCallData = context.accountFacet.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [FEE_ALLOWANCE]])

		const bindOp = createSignedOperation(sessionKey.address, symmioAddress, bindCallData, subAccount)
		const bindSig = await sessionKey.signTypedData(domain, types, bindOp)

		// Sanity: without the grant, the session key has no authority over the account
		await expect(gateway.connect(relayer).relayInstantBatch([bindOp], [bindSig], [[]], [[]])).to.be.revertedWithCustomError(
			context.instantLayer,
			"InvalidDelegation",
		)

		const grantCallData = context.instantLayer.interface.encodeFunctionData("grantDelegation", [
			{
				account: { addr: subAccount, isPartyB: false },
				delegatedSigner: sessionKey.address,
				selectors: [bindSelector, approveSelector],
				expiryTimestamp: await getBlockTimestamp(3600n),
			},
		])
		const grantOp = createSignedOperation(user.address, instantLayerAddress, grantCallData, subAccount)
		const grantSig = await user.signTypedData(domain, types, grantOp) // the single user signature

		const approveOp = createSignedOperation(sessionKey.address, symmioAddress, approveCallData, subAccount)
		const approveSig = await sessionKey.signTypedData(domain, types, approveOp)

		const tx = await gateway
			.connect(relayer)
			.relayInstantBatch([grantOp, bindOp, approveOp], [grantSig, bindSig, approveSig], [[], [], []], [[], [], []])

		// Delegation is live for the session key
		expect(await context.instantLayer.isDelegationActive(subAccount, sessionKey.address, bindSelector)).to.be.true
		expect(await context.instantLayer.isDelegationActive(subAccount, sessionKey.address, approveSelector)).to.be.true

		// Account is bound to the solver
		const bindState = await context.viewFacet.getBindState(subAccount)
		expect(bindState.partyB).to.equal(await context.symmioPartyB.getAddress())

		// Operational-fee charger approved in-batch, then billed for all three ops afterward
		const totalFee = OP_FEE * 3n
		const [allowance] = await context.viewFacet.getOperationalFeeAllowance(subAccount, gatewayAddr)
		expect(allowance).to.equal(FEE_ALLOWANCE - totalFee)
		expect(await context.viewFacet.balanceOf(subAccount)).to.equal(BRIDGED_AMOUNT - DEPOSIT_FEE - totalFee)
		await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 3, 1, totalFee)

		// Replay of the batch is refused (single-use operations)
		await expect(
			gateway.connect(relayer).relayInstantBatch([grantOp, bindOp, approveOp], [grantSig, bindSig, approveSig], [[], [], []], [[], [], []]),
		).to.be.revertedWithCustomError(context.instantLayer, "MaxUsesExceeded")
	})
})
