import { expect } from "chai"
import { TypedDataDomain, toUtf8Bytes } from "ethers"

import { gaslessFeeLimitSalt, quoteGaslessFee } from "../scripts/gaslessLayer/fee-quote.js"
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
			DEPOSIT_FEE,
			0,
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
		const depositAddress = await gateway.getGaslessWalletAddress(user.address, 0n)

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
		const subAccount = await gateway.connect(relayer).settleDepositToNewAccount.staticCall(user.address, 0n, affiliate, accountData)
		await gateway.connect(relayer).settleDepositToNewAccount(user.address, 0n, affiliate, accountData)
		return subAccount
	}

	it("quotes real fee approval execution and honors the fee limit bound into the InstantLayer signature", async function () {
		const subAccount = await settleFundedAccount()
		const op = createSignedOperation(
			user.address,
			symmioAddress,
			context.accountFacet.interface.encodeFunctionData("approveOperationalFeeWithMultiplier", [[gatewayAddr], [FEE_ALLOWANCE], [20000]]),
			subAccount,
		)
		op.replayAttackHeader.salt = gaslessFeeLimitSalt(OP_FEE * 2n)
		const signature = await user.signTypedData(domain, types, op)
		const args = [[op], [signature], [[]], [[]], [0n]]
		const callData = gateway.interface.encodeFunctionData("relayInstantBatch", args)
		const before = await context.viewFacet.balanceOf(subAccount)
		const quoted = await quoteGaslessFee({ gateway, callData, mode: "exact", from: relayer.address })
		expect(quoted.status).to.equal("quoted")
		if (quoted.status !== "quoted") throw new Error(quoted.data)
		expect(quoted.quote.totalFee18).to.equal(OP_FEE * 2n)
		expect(await context.viewFacet.balanceOf(subAccount)).to.equal(before)
		// The fee-bearing real Core approval and the InstantLayer replay state both roll back in a quote.
		await gateway.connect(context.signers.admin).setDefaultSelectorFee(OP_FEE * 2n)
		await expect(gateway.connect(relayer).relayInstantBatch(...args)).to.be.revertedWithCustomError(gateway, "FeeLimitExceeded")
		expect(await context.viewFacet.balanceOf(subAccount)).to.equal(before)
		const changed = { ...op, replayAttackHeader: { ...op.replayAttackHeader, salt: ethers.ZeroHash } }
		await expect(gateway.connect(relayer).relayInstantBatch([changed], [signature], [[]], [[]], [0n])).to.be.revert(ethers)
		await gateway.connect(context.signers.admin).setDefaultSelectorFee(OP_FEE)
		await gateway.connect(relayer).relayInstantBatch(...args)
		expect(await context.viewFacet.balanceOf(subAccount)).to.equal(before - quoted.quote.totalFee18)
	})

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
		await expect(gateway.connect(relayer).relayInstantBatch([bindOp], [bindSig], [[]], [[]], [0n])).to.be.revertedWithCustomError(
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
			.relayInstantBatch([grantOp, bindOp, approveOp], [grantSig, bindSig, approveSig], [[], [], []], [[], [], []], [0n, 0n, 0n])

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
			gateway
				.connect(relayer)
				.relayInstantBatch([grantOp, bindOp, approveOp], [grantSig, bindSig, approveSig], [[], [], []], [[], [], []], [0n, 0n, 0n]),
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
			.relayInstantBatch([grantOp, approveOp, bindOp], [grantSig, approveSig, bindSig], [[], [], []], [[], [], []], [0n, 0n, 0n])

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
	it("lets the owner recover a real Core withdrawal with all relayers disabled and no remaining fee allowance", async function () {
		const subAccount = await settleFundedAccount()
		const walletId = 22n
		const wallet = await gateway.getGaslessWalletAddress(user.address, walletId)
		const withdrawalAmount = decimal(20n)
		const creationFee = decimal(3n)
		await gateway.connect(context.signers.admin).setWalletCreationFee(creationFee)
		await context.controlFacet.connect(context.signers.admin).setMaxWithdrawParts(1)
		const approveOp = createSignedOperation(
			user.address,
			symmioAddress,
			context.accountFacet.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [OP_FEE * 2n]]),
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
						receiver: wallet,
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
			.relayInstantBatch(
				[approveOp, withdrawOp],
				[await user.signTypedData(domain, types, approveOp), await user.signTypedData(domain, types, withdrawOp)],
				[[], []],
				[[], []],
				[0, 0],
			)
		await context.withdrawFacet.finalizeWithdrawRequest(subAccount, 1n)
		expect(await context.collateral.balanceOf(wallet)).to.equal(withdrawalAmount)
		expect(await ethers.provider.getCode(wallet)).to.equal("0x")
		expect((await context.viewFacet.getOperationalFeeAllowance(subAccount, gatewayAddr))[0]).to.equal(0n)
		await gateway.connect(context.signers.admin).revokeRole(await gateway.RELAYER_ROLE(), relayer.address)
		await gateway.connect(context.signers.admin).revokeRole(await gateway.RELAYER_ROLE(), context.signers.admin.address)
		const coreBefore = await context.viewFacet.balanceOf(subAccount)
		const userBefore = await context.collateral.balanceOf(user.address)
		const treasuryBefore = await context.collateral.balanceOf(treasury.address)
		const data = gateway.interface.encodeFunctionData("withdrawWalletFunds", [walletId, context.collateral.target, user.address, ethers.MaxUint256])
		const quote = await quoteGaslessFee({ gateway, callData: data, mode: "exact", from: user.address })
		expect(quote.status).to.equal("quoted")
		if (quote.status !== "quoted") throw new Error(quote.data)
		expect(quote.quote.totalFee18).to.equal(creationFee)
		await gateway.connect(user).executeWithFeeLimit(data, quote.quote.totalDebit18)
		expect(await context.collateral.balanceOf(user.address)).to.equal(userBefore + withdrawalAmount - creationFee)
		expect(await context.collateral.balanceOf(treasury.address)).to.equal(treasuryBefore + creationFee)
		expect(await context.collateral.balanceOf(wallet)).to.equal(0n)
		expect(await context.viewFacet.balanceOf(subAccount)).to.equal(coreBefore)
		expect((await context.viewFacet.getOperationalFeeAllowance(subAccount, gatewayAddr))[0]).to.equal(0n)
	})

	it("keeps a real Core withdrawal available while another indexed deposit settles, then resumes through the wallet", async function () {
		const creationFee = decimal(3n)
		await gateway.connect(context.signers.admin).setWalletCreationFee(creationFee)
		await context.controlFacet.connect(context.signers.admin).setMaxWithdrawParts(1)
		const depositId = 11n
		const withdrawalId = 22n
		const depositWallet = await gateway.getGaslessWalletAddress(user.address, depositId)
		const withdrawalWallet = await gateway.getGaslessWalletAddress(user.address, withdrawalId)
		await context.collateral.mint(depositWallet, BRIDGED_AMOUNT)
		const affiliate = await context.accountManager.getAddress()
		const accountData = { name: "indexed-account", metadata: "0x", symmioCore: ethers.ZeroAddress, isolationType: 3, singleVAMode: false }
		const subAccount = await gateway.connect(relayer).settleDepositToNewAccount.staticCall(user.address, depositId, affiliate, accountData)
		await gateway.connect(relayer).settleDepositToNewAccount(user.address, depositId, affiliate, accountData)
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
			.relayInstantBatch(
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
		await context.collateral.mint(await gateway.getGaslessWalletAddress(user.address, nextDepositId), BRIDGED_AMOUNT)
		await gateway.connect(relayer).settleDepositToExistingAccount(user.address, nextDepositId, subAccount)
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
		bridgeOp.replayAttackHeader.salt = gaslessFeeLimitSalt(OP_FEE * 2n + creationFee)
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
		const quote = await gateway.previewFeeQuote(
			gateway.interface.encodeFunctionData("relayInstantBatch", [[bridgeOp], [signature], [], [], [withdrawalId]]),
			0,
		)
		expect(quote.totalFee18).to.equal(OP_FEE * 2n + creationFee)
		const exact = await quoteGaslessFee({
			gateway,
			mode: "exact",
			from: relayer.address,
			callData: gateway.interface.encodeFunctionData("relayInstantBatch", [[bridgeOp], [signature], [], [], [withdrawalId]]),
		})
		expect(exact.status).to.equal("quoted")
		if (exact.status === "quoted") {
			expect(exact.quote.totalFee18).to.equal(OP_FEE * 2n + creationFee)
			expect(exact.quote.payments[0].walletCreationFee18).to.equal(creationFee)
		}
		expect(await ethers.provider.getCode(withdrawalWallet)).to.equal("0x")
		expect(await context.collateral.balanceOf(sessionKey.address)).to.equal(receiverBefore)
		await expect(gateway.connect(relayer).relayInstantBatch([bridgeOp], [signature], [], [], [withdrawalId]))
			.to.emit(gateway, "WalletCreationFeeCollected")
			.withArgs(withdrawalWallet, subAccount, creationFee)
		expect(await context.collateral.balanceOf(sessionKey.address)).to.equal(receiverBefore + withdrawalAmount)
		expect(await context.collateral.balanceOf(withdrawalWallet)).to.equal(0)
		expect(await gateway.walletOperationNonces(user.address, withdrawalId, subAccount)).to.equal(1)
		expect(await context.viewFacet.balanceOf(subAccount)).to.equal(
			(BRIDGED_AMOUNT - DEPOSIT_FEE - creationFee) * 2n - withdrawalAmount - OP_FEE * 4n - creationFee,
		)
		expect(await context.collateral.balanceOf(treasury.address)).to.equal((DEPOSIT_FEE + creationFee) * 2n)
	})

	// Vibe onboarding price: the relayer settles the first deposit into a new account, then one batch grants a
	// session key and deploys the remaining wallets with empty wallet executions. Normal relay-operation fees are
	// separate from this price, so these tests make them zero unless a test says otherwise.
	describe("onboarding price with a new-account settlement fee and per-wallet creation fees", function () {
		const EXISTING_ACCOUNT_FEE = ethers.parseEther("0.05")
		const NEW_ACCOUNT_FEE = ethers.parseEther("0.80")
		const CREATION_FEE = ethers.parseEther("0.10")
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

		async function configurePricing() {
			const admin = context.signers.admin
			// The new-account fee must move first: the shared minimum stays above both settlement fees.
			await gateway.connect(admin).setNewAccountDepositFee(NEW_ACCOUNT_FEE)
			await gateway.connect(admin).setDepositFeeConfig(EXISTING_ACCOUNT_FEE, MIN_DEPOSIT)
			await gateway.connect(admin).setWalletCreationFee(CREATION_FEE)
			await gateway.connect(admin).setDefaultSelectorFee(0)
			await gateway.connect(admin).setDailyFreeOpsLimit(0)
		}

		/// Build the setup batch: owner-signed grant, session-key fee approval, then one empty execution per extra wallet.
		async function setupBatch(subAccount: string, walletCount: number, allowance: bigint, maxCreationFee = CREATION_FEE) {
			const approveSelector = context.accountFacet.interface.getFunction("approveOperationalFee")!.selector
			const sentinel = await gateway.WALLET_EXECUTION_SENTINEL_SELECTOR()
			const walletDomain = { ...domain, name: "GaslessGateway", verifyingContract: gatewayAddr }
			const walletInterface = (await ethers.getContractFactory("GaslessWallet")).interface
			const ids = Array.from({ length: walletCount - 1 }, (_, i) => BigInt(i + 1))
			const wallets: string[] = await Promise.all(ids.map(id => gateway.getGaslessWalletAddress(user.address, id)))
			const walletOps = wallets.map(target => {
				const op = createSignedOperation(sessionKey.address, target, walletInterface.encodeFunctionData("execute", [[]]), subAccount)
				op.replayAttackHeader.nonce = 1n
				// Each empty execution caps its own charge at one creation fee.
				op.replayAttackHeader.salt = gaslessFeeLimitSalt(maxCreationFee)
				return op
			})
			const grantOp = createSignedOperation(
				user.address,
				instantLayerAddress,
				context.instantLayer.interface.encodeFunctionData("grantDelegation", [
					{
						account: { addr: subAccount, isPartyB: false },
						delegatedSigner: sessionKey.address,
						selectors: [approveSelector, sentinel],
						expiryTimestamp: deadline,
					},
				]),
				subAccount,
			)
			const approveOp = createSignedOperation(
				sessionKey.address,
				symmioAddress,
				context.accountFacet.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [allowance]]),
				subAccount,
			)
			const args = [
				[grantOp, approveOp, ...walletOps],
				[
					await user.signTypedData(domain, types, grantOp),
					await sessionKey.signTypedData(domain, types, approveOp),
					...(await Promise.all(walletOps.map(op => sessionKey.signTypedData(walletDomain, walletTypes, op)))),
				],
				[[], [], ...ids.map(() => [])],
				[[], [], ...ids.map(() => [])],
				[0n, 0n, ...ids],
			] as const
			return { args, ids, wallets, walletOps, walletDomain, sentinel }
		}

		for (const walletCount of [2, 3, 4]) {
			it(`charges ${walletCount === 2 ? "$1.00" : walletCount === 3 ? "$1.10" : "$1.20"} for ${walletCount} wallets, then $0.05 per repeat deposit`, async function () {
				await configurePricing()
				const treasuryBefore = await context.collateral.balanceOf(treasury.address)
				const subAccount = await settleFundedAccount()
				const settledBalance = BRIDGED_AMOUNT - NEW_ACCOUNT_FEE - CREATION_FEE
				expect(await context.viewFacet.balanceOf(subAccount)).to.equal(settledBalance)
				expect(await context.collateral.balanceOf(treasury.address)).to.equal(treasuryBefore + NEW_ACCOUNT_FEE + CREATION_FEE)

				const batchFee = CREATION_FEE * BigInt(walletCount - 1)
				const probe = await setupBatch(subAccount, walletCount, batchFee)
				const untouchedFunds = ethers.parseEther("7")
				for (const wallet of probe.wallets) await context.collateral.mint(wallet, untouchedFunds)

				// Without the grant earlier in the batch, the session key cannot execute through the wallets.
				await expect(
					gateway
						.connect(relayer)
						.relayInstantBatch(probe.walletOps, probe.args[1].slice(2), probe.args[2].slice(2), probe.args[3].slice(2), probe.ids),
				).to.be.revertedWithCustomError(gateway, "WalletDelegationMissing")

				async function assertSetupRolledBack() {
					expect(await context.instantLayer.isDelegationActive(subAccount, sessionKey.address, probe.sentinel)).to.be.false
					expect((await context.viewFacet.getOperationalFeeAllowance(subAccount, gatewayAddr))[0]).to.equal(0n)
					expect(await context.viewFacet.balanceOf(subAccount)).to.equal(settledBalance)
					for (const wallet of probe.wallets) {
						expect(await ethers.provider.getCode(wallet)).to.equal("0x")
						expect(await context.collateral.balanceOf(wallet)).to.equal(untouchedFunds)
					}
				}
				await assertSetupRolledBack()
				const short = await setupBatch(subAccount, walletCount, batchFee - 1n)
				await expect(gateway.connect(relayer).relayInstantBatch(...short.args)).to.be.revertedWith("OperationalFee: Allowance exceeded")
				await assertSetupRolledBack()

				const { args, wallets } = await setupBatch(subAccount, walletCount, batchFee)
				const callData = gateway.interface.encodeFunctionData("relayInstantBatch", args)
				const exact = await quoteGaslessFee({ gateway, callData, mode: "exact", from: relayer.address })
				if (exact.status !== "quoted") throw new Error(exact.data)
				expect(exact.quote.totalFee18).to.equal(batchFee)
				await assertSetupRolledBack()

				const tx = await gateway.connect(relayer).relayInstantBatch(...args)
				await expect(tx)
					.to.emit(gateway, "InstantBatchRelayed")
					.withArgs(relayer.address, walletCount + 1, batchFee)
				for (const wallet of wallets) {
					expect(await ethers.provider.getCode(wallet)).not.to.equal("0x")
					expect(await context.collateral.balanceOf(wallet)).to.equal(untouchedFunds)
					await expect(tx).to.emit(gateway, "WalletCreationFeeCollected").withArgs(wallet, subAccount, CREATION_FEE)
				}
				const onboardingCost = NEW_ACCOUNT_FEE + CREATION_FEE * BigInt(walletCount)
				expect(onboardingCost).to.equal(ethers.parseEther(walletCount === 2 ? "1" : walletCount === 3 ? "1.10" : "1.20"))
				expect(await context.viewFacet.balanceOf(subAccount)).to.equal(BRIDGED_AMOUNT - onboardingCost)
				expect((await context.viewFacet.getOperationalFeeAllowance(subAccount, gatewayAddr))[0]).to.equal(0n)

				// Deployed wallets are reused without another creation fee, even with the fee allowance exhausted.
				const repeats = args[0].slice(2).map(op => ({ ...op, replayAttackHeader: { ...op.replayAttackHeader, nonce: 2n } }))
				const walletDomain = { ...domain, name: "GaslessGateway", verifyingContract: gatewayAddr }
				const repeatSigs = await Promise.all(repeats.map(op => sessionKey.signTypedData(walletDomain, walletTypes, op)))
				await expect(
					gateway.connect(relayer).relayInstantBatch(repeats, repeatSigs, args[2].slice(2), args[3].slice(2), args[4].slice(2)),
				).not.to.emit(gateway, "WalletCreationFeeCollected")
				expect(await context.viewFacet.balanceOf(subAccount)).to.equal(BRIDGED_AMOUNT - onboardingCost)

				// Later deposits through the same source wallet into the same account pay only the existing-account fee.
				await context.collateral.mint(await gateway.getGaslessWalletAddress(user.address, 0n), BRIDGED_AMOUNT)
				const nextDeposit = await gateway.connect(relayer).settleDepositToExistingAccount(user.address, 0n, subAccount)
				await expect(nextDeposit).not.to.emit(gateway, "WalletCreationFeeCollected")
				await expect(nextDeposit)
					.to.emit(gateway, "WalletDepositSettled")
					.withArgs(user.address, 0n, subAccount, BRIDGED_AMOUNT - EXISTING_ACCOUNT_FEE, EXISTING_ACCOUNT_FEE, 1)
				expect(await context.viewFacet.balanceOf(subAccount)).to.equal(BRIDGED_AMOUNT * 2n - onboardingCost - EXISTING_ACCOUNT_FEE)
				expect(await context.collateral.balanceOf(treasury.address)).to.equal(treasuryBefore + NEW_ACCOUNT_FEE + CREATION_FEE + EXISTING_ACCOUNT_FEE)
			})
		}

		it("charges a priced delegation grant on top of the onboarding price instead of inside it", async function () {
			await configurePricing()
			const grantFee = ethers.parseEther("0.25")
			const grantSelector = context.instantLayer.interface.getFunction("grantDelegation")!.selector
			await gateway.connect(context.signers.admin).setSelectorFeeConfig(grantSelector, true, grantFee)
			const subAccount = await settleFundedAccount()
			const { args } = await setupBatch(subAccount, 2, grantFee + CREATION_FEE)
			const tx = await gateway.connect(relayer).relayInstantBatch(...args)
			await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(subAccount, subAccount, grantFee)
			await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(subAccount, subAccount, CREATION_FEE)
			expect(await context.viewFacet.balanceOf(subAccount)).to.equal(BRIDGED_AMOUNT - ethers.parseEther("1") - grantFee)
		})

		it("reaches the onboarding price when the daily free quota covers the priced setup operations", async function () {
			await configurePricing()
			await gateway.connect(context.signers.admin).setDefaultSelectorFee(OP_FEE)
			await gateway.connect(context.signers.admin).setDailyFreeOpsLimit(2)
			await gateway.connect(context.signers.admin).setRevertWhenFreeQuotaExhausted(true)
			const subAccount = await settleFundedAccount()
			// Grant and approval use both free slots; the three empty executions use none.
			const { args } = await setupBatch(subAccount, 4, CREATION_FEE * 3n)
			const callData = gateway.interface.encodeFunctionData("relayInstantBatch", args)
			const preview = await quoteGaslessFee({ gateway, callData, mode: "preview" })
			const exact = await quoteGaslessFee({ gateway, callData, mode: "exact", from: relayer.address })
			if (preview.status !== "quoted" || exact.status !== "quoted") throw new Error("setup quote failed")
			for (const quote of [preview.quote, exact.quote]) {
				expect(quote.freeOpsApplied).to.equal(2)
				expect(quote.totalFee18).to.equal(CREATION_FEE * 3n)
			}
			await gateway.connect(relayer).relayInstantBatch(...args)
			expect(await context.viewFacet.balanceOf(subAccount)).to.equal(BRIDGED_AMOUNT - ethers.parseEther("1.20"))
			expect(await gateway.dailyFreeOpsRemaining(subAccount)).to.equal(0)
		})

		it("rejects an empty wallet execution when the creation fee rises above its signed limit", async function () {
			await configurePricing()
			const subAccount = await settleFundedAccount()
			const { args, wallets } = await setupBatch(subAccount, 2, ethers.parseEther("1"))
			await gateway.connect(context.signers.admin).setWalletCreationFee(CREATION_FEE + 1n)
			await expect(gateway.connect(relayer).relayInstantBatch(...args))
				.to.be.revertedWithCustomError(gateway, "FeeLimitExceeded")
				.withArgs(CREATION_FEE + 1n, CREATION_FEE)
			expect(await ethers.provider.getCode(wallets[0])).to.equal("0x")
			await gateway.connect(context.signers.admin).setWalletCreationFee(CREATION_FEE)
			await gateway.connect(relayer).relayInstantBatch(...args)
			expect(await ethers.provider.getCode(wallets[0])).not.to.equal("0x")
		})
	})
})
