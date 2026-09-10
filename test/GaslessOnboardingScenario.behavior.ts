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

	// Steps 1-3: deposit address, bridged collateral, relayer-settled account creation.
	async function settleFundedAccount(): Promise<string> {
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
		return subAccount
	}

	it("onboards a user end to end: deposit address, account creation, then one user signature + session-key setup", async function () {
		const subAccount = await settleFundedAccount()

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
		await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 3, totalFee)

		// Replay of the batch is refused (single-use operations)
		await expect(
			gateway.connect(relayer).relayInstantBatch([grantOp, bindOp, approveOp], [grantSig, bindSig, approveSig], [[], [], []], [[], [], []]),
		).to.be.revertedWithCustomError(context.instantLayer, "MaxUsesExceeded")
	})

	// 1-click trading setup: the wallet signs exactly once. That single signature grants two
	// delegates at the same time (a browser session key and a second server-side signer, each with
	// its own selectors and expiry); the fee approval and the solver binding are then signed by
	// those delegates and ride the same relayed batch.
	it("enables 1-click trading for a session key and a second delegate with a single wallet signature", async function () {
		const subAccount = await settleFundedAccount()
		const secondDelegate = context.signers.user2

		let walletSignatures = 0
		const signWithWallet = async (op: any) => {
			walletSignatures++
			return user.signTypedData(domain, types, op)
		}

		const bindSelector = context.bindingFacet.interface.getFunction("bindToPartyB")!.selector
		const approveSelector = context.accountFacet.interface.getFunction("approveOperationalFee")!.selector
		const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [await context.symmioPartyB.getAddress()])
		const approveCallData = context.accountFacet.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [FEE_ALLOWANCE]])

		const sessionExpiry = await getBlockTimestamp(3600n)
		const secondExpiry = await getBlockTimestamp(86400n)
		const grantCallData = context.instantLayer.interface.encodeFunctionData("grantDelegations", [
			[
				{
					account: { addr: subAccount, isPartyB: false },
					delegatedSigner: sessionKey.address,
					selectors: [approveSelector],
					expiryTimestamp: sessionExpiry,
				},
				{
					account: { addr: subAccount, isPartyB: false },
					delegatedSigner: secondDelegate.address,
					selectors: [bindSelector],
					expiryTimestamp: secondExpiry,
				},
			],
		])
		const grantOp = createSignedOperation(user.address, instantLayerAddress, grantCallData, subAccount)
		const grantSig = await signWithWallet(grantOp)

		const approveOp = createSignedOperation(sessionKey.address, symmioAddress, approveCallData, subAccount)
		const approveSig = await sessionKey.signTypedData(domain, types, approveOp)
		const bindOp = createSignedOperation(secondDelegate.address, symmioAddress, bindCallData, subAccount)
		const bindSig = await secondDelegate.signTypedData(domain, types, bindOp)

		const tx = await gateway
			.connect(relayer)
			.relayInstantBatch([grantOp, approveOp, bindOp], [grantSig, approveSig, bindSig], [[], [], []], [[], [], []])

		expect(walletSignatures).to.equal(1)

		// Each delegate got exactly the rights it was granted
		expect(await context.instantLayer.delegations(subAccount, sessionKey.address, approveSelector)).to.equal(sessionExpiry)
		expect(await context.instantLayer.delegations(subAccount, secondDelegate.address, bindSelector)).to.equal(secondExpiry)
		expect(await context.instantLayer.isDelegationActive(subAccount, sessionKey.address, bindSelector)).to.be.false
		expect(await context.instantLayer.isDelegationActive(subAccount, secondDelegate.address, approveSelector)).to.be.false

		// Both delegate-signed operations took effect
		expect((await context.viewFacet.getBindState(subAccount)).partyB).to.equal(await context.symmioPartyB.getAddress())
		const totalFee = OP_FEE * 3n
		const [allowance] = await context.viewFacet.getOperationalFeeAllowance(subAccount, gatewayAddr)
		expect(allowance).to.equal(FEE_ALLOWANCE - totalFee)
		await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 3, totalFee)
	})
	it("keeps a real Core withdrawal available while another indexed deposit settles, then resumes through the wallet", async function () {
		await context.controlFacet.connect(context.signers.admin).setMaxWithdrawParts(1)
		const depositId = 11n
		const withdrawalId = 22n
		const depositWallet = await gateway.getWalletAddress(user.address, depositId)
		const withdrawalWallet = await gateway.getWalletAddress(user.address, withdrawalId)
		await context.collateral.mint(depositWallet, BRIDGED_AMOUNT)
		const affiliate = await context.accountManager.getAddress()
		const accountData = { name: "indexed-account", metadata: "0x", symmioCore: ethers.ZeroAddress, isolationType: 3, singleVAMode: false }
		const subAccount = await gateway.connect(relayer).settleWalletDepositToNewAccount.staticCall(user.address, depositId, affiliate, accountData)
		await gateway.connect(relayer).settleWalletDepositToNewAccount(user.address, depositId, affiliate, accountData)
		const withdrawalAmount = decimal(20n)
		const approveOp = createSignedOperation(
			user.address,
			symmioAddress,
			context.accountFacet.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [FEE_ALLOWANCE]]),
			subAccount,
		)
		const withdrawOp = createSignedOperation(
			user.address,
			symmioAddress,
			context.withdrawFacet.interface.encodeFunctionData("initiateWithdraw", [
				[
					{
						id: 0,
						amount: withdrawalAmount,
						chainId: (await ethers.provider.getNetwork()).chainId,
						receiver: withdrawalWallet,
						virtualProvider: ethers.ZeroAddress,
						expressProvider: ethers.ZeroAddress,
					},
				],
				false,
				"0x",
			]),
			subAccount,
		)
		await gateway
			.connect(relayer)
			.relayWalletBatch(
				[approveOp, withdrawOp],
				[await user.signTypedData(domain, types, approveOp), await user.signTypedData(domain, types, withdrawOp)],
				[[], []],
				[[], []],
				[0, 0],
			)
		await context.withdrawFacet.finalizeWithdrawRequest(subAccount, 1n)
		expect(await context.collateral.balanceOf(withdrawalWallet)).to.equal(withdrawalAmount)
		// No wallet deployment or bridge signature is required to receive the withdrawal.
		expect(await ethers.provider.getCode(withdrawalWallet)).to.equal("0x")
		const nextDepositId = 12n
		await context.collateral.mint(await gateway.getWalletAddress(user.address, nextDepositId), BRIDGED_AMOUNT)
		await gateway.connect(relayer).settleWalletDepositToExistingAccount(user.address, nextDepositId, subAccount)
		expect(await context.collateral.balanceOf(withdrawalWallet)).to.equal(withdrawalAmount)

		// The actual cross-chain bridge is external; this target consumes an exact ERC20 approval.
		const bridge = await (await ethers.getContractFactory("MockWalletTarget")).deploy()
		const wallet = await ethers.getContractAt("GaslessWallet", withdrawalWallet)
		const calls = [
			{
				target: await context.collateral.getAddress(),
				value: 0n,
				data: context.collateral.interface.encodeFunctionData("approve", [bridge.target, withdrawalAmount]),
			},
			{
				target: bridge.target,
				value: 0n,
				data: bridge.interface.encodeFunctionData("bridgeToken", [await context.collateral.getAddress(), sessionKey.address, withdrawalAmount]),
			},
		]
		const bridgeOp = createSignedOperation(user.address, withdrawalWallet, wallet.interface.encodeFunctionData("execute", [calls]), subAccount)
		bridgeOp.replayAttackHeader.nonce = 1n
		const walletTypes = {
			Account: [
				{ name: "addr", type: "address" },
				{ name: "isPartyB", type: "bool" },
			],
			ReplayAttackHeader: [
				{ name: "nonce", type: "uint256" },
				{ name: "deadline", type: "uint256" },
				{ name: "salt", type: "bytes32" },
			],
			SignedOperation: [
				{ name: "signer", type: "address" },
				{ name: "target", type: "address" },
				{ name: "callData", type: "bytes" },
				{ name: "signerAccount", type: "Account" },
				{ name: "replayAttackHeader", type: "ReplayAttackHeader" },
			],
		}
		const signature = await user.signTypedData({ ...domain, name: "GaslessGateway", verifyingContract: gatewayAddr }, walletTypes, bridgeOp)
		const receiverBefore = await context.collateral.balanceOf(sessionKey.address)
		await gateway.connect(relayer).relayWalletBatch([bridgeOp], [signature], [], [], [withdrawalId])
		expect(await context.collateral.balanceOf(sessionKey.address)).to.equal(receiverBefore + withdrawalAmount)
		expect(await context.collateral.balanceOf(withdrawalWallet)).to.equal(0)
		expect(await gateway.walletNonces(withdrawalWallet, subAccount)).to.equal(1)
		expect(await context.viewFacet.balanceOf(subAccount)).to.equal((BRIDGED_AMOUNT - DEPOSIT_FEE) * 2n - withdrawalAmount - OP_FEE * 4n)
	})
})
