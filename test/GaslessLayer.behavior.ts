import { expect } from "chai"
import { network } from "hardhat"
import { readFileSync } from "node:fs"

import { GOLDEN_WALLET_INITCODE_HASH, gaslessWalletSalt } from "../scripts/gaslessLayer/gasless-wallet.js"
import { deployGaslessLayerLibraries, gaslessLayerFactoryOptions } from "../scripts/gaslessLayer/layer-libraries.js"

const FEE_SELECTOR = "0x11111111"
const OTHER_SELECTOR = "0x22222222"
const DELEGATION_RELAY_SELECTOR = "0x880231ed"
const WALLET_EXECUTION_SENTINEL_SELECTOR = "0x1dccecab" // bytes4(keccak256("GASLESS_WALLET_EXECUTION"))
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000"
const EIP_170_DEPLOYED_BYTECODE_LIMIT = 24576

describe("GaslessLayer bytecode budget", () => {
	it("keeps the implementation deployable under the EIP-170 size limit", () => {
		const artifact = JSON.parse(readFileSync("artifacts/contracts/gaslessLayer/GaslessLayer.sol/GaslessLayer.json", "utf8"))
		const deployedBytes = (artifact.deployedBytecode.length - 2) / 2

		expect(deployedBytes).to.be.lessThanOrEqual(EIP_170_DEPLOYED_BYTECODE_LIMIT)
	})
})

describe("GaslessLayer", () => {
	let ethers: any
	let admin: any, relayer: any, user: any, treasury: any, stranger: any, affiliate: any
	let collateral: any, core: any, instant: any, accountLayer: any, gateway: any
	let gatewayAddr: string
	const dec = 6
	const u = (n: string) => ethers.parseUnits(n, dec)

	beforeEach(async () => {
		const conn = await network.connect()
		ethers = conn.ethers
		;[admin, relayer, user, treasury, stranger, affiliate] = await ethers.getSigners()

		const ERC20 = await ethers.getContractFactory("contracts/gaslessLayer/mocks/MockERC20.sol:MockERC20")
		collateral = await ERC20.deploy("USD Coin", "USDC", dec)

		const Core = await ethers.getContractFactory("contracts/gaslessLayer/mocks/MockGaslessSymmioCore.sol:MockGaslessSymmioCore")
		core = await Core.deploy(await collateral.getAddress())

		const Instant = await ethers.getContractFactory("contracts/gaslessLayer/mocks/MockInstantLayer.sol:MockInstantLayer")
		instant = await Instant.deploy()

		const Acct = await ethers.getContractFactory("contracts/gaslessLayer/mocks/MockAccountLayer.sol:MockAccountLayer")
		accountLayer = await Acct.deploy()

		const libraries = await deployGaslessLayerLibraries(ethers)
		const Gateway = await ethers.getContractFactory("GaslessLayer", gaslessLayerFactoryOptions(libraries))
		const impl = await Gateway.deploy()
		const initData = Gateway.interface.encodeFunctionData("initialize", [
			admin.address,
			await core.getAddress(),
			await accountLayer.getAddress(),
			await instant.getAddress(),
			treasury.address,
			u("2"),
			u("5"),
		])
		const Proxy = await ethers.getContractFactory("contracts/gaslessLayer/mocks/LayerProxy.sol:LayerProxy")
		const proxy = await Proxy.deploy(await impl.getAddress(), initData)
		gatewayAddr = await proxy.getAddress()
		gateway = await ethers.getContractAt("GaslessLayer", gatewayAddr)

		await gateway.connect(admin).grantRole(await gateway.RELAYER_ROLE(), relayer.address)
		await instant.setExecutor(gatewayAddr) // gateway registered as executor on the instant layer
		await gateway.connect(admin).setMaxNativeGasTopUpAmount(ethers.parseEther("1"))
	})

	// callData carries the operation's 4-byte function selector, which the gateway reads to
	// resolve the fee. Defaults to FEE_SELECTOR so unconfigured-selector tests fall back to the default.
	const makeSignedOp = (signerAccount: string, selector: string = FEE_SELECTOR) => ({
		signer: signerAccount,
		target: gatewayAddr,
		callData: selector,
		signerAccount: { addr: signerAccount, isPartyB: false },
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce: 0, deadline: 0, salt: ZERO_HASH },
	})

	const makeSignedDelegation = (delegator: string, delegate: string, selectors: string[] = [FEE_SELECTOR]) => ({
		delegationInfo: {
			account: { addr: delegator, isPartyB: false },
			delegatedSigner: delegate,
			selectors,
			expiryTimestamp: 9999999999n,
		},
		replayAttackHeader: { nonce: 1, deadline: 0, salt: ZERO_HASH },
	})

	// Full SubAccountCreationData for settleDepositToNewAccount; the gateway overrides symmioCore to its own core.
	const subAccountData = (name: string) => ({
		name,
		metadata: "0x",
		symmioCore: ethers.ZeroAddress,
		isolationType: 3, // CUSTOM
		singleVAMode: false,
	})

	async function findEvent(tx: any, name: string) {
		const rc = await tx.wait()
		for (const log of rc.logs) {
			try {
				const parsed = gateway.interface.parseLog(log)
				if (parsed && parsed.name === name) return parsed
			} catch {
				// not a gateway log
			}
		}
		return null
	}

	const batchArgs = (ops: any[]) =>
		[ops, Array(ops.length).fill("0x"), Array.from({ length: ops.length }, () => []), Array.from({ length: ops.length }, () => [])] as const

	const walletOperationTypes = {
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

	const nativeTopUpTypes = {
		NativeGasTopUpRequest: [
			{ name: "payerAccount", type: "address" },
			{ name: "recipientWallet", type: "address" },
			{ name: "collateralAmount", type: "uint256" },
			{ name: "minNativeAmountOut", type: "uint256" },
			{ name: "nonce", type: "uint256" },
			{ name: "deadline", type: "uint256" },
		],
	}

	const makeNativeTopUpRequest = (overrides: Record<string, any> = {}) => ({
		payerAccount: user.address,
		recipientWallet: user.address,
		collateralAmount: u("100"),
		minNativeAmountOut: ethers.parseEther("0.01"),
		nonce: 0n,
		deadline: 9999999999n,
		...overrides,
	})

	const nativeTopUpFee = (collateralAmount: bigint, feeBps: bigint) => (collateralAmount * feeBps) / 10000n

	async function deployWalletTarget() {
		const WalletTarget = await ethers.getContractFactory("MockWalletTarget")
		return WalletTarget.deploy()
	}

	async function gatewayDomain() {
		return {
			name: "GaslessGateway",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: gatewayAddr,
		}
	}

	async function signWalletOperation(signer: any, op: any) {
		return signer.signTypedData(await gatewayDomain(), walletOperationTypes, op)
	}

	async function signNativeTopUp(signer: any, request: any) {
		return signer.signTypedData(await gatewayDomain(), nativeTopUpTypes, request)
	}

	function walletExecuteData(walletIface: any, calls: Array<{ target: string; value: bigint; data: string }>) {
		return walletIface.encodeFunctionData("execute", [calls])
	}

	async function makeWalletQuoteOp(owner: string = user.address) {
		const walletAddr = await gateway.getGaslessWalletAddress(owner)
		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		return {
			signer: owner,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, [{ target: gatewayAddr, value: 0n, data: FEE_SELECTOR }]),
			signerAccount: { addr: owner, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ZERO_HASH },
		}
	}

	// ───────────────────────── Deposit address ─────────────────────────

	it("derives a deterministic, stable, per-wallet deposit address", async () => {
		const a1 = await gateway.getGaslessWalletAddress(user.address)
		const a2 = await gateway.getGaslessWalletAddress(user.address)
		expect(a1).to.equal(a2)
		expect(a1).to.not.equal(ethers.ZeroAddress)
		expect(await gateway.getGaslessWalletAddress(stranger.address)).to.not.equal(a1)
	})

	it("derives a deterministic versioned GaslessWallet address per owner", async () => {
		// Pin to the frozen golden formula (scripts/gaslessLayer/gasless-wallet.ts), NOT a fresh recompile, so a bytecode
		// or salt-scheme drift that would move every deposit address fails this test too.
		const salt = gaslessWalletSalt(user.address)
		const expected = ethers.getCreate2Address(gatewayAddr, salt, GOLDEN_WALLET_INITCODE_HASH)

		const a1 = await gateway.getGaslessWalletAddress(user.address)
		const a2 = await gateway.getGaslessWalletAddress(user.address)
		const other = await gateway.getGaslessWalletAddress(stranger.address)

		expect(a1).to.equal(expected)
		expect(a1).to.equal(a2)
		expect(a1).to.not.equal(ethers.ZeroAddress)
		expect(other).to.not.equal(a1)
		expect(await ethers.provider.getCode(a1)).to.equal("0x")
	})

	it("GaslessWallet execute is callable only by its layer", async () => {
		const Wallet = await ethers.getContractFactory("GaslessWallet", relayer)
		const wallet = await Wallet.deploy()
		await expect(wallet.connect(stranger).execute([])).to.be.revertedWithCustomError(wallet, "CallerNotGateway")
	})

	it("GaslessWallet execute can call an existing target when invoked by its layer", async () => {
		const Wallet = await ethers.getContractFactory("GaslessWallet", relayer)
		const wallet = await Wallet.deploy()
		const mintData = collateral.interface.encodeFunctionData("mint", [stranger.address, u("1")])

		await wallet.connect(relayer).execute([{ target: await collateral.getAddress(), value: 0, data: mintData }])

		expect(await collateral.balanceOf(stranger.address)).to.equal(u("1"))
	})

	it("GaslessWallet execute wraps failed inner calls with WalletCallFailed", async () => {
		const Wallet = await ethers.getContractFactory("GaslessWallet", relayer)
		const wallet = await Wallet.deploy()
		const transferData = collateral.interface.encodeFunctionData("transfer", [stranger.address, u("1")])

		await expect(
			wallet.connect(relayer).execute([{ target: await collateral.getAddress(), value: 0, data: transferData }]),
		).to.be.revertedWithCustomError(wallet, "WalletCallFailed")
	})

	it("wallet execution can call any target (no target whitelist)", async () => {
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)
		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const marker = ethers.id("no target policy")
		const calls = [{ target: targetAddr, value: 0n, data: target.interface.encodeFunctionData("record", [marker]) }]
		const op = {
			signer: user.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, calls),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ethers.id("no target policy") },
		}

		// The target is never whitelisted: wallet calls now execute solely on the user's signed authority.
		await gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(user, op)], [[]], [[]])
		expect(await target.lastMarker()).to.equal(marker)
	})

	it("wallet operation hash matches frontend gateway-domain typed data and validates a signature", async () => {
		const wallet = await gateway.getGaslessWalletAddress(user.address)
		const op = {
			...makeSignedOp(user.address),
			target: wallet,
			callData: ethers.concat([WALLET_EXECUTION_SENTINEL_SELECTOR, ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [123n])]),
			maxUses: 2n,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ethers.keccak256(ethers.toUtf8Bytes("wallet-op")) },
		}

		const expectedHash = ethers.TypedDataEncoder.hash(await gatewayDomain(), walletOperationTypes, op)
		expect(await gateway.getWalletOperationHash(op)).to.equal(expectedHash)

		const signature = await signWalletOperation(user, op)
		expect(await gateway.isValidWalletOperationSignature(op, signature)).to.equal(true)
	})

	it("exposes wallet typed-data constants on the gateway ABI", async () => {
		expect(await gateway.WALLET_ACCOUNT_TYPEHASH()).to.equal(ethers.id("Account(address addr,bool isPartyB)"))
		expect(await gateway.WALLET_REPLAY_HEADER_TYPEHASH()).to.equal(ethers.id("ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)"))
		expect(await gateway.WALLET_EXECUTION_SENTINEL_SELECTOR()).to.equal(WALLET_EXECUTION_SENTINEL_SELECTOR)
	})

	it("does not expose a separate wallet-only relay entrypoint", async () => {
		expect(gateway.relayWalletBatch).to.equal(undefined)
	})

	it("does not expose a separate allowance-approval relay entrypoint", async () => {
		expect(gateway.relayOperationalFeeApproval).to.equal(undefined)
	})

	it("wallet operation signature check rejects a signature from another signer", async () => {
		const wallet = await gateway.getGaslessWalletAddress(user.address)
		const op = {
			...makeSignedOp(user.address),
			target: wallet,
			callData: "0x12345678",
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ZERO_HASH },
		}

		expect(await gateway.isValidWalletOperationSignature(op, await signWalletOperation(stranger, op))).to.equal(false)
	})

	// ───────────────────── Type 2: deposit + create/fund ─────────────────────

	it("settleDepositToNewAccount: sweeps, takes the fee, creates a wallet-owned account, deposits net", async () => {
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(dep, u("100"))

		const tx = await gateway.connect(relayer).settleDepositToNewAccount(user.address, affiliate.address, subAccountData("Main"))
		const ev = await findEvent(tx, "DepositSettledToNewAccount")
		const sub = ev!.args.subAccount

		expect(await accountLayer.ownerOf(sub)).to.equal(user.address)
		expect(await core.accountBalance(sub)).to.equal(u("98"))
		expect(await collateral.balanceOf(treasury.address)).to.equal(u("2"))
		expect((await ethers.provider.getCode(dep)).length).to.be.greaterThan(2)
		await expect(tx).to.emit(gateway, "DepositFeeCollected").withArgs(user.address, treasury.address, u("2"))
	})

	it("settleDepositToNewAccount: passes the full creation data through, overriding only symmioCore", async () => {
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(dep, u("100"))
		const data = {
			name: "Cross",
			metadata: "0x1234",
			symmioCore: stranger.address,
			isolationType: 1,
			singleVAMode: false,
		}
		await gateway.connect(relayer).settleDepositToNewAccount(user.address, affiliate.address, data)
		// isolation type flowed through unchanged, but symmioCore was forced to the gateway's core.
		expect(await accountLayer.lastSubAccountIsolationType()).to.equal(1)
		expect(await accountLayer.lastSubAccountSymmioCore()).to.equal(await core.getAddress())
		expect(await accountLayer.lastSubAccountSymmioCore()).to.not.equal(stranger.address)
		expect(await accountLayer.lastSubAccountAffiliate()).to.equal(affiliate.address)
	})

	it("settleDepositToNewAccount: reverts if the created account is not owned by the wallet", async () => {
		await accountLayer.setForcedCreatedAccountOwner(stranger.address) // mock returns an account owned by someone else
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(dep, u("100"))
		await expect(
			gateway.connect(relayer).settleDepositToNewAccount(user.address, affiliate.address, subAccountData("Main")),
		).to.be.revertedWithCustomError(gateway, "AccountOwnerMismatch")
	})

	it("settleDepositToExistingAccount: relayer-only, credits the wallet's own account", async () => {
		const sub = ethers.Wallet.createRandom().address
		await accountLayer.setAccountOwner(sub, user.address)
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(dep, u("50"))

		await gateway.connect(relayer).settleDepositToExistingAccount(user.address, sub)
		expect(await core.accountBalance(sub)).to.equal(u("48"))
		expect(await collateral.balanceOf(treasury.address)).to.equal(u("2"))
	})

	it("settleDepositToExistingAccount: rejects a non-relayer caller (no misrouting)", async () => {
		const sub = ethers.Wallet.createRandom().address
		await accountLayer.setAccountOwner(sub, user.address)
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(dep, u("50"))
		await expect(gateway.connect(stranger).settleDepositToExistingAccount(user.address, sub)).to.be.revert(ethers)
	})

	it("settleDepositToExistingAccount: reverts when the account is not owned by the wallet", async () => {
		const sub = ethers.Wallet.createRandom().address
		await accountLayer.setAccountOwner(sub, stranger.address)
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(dep, u("50"))
		await expect(gateway.connect(relayer).settleDepositToExistingAccount(user.address, sub)).to.be.revertedWithCustomError(
			gateway,
			"AccountOwnerMismatch",
		)
	})

	it("reverts below the minimum deposit", async () => {
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(dep, u("4")) // < 5
		await expect(
			gateway.connect(relayer).settleDepositToNewAccount(user.address, affiliate.address, subAccountData("x")),
		).to.be.revertedWithCustomError(gateway, "DepositAmountBelowMinimum")
	})

	it("reuses the wallet on a second deposit (no redeploy)", async () => {
		const sub = ethers.Wallet.createRandom().address
		await accountLayer.setAccountOwner(sub, user.address)
		const dep = await gateway.getGaslessWalletAddress(user.address)

		await collateral.mint(dep, u("50"))
		const tx1 = await gateway.connect(relayer).settleDepositToExistingAccount(user.address, sub)
		expect(await findEvent(tx1, "GaslessWalletDeployed")).to.not.equal(null)

		await collateral.mint(dep, u("30"))
		const tx2 = await gateway.connect(relayer).settleDepositToExistingAccount(user.address, sub)
		expect(await findEvent(tx2, "GaslessWalletDeployed")).to.equal(null) // reused, not redeployed

		expect(await core.accountBalance(sub)).to.equal(u("76")) // 48 + 28
	})

	it("GaslessWallet.sweepTokenBalance is gateway-only", async () => {
		const sub = ethers.Wallet.createRandom().address
		await accountLayer.setAccountOwner(sub, user.address)
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(dep, u("50"))
		await gateway.connect(relayer).settleDepositToExistingAccount(user.address, sub)

		const qWallet = await ethers.getContractAt("GaslessWallet", dep)
		await collateral.mint(dep, u("10"))
		await expect(qWallet.connect(stranger).sweepTokenBalance(await collateral.getAddress(), stranger.address)).to.be.revertedWithCustomError(
			qWallet,
			"CallerNotGateway",
		)
	})

	// ───────────────────── Type 1: instant-layer operations ─────────────────────

	it("relayInstantBatch: charges the resolved fee and forwards the batch", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("0.01"))
		const op = makeSignedOp(user.address)
		const tx = await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(user.address, user.address, u("0.01"))
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("0.01"))
		expect(await instant.lastOperationCount()).to.equal(1)
	})

	it("relayInstantBatch: a pure instant batch with mismatched fill/flex arrays is rejected by the InstantLayer", async () => {
		const op = makeSignedOp(user.address)
		await expect(gateway.connect(relayer).relayInstantBatch([op], ["0x"], [], [[]])).to.be.revertedWithCustomError(instant, "ArrayLengthMismatch")
		await expect(gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [])).to.be.revertedWithCustomError(instant, "ArrayLengthMismatch")
	})

	it("relayInstantBatch: forwards all-instant operations in one InstantLayer batch", async () => {
		const ops = [makeSignedOp(user.address), makeSignedOp(user.address, OTHER_SELECTOR)]
		await gateway.connect(relayer).relayInstantBatch(ops, ["0x", "0x"], [[], []], [[], []])

		expect(await instant.lastOperationCount()).to.equal(2)
		expect(await instant.lastFillsLength()).to.equal(2)
		expect(await instant.lastFlexFillerSignaturesLength()).to.equal(2)
	})

	it("relayInstantBatch: fee == 0 skips chargeOperationalFee but still executes", async () => {
		const op = makeSignedOp(user.address)
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		expect(await core.totalOperationalFeesCharged()).to.equal(0)
		expect(await instant.lastOperationCount()).to.equal(1)
	})

	it("relayInstantBatch lets a user approve the gateway for the first time and then charges the approval fee", async () => {
		await core.setInstantLayer(await instant.getAddress())
		await core.setEnforceOperationalFeeAllowance(true)
		await instant.setTargetExecution(true, await core.getAddress())
		await gateway.connect(admin).setDefaultSelectorFee(u("2"))
		const allowanceBefore = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
		expect(allowanceBefore.allowance).to.equal(0)

		const approvalCall = core.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [u("10")]])
		const approvalOp = {
			...makeSignedOp(user.address),
			target: await core.getAddress(),
			callData: approvalCall,
		}

		const tx = await gateway.connect(relayer).relayInstantBatch([approvalOp], ["0x"], [[]], [[]])
		await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(user.address, user.address, u("2"))
		await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 1, 1, u("2"))

		const allowance = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
		expect(allowance.allowance).to.equal(u("8"))
		expect(await instant.lastOperationCount()).to.equal(1)
	})

	it("relayInstantBatch lets a first approval fund the fees for the rest of the same batch", async () => {
		await core.setInstantLayer(await instant.getAddress())
		await core.setEnforceOperationalFeeAllowance(true)
		await instant.setTargetExecution(true, await core.getAddress())
		await gateway.connect(admin).setDefaultSelectorFee(u("2"))

		const target = await deployWalletTarget()
		const marker = ethers.id("first-approval-follow-up")
		const approvalOp = {
			...makeSignedOp(user.address),
			target: await core.getAddress(),
			callData: core.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [u("10")]]),
		}
		const followUpOp = {
			...makeSignedOp(user.address),
			target: await target.getAddress(),
			callData: target.interface.encodeFunctionData("record", [marker]),
		}

		const allowanceBefore = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
		expect(allowanceBefore.allowance).to.equal(0)

		const tx = await gateway.connect(relayer).relayInstantBatch(...batchArgs([approvalOp, followUpOp]))
		await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 2, 1, u("4"))

		const allowanceAfter = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
		expect(allowanceAfter.allowance).to.equal(u("6"))
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("4"))
		expect(await target.lastMarker()).to.equal(marker)
	})

	it("relayInstantBatch quotes and charges with the multiplier established by the approval", async () => {
		await core.setInstantLayer(await instant.getAddress())
		await core.setEnforceOperationalFeeAllowance(true)
		await instant.setTargetExecution(true, await core.getAddress())
		await gateway.connect(admin).setDefaultSelectorFee(u("2"))

		const approvalOp = {
			...makeSignedOp(user.address),
			target: await core.getAddress(),
			callData: core.interface.encodeFunctionData("approveOperationalFeeWithMultiplier", [[gatewayAddr], [u("10")], [5000]]),
		}

		const quote = await gateway.getAccountOperationalFee(user.address, [approvalOp])
		expect(quote.amountDue).to.equal(u("1"))

		await gateway.connect(relayer).relayInstantBatch([approvalOp], ["0x"], [[]], [[]])
		const allowance = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
		expect(allowance.feeMultiplier).to.equal(5000)
		expect(allowance.allowance).to.equal(u("9"))
	})

	it("relayInstantBatch reverts atomically when a normal batch leaves no fee allowance", async () => {
		await core.setEnforceOperationalFeeAllowance(true)
		await gateway.connect(admin).setDefaultSelectorFee(u("2"))

		const op = {
			...makeSignedOp(user.address, OTHER_SELECTOR),
			target: await core.getAddress(),
		}
		await expect(gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])).to.be.revertedWith("MockCore: insufficient allowance")
		expect(await instant.lastOperationCount()).to.equal(0)
	})

	it("relayInstantBatch rolls the approval back when the new allowance cannot fund the fee", async () => {
		await core.setInstantLayer(await instant.getAddress())
		await core.setEnforceOperationalFeeAllowance(true)
		await instant.setTargetExecution(true, await core.getAddress())
		await gateway.connect(admin).setDefaultSelectorFee(u("2"))

		const approvalOp = {
			...makeSignedOp(user.address),
			target: await core.getAddress(),
			callData: core.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [u("1")]]),
		}

		await expect(gateway.connect(relayer).relayInstantBatch([approvalOp], ["0x"], [[]], [[]])).to.be.revertedWith("MockCore: insufficient allowance")
		const allowance = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
		expect(allowance.allowance).to.equal(0)
		expect(await instant.lastOperationCount()).to.equal(0)
	})

	it("relayInstantBatch post-charges an approval operation that carries flex metadata", async () => {
		await core.setInstantLayer(await instant.getAddress())
		await core.setEnforceOperationalFeeAllowance(true)
		await instant.setTargetExecution(true, await core.getAddress())
		await gateway.connect(admin).setDefaultSelectorFee(u("2"))
		const approvalOp = {
			...makeSignedOp(user.address),
			target: await core.getAddress(),
			callData: core.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [u("10")]]),
			flexFields: [{ offset: 0, length: 4, authorizedFlexFiller: relayer.address }],
		}

		await gateway.connect(relayer).relayInstantBatch([approvalOp], ["0x"], [[]], [["0x"]])
		const allowance = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
		expect(allowance.allowance).to.equal(u("8"))
		expect(await instant.lastOperationCount()).to.equal(1)
	})

	it("relayInstantBatch executes an owner-signed wallet operation and charges the inner selector fees", async () => {
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(walletAddr, u("20"))

		await gateway.connect(admin).setSelectorFeeConfig(collateral.interface.getFunction("approve").selector, true, u("0.25"))
		await gateway.connect(admin).setSelectorFeeConfig(target.interface.getFunction("bridgeToken").selector, true, u("2"))

		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const calls = [
			{ target: await collateral.getAddress(), value: 0n, data: collateral.interface.encodeFunctionData("approve", [targetAddr, u("5")]) },
			{
				target: targetAddr,
				value: 0n,
				data: target.interface.encodeFunctionData("bridgeToken", [await collateral.getAddress(), stranger.address, u("5")]),
			},
		]
		const op = {
			signer: user.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, calls),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ZERO_HASH },
		}

		const tx = await gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(user, op)], [], [])
		await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(user.address, user.address, u("2.25"))
		await expect(tx).to.emit(gateway, "WalletOperationRelayed").withArgs(relayer.address, user.address, walletAddr, 2)
		expect(await collateral.balanceOf(treasury.address)).to.equal(0)
		expect(await collateral.balanceOf(stranger.address)).to.equal(u("5"))
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("2.25"))
	})

	it("relayInstantBatch wallet execution consumes the normal daily free-operation quota", async () => {
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setSelectorFeeConfig(target.interface.getFunction("record").selector, true, u("2"))

		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const op = {
			signer: user.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, [
				{ target: targetAddr, value: 0n, data: target.interface.encodeFunctionData("record", [ethers.zeroPadValue("0x03", 32)]) },
			]),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ethers.id("wallet quota") },
		}

		const tx = await gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(user, op)], [], [])

		await expect(tx).to.emit(gateway, "DailyFreeOpsUsed").withArgs(user.address, 1, 1, 1)
		await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(user.address, user.address, 0)
		expect(await core.totalOperationalFeesCharged()).to.equal(0)
		expect(await gateway.dailyFreeOpsRemaining(user.address)).to.equal(0)
	})

	it("relayInstantBatch rejects wallet operation replay and bad ordered nonce", async () => {
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)

		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const calls = [{ target: targetAddr, value: 0n, data: target.interface.encodeFunctionData("record", [ethers.zeroPadValue("0x01", 32)]) }]
		const op = {
			signer: user.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, calls),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ZERO_HASH },
		}

		await gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(user, op)], [[]], [[]])
		await expect(gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(user, op)], [[]], [[]])).to.be.revertedWithCustomError(
			gateway,
			"WalletOperationInvalidNonce",
		)

		const wrongNonce = { ...op, replayAttackHeader: { nonce: 3n, deadline: 9999999999n, salt: ethers.id("wrong nonce") } }
		await expect(
			gateway.connect(relayer).relayInstantBatch([wrongNonce], [await signWalletOperation(user, wrongNonce)], [[]], [[]]),
		).to.be.revertedWithCustomError(gateway, "WalletOperationInvalidNonce")
	})

	it("relayInstantBatch rejects a non-owner wallet operation signer before wallet calls execute", async () => {
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)

		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const calls = [{ target: targetAddr, value: 0n, data: target.interface.encodeFunctionData("record", [ethers.zeroPadValue("0x02", 32)]) }]
		const op = {
			signer: stranger.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, calls),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ethers.id("wrong signer") },
		}

		await expect(gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(stranger, op)], [[]], [[]]))
			.to.be.revertedWithCustomError(gateway, "WalletDelegationMissing")
			.withArgs(user.address, stranger.address, WALLET_EXECUTION_SENTINEL_SELECTOR)
		expect(await target.lastMarker()).to.equal(ethers.ZeroHash)
		expect(await ethers.provider.getCode(walletAddr)).to.equal("0x")
	})

	it("delegated wallet execution requires sentinel and every inner selector in InstantLayer storage", async () => {
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(walletAddr, u("20"))

		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const approve = collateral.interface.encodeFunctionData("approve", [targetAddr, u("4")])
		const bridge = target.interface.encodeFunctionData("bridgeToken", [await collateral.getAddress(), stranger.address, u("4")])
		const calls = [
			{ target: await collateral.getAddress(), value: 0n, data: approve },
			{ target: targetAddr, value: 0n, data: bridge },
		]
		const op = {
			signer: relayer.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, calls),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 3,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ethers.id("delegated missing selectors") },
		}

		await expect(gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(relayer, op)], [[]], [[]]))
			.to.be.revertedWithCustomError(gateway, "WalletDelegationMissing")
			.withArgs(user.address, relayer.address, WALLET_EXECUTION_SENTINEL_SELECTOR)

		await instant.setDelegation(user.address, relayer.address, WALLET_EXECUTION_SENTINEL_SELECTOR, 9999999999n)
		await instant.setDelegation(user.address, relayer.address, "0x095ea7b3", 9999999999n)
		await expect(gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(relayer, op)], [[]], [[]]))
			.to.be.revertedWithCustomError(gateway, "WalletDelegationMissing")
			.withArgs(user.address, relayer.address, target.interface.getFunction("bridgeToken").selector)

		await instant.setDelegation(user.address, relayer.address, target.interface.getFunction("bridgeToken").selector, 9999999999n)
		await gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(relayer, op)], [[]], [[]])
		expect(await collateral.balanceOf(stranger.address)).to.equal(u("4"))
	})

	it("delegated wallet execution can reuse selectors granted through relayGrantBatchDelegationBySig", async () => {
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)

		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const marker = ethers.id("delegation relay wallet execution")
		const calls = [{ target: targetAddr, value: 0n, data: target.interface.encodeFunctionData("record", [marker]) }]
		const op = {
			signer: relayer.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, calls),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ethers.id("relay granted wallet execution") },
		}
		const signedDelegation = makeSignedDelegation(user.address, relayer.address, [
			WALLET_EXECUTION_SENTINEL_SELECTOR,
			target.interface.getFunction("record").selector,
		])

		await gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234")
		await gateway.connect(relayer).relayInstantBatch([op], [await signWalletOperation(relayer, op)], [[]], [[]])

		expect(await target.lastMarker()).to.equal(marker)
		expect(await ethers.provider.getCode(walletAddr)).to.not.equal("0x")
	})

	it("mixed instant plus wallet batch rolls back instant fees and state when the wallet call reverts", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)
		await collateral.mint(walletAddr, u("10"))
		await gateway.connect(admin).setSelectorFeeConfig(target.interface.getFunction("forceRevert").selector, true, u("2"))

		const instantOp = makeSignedOp(user.address)
		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const walletOp = {
			signer: user.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, [
				{ target: targetAddr, value: 0n, data: target.interface.encodeFunctionData("forceRevert", []) },
			]),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ZERO_HASH },
		}

		await expect(
			gateway.connect(relayer).relayInstantBatch([instantOp, walletOp], ["0x", await signWalletOperation(user, walletOp)], [[], []], [[], []]),
		).to.be.revertedWithCustomError(wallet, "WalletCallFailed")
		expect(await core.operationalFeesCharged(user.address)).to.equal(0)
		expect(await instant.lastOperationCount()).to.equal(0)
		expect(await collateral.balanceOf(walletAddr)).to.equal(u("10"))
		expect(await collateral.balanceOf(treasury.address)).to.equal(0)
	})

	it("mixed instant plus wallet batch keeps instant ops on the single-op dispatch path", async () => {
		const target = await deployWalletTarget()
		const targetAddr = await target.getAddress()
		const walletAddr = await gateway.getGaslessWalletAddress(user.address)

		const marker = ethers.id("mixed wallet dispatch")
		const instantOp = makeSignedOp(user.address)
		const wallet = await ethers.getContractAt("GaslessWallet", walletAddr)
		const walletOp = {
			signer: user.address,
			target: walletAddr,
			callData: walletExecuteData(wallet.interface, [
				{ target: targetAddr, value: 0n, data: target.interface.encodeFunctionData("record", [marker]) },
			]),
			signerAccount: { addr: user.address, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: 9999999999n, salt: ethers.id("mixed dispatch") },
		}

		await gateway.connect(relayer).relayInstantBatch([instantOp, walletOp], ["0x", await signWalletOperation(user, walletOp)], [[], []], [[], []])

		expect(await instant.lastOperationCount()).to.equal(1)
		expect(await target.lastMarker()).to.equal(marker)
	})

	it("relayInstantBatch rejects a mismatched signatures length", async () => {
		const op = makeSignedOp(user.address)
		await expect(gateway.connect(relayer).relayInstantBatch([op], [], [[]], [[]])).to.be.revertedWithCustomError(gateway, "ArrayLengthMismatch")
	})

	it("relayGrantBatchDelegationBySig: charges one configured fee and forwards the delegation", async () => {
		await gateway.connect(admin).setSelectorFeeConfig(DELEGATION_RELAY_SELECTOR, true, u("0.25"))
		const signedDelegation = makeSignedDelegation(user.address, stranger.address, [FEE_SELECTOR, OTHER_SELECTOR])

		const tx = await gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234")

		await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(user.address, user.address, u("0.25"))
		await expect(tx).to.emit(gateway, "DelegationBySigRelayed").withArgs(relayer.address, user.address, user.address, stranger.address, 2, u("0.25"))
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("0.25"))
		expect(await instant.lastDelegationAccount()).to.equal(user.address)
		expect(await instant.lastDelegationDelegate()).to.equal(stranger.address)
		expect(await instant.lastDelegationSelectorCount()).to.equal(2)
		expect(await instant.lastDelegationFirstSelector()).to.equal(FEE_SELECTOR)
		expect(await instant.lastDelegationSignature()).to.equal("0x1234")
	})

	it("relayGrantBatchDelegationBySig: one call consumes one free usage regardless of selector count", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		const signedDelegation = makeSignedDelegation(user.address, stranger.address, [FEE_SELECTOR, OTHER_SELECTOR])

		const freeTx = await gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234")
		await expect(freeTx).to.emit(gateway, "DailyFreeOpsUsed").withArgs(user.address, 1, 1, 1)
		expect(await core.totalOperationalFeesCharged()).to.equal(0)
		expect(await gateway.dailyFreeOpsRemaining(user.address)).to.equal(0)

		await gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234")
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("1"))
	})

	it("relayGrantBatchDelegationBySig: block mode reverts after the one-call quota is exhausted", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true)
		const signedDelegation = makeSignedDelegation(user.address, stranger.address, [FEE_SELECTOR, OTHER_SELECTOR])

		await gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234")
		await expect(gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234"))
			.to.be.revertedWithCustomError(gateway, "DailyFreeOpsLimitExceeded")
			.withArgs(user.address, 1)
	})

	it("relayGrantBatchDelegationBySig: bills a virtual-account delegation to the parent SubAccount", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		const subAccount = ethers.Wallet.createRandom().address
		const virtualAccount = ethers.Wallet.createRandom().address
		await accountLayer.setVirtualAccount(virtualAccount, subAccount)
		const signedDelegation = makeSignedDelegation(virtualAccount, stranger.address)

		const tx = await gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234")

		expect(await core.operationalFeesCharged(subAccount)).to.equal(u("1"))
		expect(await core.operationalFeesCharged(virtualAccount)).to.equal(0)
		await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(virtualAccount, subAccount, u("1"))
		await expect(tx).to.emit(gateway, "DelegationBySigRelayed").withArgs(relayer.address, virtualAccount, subAccount, stranger.address, 1, u("1"))
	})

	it("relayGrantBatchDelegationBySig: applies the resolved payer core multiplier", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		await core.setOperationalFeeMultiplier(user.address, gatewayAddr, 5000)
		const signedDelegation = makeSignedDelegation(user.address, stranger.address)

		await gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234")

		expect(await core.operationalFeesCharged(user.address)).to.equal(u("0.5"))
	})

	it("relayGrantBatchDelegationBySig: rolls back charged fee and free usage when InstantLayer reverts", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		await instant.setForceDelegationFailure(true)
		const signedDelegation = makeSignedDelegation(user.address, stranger.address)

		await expect(gateway.connect(relayer).relayGrantBatchDelegationBySig(signedDelegation, "0x1234")).to.be.revertedWithCustomError(
			instant,
			"ForcedDelegationFailure",
		)

		expect(await core.totalOperationalFeesCharged()).to.equal(0)
		expect(await gateway.dailyFreeOpsRemaining(user.address)).to.equal(1)
	})

	it("relayNativeGasTopUp: forwards relayer-funded native gas within the sponsored daily limit without charging collateral", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(ethers.parseEther("0.05"), false)
		const request = makeNativeTopUpRequest()
		const signature = await signNativeTopUp(user, request)
		const before = await ethers.provider.getBalance(user.address)

		const tx = await gateway.connect(relayer).relayNativeGasTopUp(request, signature, { value: request.minNativeAmountOut })

		await expect(tx)
			.to.emit(gateway, "NativeGasTopUpRelayed")
			.withArgs(relayer.address, user.address, user.address, user.address, request.minNativeAmountOut, request.collateralAmount, 0)
		await expect(tx)
			.to.emit(gateway, "DailyNativeGasSponsored")
			.withArgs(user.address, request.minNativeAmountOut, request.minNativeAmountOut, ethers.parseEther("0.05"))
		expect(await ethers.provider.getBalance(user.address)).to.equal(before + request.minNativeAmountOut)
		expect(await gateway.topUpNonces(user.address)).to.equal(1)
		expect(await core.totalOperationalFeesCharged()).to.equal(0)
	})

	it("relayNativeGasTopUp: rejects invalid signatures, stale deadlines, bad nonces, and native amount below signed minimum", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(ethers.parseEther("1"), false)
		const request = makeNativeTopUpRequest()
		const signature = await signNativeTopUp(user, request)
		const strangerSignature = await signNativeTopUp(stranger, request)

		await expect(
			gateway.connect(relayer).relayNativeGasTopUp(request, strangerSignature, { value: request.minNativeAmountOut }),
		).to.be.revertedWithCustomError(gateway, "InvalidNativeGasTopUpSignature")

		const expired = makeNativeTopUpRequest({ deadline: 1n })
		await expect(gateway.connect(relayer).relayNativeGasTopUp(expired, await signNativeTopUp(user, expired), { value: expired.minNativeAmountOut }))
			.to.be.revertedWithCustomError(gateway, "NativeGasTopUpExpired")
			.withArgs(1)

		const wrongNonce = makeNativeTopUpRequest({ nonce: 7n })
		await expect(
			gateway.connect(relayer).relayNativeGasTopUp(wrongNonce, await signNativeTopUp(user, wrongNonce), { value: wrongNonce.minNativeAmountOut }),
		)
			.to.be.revertedWithCustomError(gateway, "NativeGasTopUpNonceMismatch")
			.withArgs(user.address, 0, 7)

		await expect(gateway.connect(relayer).relayNativeGasTopUp(request, signature, { value: request.minNativeAmountOut - 1n }))
			.to.be.revertedWithCustomError(gateway, "NativeGasTopUpAmountBelowMin")
			.withArgs(request.minNativeAmountOut - 1n, request.minNativeAmountOut)
	})

	it("relayNativeGasTopUp: rejects zero recipient, zero collateral amount, and zero actual native output", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(ethers.parseEther("1"), false)
		const zeroRecipient = makeNativeTopUpRequest({ recipientWallet: ethers.ZeroAddress })
		await expect(
			gateway.connect(relayer).relayNativeGasTopUp(zeroRecipient, await signNativeTopUp(user, zeroRecipient), {
				value: zeroRecipient.minNativeAmountOut,
			}),
		).to.be.revertedWithCustomError(gateway, "ZeroAddress")

		const zeroCollateral = makeNativeTopUpRequest({ collateralAmount: 0n })
		await expect(
			gateway.connect(relayer).relayNativeGasTopUp(zeroCollateral, await signNativeTopUp(user, zeroCollateral), {
				value: zeroCollateral.minNativeAmountOut,
			}),
		).to.be.revertedWithCustomError(gateway, "NativeGasTopUpCollateralAmountZero")

		const zeroNativeOut = makeNativeTopUpRequest({ minNativeAmountOut: 0n })
		await expect(
			gateway.connect(relayer).relayNativeGasTopUp(zeroNativeOut, await signNativeTopUp(user, zeroNativeOut), { value: 0 }),
		).to.be.revertedWithCustomError(gateway, "NativeGasTopUpAmountZero")
	})

	it("relayNativeGasTopUp: rejects actual native output above the configured max", async () => {
		await gateway.connect(admin).setMaxNativeGasTopUpAmount(ethers.parseEther("0.005"))
		await gateway.connect(admin).setNativeGasTopUpConfig(ethers.parseEther("1"), false)
		const request = makeNativeTopUpRequest({ minNativeAmountOut: ethers.parseEther("0.004") })
		const actualNativeOut = ethers.parseEther("0.006")

		await expect(gateway.connect(relayer).relayNativeGasTopUp(request, await signNativeTopUp(user, request), { value: actualNativeOut }))
			.to.be.revertedWithCustomError(gateway, "NativeGasTopUpAmountExceedsMax")
			.withArgs(actualNativeOut, ethers.parseEther("0.005"))
	})

	it("relayNativeGasTopUp: reverts above the sponsored daily native limit in block mode", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(ethers.parseEther("0.015"), true)
		const first = makeNativeTopUpRequest({ minNativeAmountOut: ethers.parseEther("0.01") })
		await gateway.connect(relayer).relayNativeGasTopUp(first, await signNativeTopUp(user, first), { value: first.minNativeAmountOut })

		const second = makeNativeTopUpRequest({ minNativeAmountOut: ethers.parseEther("0.006"), nonce: 1n })
		await expect(gateway.connect(relayer).relayNativeGasTopUp(second, await signNativeTopUp(user, second), { value: second.minNativeAmountOut }))
			.to.be.revertedWithCustomError(gateway, "DailySponsoredNativeLimitExceeded")
			.withArgs(user.address, ethers.parseEther("0.015"))

		await ethers.provider.send("evm_increaseTime", [86400])
		await ethers.provider.send("evm_mine", [])
		await gateway.connect(relayer).relayNativeGasTopUp(second, await signNativeTopUp(user, second), { value: second.minNativeAmountOut })
		expect(await gateway.topUpNonces(user.address)).to.equal(2)
	})

	it("relayNativeGasTopUp: charges signed collateral plus on-chain fee above the sponsored daily native limit in charge mode", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(ethers.parseEther("0.015"), false)
		await gateway.connect(admin).setNativeGasTopUpFeeBps(3)
		const first = makeNativeTopUpRequest({ minNativeAmountOut: ethers.parseEther("0.01") })
		const firstTx = await gateway.connect(relayer).relayNativeGasTopUp(first, await signNativeTopUp(user, first), { value: first.minNativeAmountOut })
		await expect(firstTx)
			.to.emit(gateway, "DailyNativeGasSponsored")
			.withArgs(user.address, first.minNativeAmountOut, first.minNativeAmountOut, ethers.parseEther("0.015"))
		expect(await core.totalOperationalFeesCharged()).to.equal(0)

		const second = makeNativeTopUpRequest({ minNativeAmountOut: ethers.parseEther("0.006"), nonce: 1n, collateralAmount: u("100") })
		const feeAmount = nativeTopUpFee(second.collateralAmount, 3n)
		const totalCharge = second.collateralAmount + feeAmount
		const tx = await gateway.connect(relayer).relayNativeGasTopUp(second, await signNativeTopUp(user, second), {
			value: second.minNativeAmountOut,
		})

		await expect(tx)
			.to.emit(gateway, "NativeGasTopUpRelayed")
			.withArgs(relayer.address, user.address, user.address, user.address, second.minNativeAmountOut, second.collateralAmount, totalCharge)
		expect(await core.operationalFeesCharged(user.address)).to.equal(totalCharge)
		expect(await gateway.topUpNonces(user.address)).to.equal(2)
	})

	it("relayNativeGasTopUp: calculates the fee on-chain and ignores the core multiplier", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(0, false)
		await gateway.connect(admin).setNativeGasTopUpFeeBps(3)
		await core.setOperationalFeeMultiplier(user.address, gatewayAddr, 5000)
		const request = makeNativeTopUpRequest({ collateralAmount: u("100") })
		const feeAmount = u("0.03")
		const totalCharge = u("100.03")

		const quote = await gateway.getNativeGasTopUpCharge(request.collateralAmount)
		expect(quote.feeAmount).to.equal(feeAmount)
		expect(quote.totalCollateralCharge).to.equal(totalCharge)

		const tx = await gateway.connect(relayer).relayNativeGasTopUp(request, await signNativeTopUp(user, request), {
			value: request.minNativeAmountOut,
		})

		await expect(tx)
			.to.emit(gateway, "NativeGasTopUpRelayed")
			.withArgs(relayer.address, user.address, user.address, user.address, request.minNativeAmountOut, request.collateralAmount, totalCharge)
		expect(await core.operationalFeesCharged(user.address)).to.equal(totalCharge)
	})

	it("relayNativeGasTopUp: virtual account requests are signed by the parent owner and use the parent sponsor limit", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(ethers.parseEther("0.02"), true)
		const subAccount = ethers.Wallet.createRandom().address
		const virtualAccount = ethers.Wallet.createRandom().address
		await accountLayer.setAccountOwner(subAccount, user.address)
		await accountLayer.setVirtualAccount(virtualAccount, subAccount)

		const request = makeNativeTopUpRequest({ payerAccount: virtualAccount, minNativeAmountOut: ethers.parseEther("0.012") })
		const tx = await gateway
			.connect(relayer)
			.relayNativeGasTopUp(request, await signNativeTopUp(user, request), { value: request.minNativeAmountOut })

		await expect(tx)
			.to.emit(gateway, "NativeGasTopUpRelayed")
			.withArgs(relayer.address, virtualAccount, subAccount, user.address, request.minNativeAmountOut, request.collateralAmount, 0)
		await expect(tx)
			.to.emit(gateway, "DailyNativeGasSponsored")
			.withArgs(subAccount, request.minNativeAmountOut, request.minNativeAmountOut, ethers.parseEther("0.02"))

		const overLimit = makeNativeTopUpRequest({ payerAccount: virtualAccount, minNativeAmountOut: ethers.parseEther("0.009"), nonce: 1n })
		await expect(
			gateway.connect(relayer).relayNativeGasTopUp(overLimit, await signNativeTopUp(user, overLimit), { value: overLimit.minNativeAmountOut }),
		)
			.to.be.revertedWithCustomError(gateway, "DailySponsoredNativeLimitExceeded")
			.withArgs(subAccount, ethers.parseEther("0.02"))
	})

	it("relayNativeGasTopUp: zero sponsor limit charges every top-up in charge mode", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(0, false)
		await gateway.connect(admin).setNativeGasTopUpFeeBps(3)
		const request = makeNativeTopUpRequest({ collateralAmount: u("100") })
		const signature = await signNativeTopUp(user, request)
		const feeAmount = u("0.03")
		const totalCharge = u("100.03")

		const tx = await gateway.connect(relayer).relayNativeGasTopUp(request, signature, { value: request.minNativeAmountOut })

		await expect(tx)
			.to.emit(gateway, "NativeGasTopUpRelayed")
			.withArgs(relayer.address, user.address, user.address, user.address, request.minNativeAmountOut, request.collateralAmount, totalCharge)
		expect(await core.operationalFeesCharged(user.address)).to.equal(totalCharge)
	})

	it("setNativeGasTopUpFeeBps: rejects rates above 100%", async () => {
		await expect(gateway.connect(admin).setNativeGasTopUpFeeBps(10001))
			.to.be.revertedWithCustomError(gateway, "NativeGasTopUpFeeBpsTooHigh")
			.withArgs(10001)
	})

	it("relayNativeGasTopUp: charge mode rolls back the native transfer when core charging fails", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(0, false)
		await gateway.connect(admin).setNativeGasTopUpFeeBps(3)
		await core.setForceChargeFailure(true)
		const request = makeNativeTopUpRequest()
		const before = await ethers.provider.getBalance(user.address)

		await expect(
			gateway.connect(relayer).relayNativeGasTopUp(request, await signNativeTopUp(user, request), { value: request.minNativeAmountOut }),
		).to.be.revertedWith("MockCore: charge failed")
		expect(await ethers.provider.getBalance(user.address)).to.equal(before)
		expect(await gateway.topUpNonces(user.address)).to.equal(0)
	})

	it("relayNativeGasTopUp: failed native transfer reverts and rolls back nonce and sponsor usage", async () => {
		await gateway.connect(admin).setNativeGasTopUpConfig(ethers.parseEther("1"), false)
		const RejectNativeReceiver = await ethers.getContractFactory("RejectNativeReceiver")
		const rejectingReceiver = await RejectNativeReceiver.deploy()
		const request = makeNativeTopUpRequest({ recipientWallet: await rejectingReceiver.getAddress() })

		await expect(gateway.connect(relayer).relayNativeGasTopUp(request, await signNativeTopUp(user, request), { value: request.minNativeAmountOut }))
			.to.be.revertedWithCustomError(gateway, "NativeGasTransferFailed")
			.withArgs(await rejectingReceiver.getAddress(), request.minNativeAmountOut)

		expect(await gateway.topUpNonces(user.address)).to.equal(0)

		const retry = makeNativeTopUpRequest()
		const retryTx = await gateway.connect(relayer).relayNativeGasTopUp(retry, await signNativeTopUp(user, retry), { value: retry.minNativeAmountOut })
		await expect(retryTx)
			.to.emit(gateway, "DailyNativeGasSponsored")
			.withArgs(user.address, retry.minNativeAmountOut, retry.minNativeAmountOut, ethers.parseEther("1"))
	})

	it("per-key fee overrides the default (configured zero means no charge)", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("0.01"))
		await gateway.connect(admin).setSelectorFeeConfig(FEE_SELECTOR, true, u("0.05"))
		expect(await gateway.getBaseOperationalFee(FEE_SELECTOR)).to.equal(u("0.05"))
		expect(await gateway.getBaseOperationalFee(OTHER_SELECTOR)).to.equal(u("0.01"))

		await gateway.connect(admin).setSelectorFeeConfig(OTHER_SELECTOR, true, 0)
		expect(await gateway.getBaseOperationalFee(OTHER_SELECTOR)).to.equal(0)
	})

	it("rolls back batch state when post-execution fee collection fails", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("0.01"))
		await core.setForceChargeFailure(true)
		await instant.setTargetExecution(true, await core.getAddress())
		const target = await deployWalletTarget()
		const marker = ethers.id("rolled-back-post-charge")
		const op = {
			...makeSignedOp(user.address),
			target: await target.getAddress(),
			callData: target.interface.encodeFunctionData("record", [marker]),
		}
		await expect(gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])).to.be.revertedWith("MockCore: charge failed")
		expect(await instant.lastOperationCount()).to.equal(0)
		expect(await target.lastMarker()).to.equal(ZERO_HASH)
	})

	it("does not collect a fee when execution fails", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("0.01"))
		await instant.setForceExecutionFailure(true)
		const op = makeSignedOp(user.address)
		await expect(gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])).to.be.revertedWithCustomError(
			instant,
			"ForcedExecutionFailure",
		)
		expect(await core.operationalFeesCharged(user.address)).to.equal(0)
	})

	it("requires the gateway to be a registered executor on the instant layer", async () => {
		await instant.setExecutor(stranger.address) // gateway no longer the registered executor
		const op = makeSignedOp(user.address)
		await expect(gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])).to.be.revertedWithCustomError(instant, "NotExecutor")
	})

	it("derives the fee from the operation selector (per-selector beats the default)", async () => {
		const SEL = "0xaaaaaaaa"
		await gateway.connect(admin).setDefaultSelectorFee(u("0.01"))
		await gateway.connect(admin).setSelectorFeeConfig(SEL, true, u("0.05"))
		const op = makeSignedOp(user.address, SEL)
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("0.05"))
	})

	it("sums per-operation fees across a batch", async () => {
		const SEL_A = "0xaaaaaaaa"
		const SEL_B = "0xbbbbbbbb"
		await gateway.connect(admin).setSelectorFeeConfig(SEL_A, true, u("0.01"))
		await gateway.connect(admin).setSelectorFeeConfig(SEL_B, true, u("0.02"))
		const ops = [makeSignedOp(user.address, SEL_A), makeSignedOp(user.address, SEL_B)]
		await gateway.connect(relayer).relayInstantBatch(ops, ["0x", "0x"], [[], []], [[], []])
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("0.03"))
		expect(await instant.lastOperationCount()).to.equal(2)
	})

	it("multi-account batch charges each signer for its own ops", async () => {
		const SEL_A = "0xaaaaaaaa"
		const SEL_B = "0xbbbbbbbb"
		await gateway.connect(admin).setSelectorFeeConfig(SEL_A, true, u("0.01"))
		await gateway.connect(admin).setSelectorFeeConfig(SEL_B, true, u("0.02"))
		const solver = ethers.Wallet.createRandom().address
		const ops = [makeSignedOp(user.address, SEL_A), makeSignedOp(solver, SEL_B)] // user op + solver op
		await gateway.connect(relayer).relayInstantBatch(ops, ["0x", "0x"], [[], []], [[], []])
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("0.01"))
		expect(await core.operationalFeesCharged(solver)).to.equal(u("0.02"))
		expect(await instant.lastOperationCount()).to.equal(2)
	})

	it("multi-account batch: each account gets its own daily free quota", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		const solver = ethers.Wallet.createRandom().address
		// user has 2 ops (1 free + 1 paid); solver has 1 op (free)
		const ops = [makeSignedOp(user.address), makeSignedOp(user.address), makeSignedOp(solver)]
		await gateway.connect(relayer).relayInstantBatch(ops, ["0x", "0x", "0x"], [[], [], []], [[], [], []])
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("1")) // 1 of user's 2 ops paid
		expect(await core.operationalFeesCharged(solver)).to.equal(0) // solver's single op free
	})

	it("emits InstantBatchRelayed with op and account counts", async () => {
		const solver = ethers.Wallet.createRandom().address
		const ops = [makeSignedOp(user.address), makeSignedOp(user.address), makeSignedOp(solver)]
		const tx = await gateway.connect(relayer).relayInstantBatch(ops, ["0x", "0x", "0x"], [[], [], []], [[], [], []])
		// no fees configured → totalFee 0; 3 ops across 2 accounts
		await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 3, 2, 0)
	})

	// ──────────────── Type 1: account-aware fee routing ────────────────

	describe("account-aware fee routing", () => {
		it("routes a virtual-account signer fee to its parent SubAccount", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const subAccount = ethers.Wallet.createRandom().address
			const virtualAccount = ethers.Wallet.createRandom().address
			await accountLayer.setVirtualAccount(virtualAccount, subAccount)

			const tx = await gateway.connect(relayer).relayInstantBatch(...batchArgs([makeSignedOp(virtualAccount)]))

			expect(await core.operationalFeesCharged(subAccount)).to.equal(u("1"))
			expect(await core.operationalFeesCharged(virtualAccount)).to.equal(0)
			await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(virtualAccount, subAccount, u("1"))
			await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 1, 1, u("1"))
		})

		it("collapses sibling virtual accounts under one payer and shared quota", async () => {
			await gateway.connect(admin).setDailyFreeOpsLimit(1)
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const subAccount = ethers.Wallet.createRandom().address
			const longVA = ethers.Wallet.createRandom().address
			const shortVA = ethers.Wallet.createRandom().address
			await accountLayer.setVirtualAccount(longVA, subAccount)
			await accountLayer.setVirtualAccount(shortVA, subAccount)

			const ops = [makeSignedOp(longVA), makeSignedOp(shortVA)]
			const tx = await gateway.connect(relayer).relayInstantBatch(...batchArgs(ops))

			expect(await core.operationalFeesCharged(subAccount)).to.equal(u("1"))
			expect(await core.operationalFeeChargeCount(subAccount)).to.equal(1)
			expect(await core.totalOperationalFeeChargeCount()).to.equal(1)
			expect(await core.operationalFeesCharged(longVA)).to.equal(0)
			expect(await core.operationalFeesCharged(shortVA)).to.equal(0)
			expect(await gateway.dailyFreeOpsRemaining(subAccount)).to.equal(0)
			expect(await gateway.dailyFreeOpsRemaining(longVA)).to.equal(0)
			await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(longVA, subAccount, 0)
			await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(shortVA, subAccount, u("1"))
			await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 2, 1, u("1"))
		})

		it("shared parent quota blocks sibling virtual-account ops in block mode", async () => {
			await gateway.connect(admin).setDailyFreeOpsLimit(1)
			await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true)
			const subAccount = ethers.Wallet.createRandom().address
			const longVA = ethers.Wallet.createRandom().address
			const shortVA = ethers.Wallet.createRandom().address
			await accountLayer.setVirtualAccount(longVA, subAccount)
			await accountLayer.setVirtualAccount(shortVA, subAccount)

			await expect(gateway.connect(relayer).relayInstantBatch(...batchArgs([makeSignedOp(longVA), makeSignedOp(shortVA)])))
				.to.be.revertedWithCustomError(gateway, "DailyFreeOpsLimitExceeded")
				.withArgs(subAccount, 1)
		})

		it("uses the parent core multiplier and ignores a virtual account multiplier", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const subAccount = ethers.Wallet.createRandom().address
			const virtualAccount = ethers.Wallet.createRandom().address
			await accountLayer.setVirtualAccount(virtualAccount, subAccount)
			await core.setOperationalFeeMultiplier(subAccount, gatewayAddr, 5000)
			await core.setOperationalFeeMultiplier(virtualAccount, gatewayAddr, 20000)

			await gateway.connect(relayer).relayInstantBatch(...batchArgs([makeSignedOp(virtualAccount)]))

			expect(await core.operationalFeesCharged(subAccount)).to.equal(u("0.5"))
			expect(await core.operationalFeesCharged(virtualAccount)).to.equal(0)
		})

		it("keeps non-virtual signers billed as-is in mixed batches", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const subAccount = ethers.Wallet.createRandom().address
			const virtualAccount = ethers.Wallet.createRandom().address
			const solver = ethers.Wallet.createRandom().address
			await accountLayer.setVirtualAccount(virtualAccount, subAccount)

			const tx = await gateway.connect(relayer).relayInstantBatch(...batchArgs([makeSignedOp(virtualAccount), makeSignedOp(solver)]))

			expect(await core.operationalFeesCharged(subAccount)).to.equal(u("1"))
			expect(await core.operationalFeesCharged(solver)).to.equal(u("1"))
			expect(await core.operationalFeesCharged(virtualAccount)).to.equal(0)
			await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(virtualAccount, subAccount, u("1"))
			await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(solver, solver, u("1"))
			await expect(tx).to.emit(gateway, "InstantBatchRelayed").withArgs(relayer.address, 2, 2, u("2"))
		})

		it("get helpers resolve virtual accounts to the parent payer", async () => {
			await gateway.connect(admin).setDailyFreeOpsLimit(1)
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const subAccount = ethers.Wallet.createRandom().address
			const virtualAccount = ethers.Wallet.createRandom().address
			await accountLayer.setVirtualAccount(virtualAccount, subAccount)
			await core.setOperationalFeeMultiplier(subAccount, gatewayAddr, 5000)
			await core.setOperationalFeeMultiplier(virtualAccount, gatewayAddr, 20000)

			expect(await gateway.dailyFreeOpsRemaining(virtualAccount)).to.equal(await gateway.dailyFreeOpsRemaining(subAccount))

			const ops = [makeSignedOp(virtualAccount), makeSignedOp(virtualAccount)]
			const actual = await gateway.getAccountOperationalFee(virtualAccount, ops)
			const parent = await gateway.getAccountOperationalFee(subAccount, ops)
			expect(actual.amountDue).to.equal(u("0.5"))
			expect(actual.freeOpsApplied).to.equal(1)
			expect(actual.wouldBlockOnQuota).to.equal(false)
			expect(actual.amountDue).to.equal(parent.amountDue)
			expect(actual.freeOpsApplied).to.equal(parent.freeOpsApplied)
		})
	})

	// ──────────────── Type 1: daily free quota & fee policies ────────────────

	it("policy — N free then block (pre-0.8.6): free up to the limit, then reverts", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(2)
		await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true)
		const op = makeSignedOp(user.address)
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		expect(await core.totalOperationalFeesCharged()).to.equal(0)
		expect(await gateway.dailyFreeOpsRemaining(user.address)).to.equal(0)
		await expect(gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])).to.be.revertedWithCustomError(
			gateway,
			"DailyFreeOpsLimitExceeded",
		)
	})

	it("policy — block mode reverts a batch that would exceed the remaining quota", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(2)
		await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true)
		const ops = [makeSignedOp(user.address), makeSignedOp(user.address), makeSignedOp(user.address)] // 3 > 2
		await expect(gateway.connect(relayer).relayInstantBatch(ops, ["0x", "0x", "0x"], [[], [], []], [[], [], []])).to.be.revertedWithCustomError(
			gateway,
			"DailyFreeOpsLimitExceeded",
		)
	})

	it("policy — N free then $1/op: first op free, then charges the base fee", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setDefaultSelectorFee(u("1")) // base fee $1
		const op = makeSignedOp(user.address)
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]]) // free #1
		expect(await core.totalOperationalFeesCharged()).to.equal(0)
		const tx = await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]]) // pay $1
		await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(user.address, user.address, u("1"))
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("1"))
	})

	it("policy — $1/op with no free tier (limit 0): charges every time", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("1")) // dailyFreeOpsLimit stays 0
		const op = makeSignedOp(user.address)
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("2"))
	})

	it("free quota — a partially-free batch charges only the ops beyond the quota", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(2)
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		const ops = [makeSignedOp(user.address), makeSignedOp(user.address), makeSignedOp(user.address)] // 2 free + 1 paid
		await gateway.connect(relayer).relayInstantBatch(ops, ["0x", "0x", "0x"], [[], [], []], [[], [], []])
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("1")) // only the 3rd op
		expect(await gateway.dailyFreeOpsRemaining(user.address)).to.equal(0)
	})

	it("free quota — resets the next day", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true)
		const op = makeSignedOp(user.address)
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]]) // free #1
		await expect(gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])).to.be.revertedWithCustomError(
			gateway,
			"DailyFreeOpsLimitExceeded",
		)
		await ethers.provider.send("evm_increaseTime", [86400])
		await ethers.provider.send("evm_mine", [])
		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]]) // free again
		expect(await gateway.dailyFreeOpsRemaining(user.address)).to.equal(0)
	})

	it("free quota — disabled (limit 0) with no base fee means unlimited free", async () => {
		const op = makeSignedOp(user.address)
		expect(await gateway.dailyFreeOpsRemaining(user.address)).to.equal(ethers.MaxUint256)
		for (let i = 0; i < 4; i++) {
			await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		}
		expect(await core.totalOperationalFeesCharged()).to.equal(0)
	})

	it("limit 0 + revertWhenFreeQuotaExhausted charges the base fee (does not block everything)", async () => {
		await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true) // dailyFreeOpsLimit stays 0
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		const op = makeSignedOp(user.address)
		const tx = await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
		await expect(tx).to.emit(gateway, "OperationalFeeRouted").withArgs(user.address, user.address, u("1"))
		expect(await core.operationalFeesCharged(user.address)).to.equal(u("1"))
	})

	it("getAccountOperationalFee reflects free quota, paid ops, and block mode", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		const op = makeSignedOp(user.address)

		let q = await gateway.getAccountOperationalFee(user.address, [op]) // first op is free-covered
		expect(q.amountDue).to.equal(0)
		expect(q.freeOpsApplied).to.equal(1)
		expect(q.wouldBlockOnQuota).to.equal(false)

		await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]]) // consume the free op
		q = await gateway.getAccountOperationalFee(user.address, [op])
		expect(q.amountDue).to.equal(u("1"))
		expect(q.freeOpsApplied).to.equal(0)
		expect(q.wouldBlockOnQuota).to.equal(false)

		await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true) // now over-quota would revert
		q = await gateway.getAccountOperationalFee(user.address, [op])
		expect(q.wouldBlockOnQuota).to.equal(true)
		expect(q.amountDue).to.equal(0)
	})

	it("getAccountOperationalFee is scoped to the given account's ops in a multi-account batch", async () => {
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		const solver = ethers.Wallet.createRandom().address
		const ops = [makeSignedOp(user.address), makeSignedOp(solver), makeSignedOp(user.address)] // user: 2 ops, solver: 1 op
		const qUser = await gateway.getAccountOperationalFee(user.address, ops)
		expect(qUser.amountDue).to.equal(u("2"))
		const qSolver = await gateway.getAccountOperationalFee(solver, ops)
		expect(qSolver.amountDue).to.equal(u("1"))
	})

	it("getAccountOperationalFee prices wallet-only operations through inner call selectors", async () => {
		await gateway.connect(admin).setSelectorFeeConfig(FEE_SELECTOR, true, u("2"))
		const walletOp = await makeWalletQuoteOp()

		const q = await gateway.getAccountOperationalFee(user.address, [walletOp])

		expect(q.amountDue).to.equal(u("2"))
		expect(q.freeOpsApplied).to.equal(0)
		expect(q.wouldBlockOnQuota).to.equal(false)
	})

	it("getAccountOperationalFee blocks wallet-only operations when the normal free quota is exhausted in block mode", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true)
		await gateway.connect(relayer).relayInstantBatch([makeSignedOp(user.address)], ["0x"], [[]], [[]])
		const walletOp = await makeWalletQuoteOp()

		const q = await gateway.getAccountOperationalFee(user.address, [walletOp])

		expect(q.amountDue).to.equal(0)
		expect(q.freeOpsApplied).to.equal(0)
		expect(q.wouldBlockOnQuota).to.equal(true)
	})

	it("getAccountOperationalFee applies quota and fees to mixed instant and wallet batches", async () => {
		await gateway.connect(admin).setDailyFreeOpsLimit(1)
		await gateway.connect(admin).setDefaultSelectorFee(u("1"))
		await gateway.connect(admin).setSelectorFeeConfig(FEE_SELECTOR, true, u("2"))
		const walletOp = await makeWalletQuoteOp()
		const ops = [makeSignedOp(user.address), walletOp]

		const q = await gateway.getAccountOperationalFee(user.address, ops)

		expect(q.amountDue).to.equal(u("2"))
		expect(q.freeOpsApplied).to.equal(1)
		expect(q.wouldBlockOnQuota).to.equal(false)
	})

	// ───────────────────────── Access control & config ─────────────────────────

	it("gates relayer-only entrypoints", async () => {
		const op = makeSignedOp(user.address)
		const sub = ethers.Wallet.createRandom().address
		const topUpRequest = makeNativeTopUpRequest()
		await expect(gateway.connect(stranger).relayInstantBatch([op], ["0x"], [[]], [[]])).to.be.revert(ethers)
		await expect(
			gateway.connect(stranger).relayGrantBatchDelegationBySig(makeSignedDelegation(user.address, stranger.address), "0x1234"),
		).to.be.revert(ethers)
		await expect(
			gateway
				.connect(stranger)
				.relayNativeGasTopUp(topUpRequest, await signNativeTopUp(user, topUpRequest), { value: topUpRequest.minNativeAmountOut }),
		).to.be.revert(ethers)
		await expect(gateway.connect(stranger).settleDepositToNewAccount(user.address, affiliate.address, subAccountData("x"))).to.be.revert(ethers)
		await expect(gateway.connect(stranger).settleDepositToExistingAccount(user.address, sub)).to.be.revert(ethers)
	})

	it("recoverNonCollateralToken sweeps a wrong token but never collateral", async () => {
		const Other = await ethers.getContractFactory("MockERC20")
		const other = await Other.deploy("Wrapped X", "WX", 18)
		const dep = await gateway.getGaslessWalletAddress(user.address)
		await other.mint(dep, ethers.parseUnits("3", 18))

		await gateway.connect(admin).recoverNonCollateralToken(user.address, await other.getAddress(), stranger.address)
		expect(await other.balanceOf(stranger.address)).to.equal(ethers.parseUnits("3", 18))

		await expect(
			gateway.connect(admin).recoverNonCollateralToken(user.address, await collateral.getAddress(), stranger.address),
		).to.be.revertedWithCustomError(gateway, "CollateralRecoveryDisabled")
	})

	it("setDepositFeeConfig enforces minimum > fee", async () => {
		await expect(gateway.connect(admin).setDepositFeeConfig(u("5"), u("5"))).to.be.revertedWithCustomError(gateway, "MinimumDepositNotAboveFee")
		await gateway.connect(admin).setDepositFeeConfig(u("1"), u("3"))
		expect(await gateway.depositFee()).to.equal(u("1"))
		expect(await gateway.minimumDeposit()).to.equal(u("3"))
	})

	it("setNativeGasTopUpConfig is config-admin only", async () => {
		await expect(gateway.connect(stranger).setNativeGasTopUpConfig(1, true)).to.be.revert(ethers)
		await gateway.connect(admin).setNativeGasTopUpConfig(1, true)
		expect(await gateway.dailySponsoredNativeLimit()).to.equal(1)
		expect(await gateway.revertWhenNativeSponsorLimitExhausted()).to.equal(true)

		await expect(gateway.connect(stranger).setMaxNativeGasTopUpAmount(ethers.parseEther("0.02"))).to.be.revert(ethers)
		await expect(gateway.connect(admin).setMaxNativeGasTopUpAmount(ethers.parseEther("0.02")))
			.to.emit(gateway, "MaxNativeGasTopUpAmountUpdated")
			.withArgs(ethers.parseEther("0.02"))
		expect(await gateway.maxNativeGasTopUpAmount()).to.equal(ethers.parseEther("0.02"))

		await expect(gateway.connect(stranger).setNativeGasTopUpFeeBps(3)).to.be.revert(ethers)
		await gateway.connect(admin).setNativeGasTopUpFeeBps(3)
		expect(await gateway.nativeGasTopUpFeeBps()).to.equal(3)
	})

	// ───────────────────── core-owned fee multiplier ─────────────────────

	describe("core-owned fee multiplier", () => {
		it("applies the perps-core allowance fee multiplier when charging and reading the current value", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			await core.setOperationalFeeMultiplier(user.address, gatewayAddr, 5000)
			const op = makeSignedOp(user.address)

			const q = await gateway.getAccountOperationalFee(user.address, [op])
			expect(q.amountDue).to.equal(u("0.5"))

			await gateway.connect(relayer).relayInstantBatch([op], ["0x"], [[]], [[]])
			expect(await core.operationalFeesCharged(user.address)).to.equal(u("0.5"))
		})

		it("reads the multiplier from the current core's six-word allowance view", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			await core.setLegacyAllowanceView(true)
			await core.setOperationalFeeMultiplier(user.address, gatewayAddr, 12500)

			const quote = await gateway.getAccountOperationalFee(user.address, [makeSignedOp(user.address)])
			expect(quote.amountDue).to.equal(u("1.25"))
		})

		it("does not expose a gateway-local fee multiplier setter", async () => {
			expect(gateway.setAccountFeeMultiplier).to.equal(undefined)
		})

		it("core multiplier is scoped to the gateway charger", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const solver = ethers.Wallet.createRandom().address
			await core.setOperationalFeeMultiplier(solver, stranger.address, 2000)
			const ops = [makeSignedOp(user.address), makeSignedOp(solver)]
			await gateway.connect(relayer).relayInstantBatch(ops, ["0x", "0x"], [[], []], [[], []])
			expect(await core.operationalFeesCharged(user.address)).to.equal(u("1"))
			expect(await core.operationalFeesCharged(solver)).to.equal(u("1")) // multiplier for another charger is ignored
		})

		it("core multiplier of 0 resolves to the default 1x multiplier", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const solver = ethers.Wallet.createRandom().address
			await core.setOperationalFeeMultiplier(solver, gatewayAddr, 0)
			await gateway.connect(relayer).relayInstantBatch([makeSignedOp(solver)], ["0x"], [[]], [[]])
			expect(await core.operationalFeesCharged(solver)).to.equal(u("1"))
		})

		it("core multiplier above 10000 surcharges", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const vip = ethers.Wallet.createRandom().address
			await core.setOperationalFeeMultiplier(vip, gatewayAddr, 15000) // 150%
			await gateway.connect(relayer).relayInstantBatch([makeSignedOp(vip)], ["0x"], [[]], [[]])
			expect(await core.operationalFeesCharged(vip)).to.equal(u("1.5"))
		})

		it("getAccountOperationalFee reflects the core multiplier", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const solver = ethers.Wallet.createRandom().address
			await core.setOperationalFeeMultiplier(solver, gatewayAddr, 5000) // 50%
			const ops = [makeSignedOp(solver), makeSignedOp(solver)]
			const q = await gateway.getAccountOperationalFee(solver, ops)
			expect(q.amountDue).to.equal(u("1")) // 2 ops × 1 × 50%
		})

		it("does not expose fee helpers with quote or estimate naming", async () => {
			expect(gateway.quoteBaseOperationalFee).to.equal(undefined)
			expect(gateway.quoteGrossOperationalFee).to.equal(undefined)
			expect(gateway.quoteAccountOperationalFee).to.equal(undefined)
			expect(gateway.estimateBaseOperationalFee).to.equal(undefined)
			expect(gateway.estimateGrossOperationalFee).to.equal(undefined)
			expect(gateway.estimateAccountOperationalFee).to.equal(undefined)
			expect(gateway.getGrossOperationalFee).to.equal(undefined)
		})
	})

	// ───────────────────── Type 1b: instant-layer templates ─────────────────────

	describe("Type 1b: instant-layer templates", () => {
		it("relayInstantTemplate executes a first approval before charging its fee", async () => {
			await core.setInstantLayer(await instant.getAddress())
			await core.setEnforceOperationalFeeAllowance(true)
			await instant.setTargetExecution(true, await core.getAddress())
			await gateway.connect(admin).setDefaultSelectorFee(u("2"))

			const approvalOp = {
				...makeSignedOp(user.address),
				target: await core.getAddress(),
				callData: core.interface.encodeFunctionData("approveOperationalFee", [[gatewayAddr], [u("10")]]),
			}

			const allowanceBefore = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
			expect(allowanceBefore.allowance).to.equal(0)

			await gateway.connect(relayer).relayInstantTemplate(7, [approvalOp], ["0x"], [[]], [[]])

			const allowanceAfter = await core.getOperationalFeeAllowance(user.address, gatewayAddr)
			expect(allowanceAfter.allowance).to.equal(u("8"))
			expect(await core.operationalFeesCharged(user.address)).to.equal(u("2"))
		})

		it("relayInstantTemplate forwards the templateId and charges each signer for its ops", async () => {
			const SEL_SEND = "0xaaaaaaaa"
			const SEL_LOCK = "0xbbbbbbbb"
			const SEL_OPEN = "0xcccccccc"
			await gateway.connect(admin).setSelectorFeeConfig(SEL_SEND, true, u("0.01"))
			await gateway.connect(admin).setSelectorFeeConfig(SEL_LOCK, true, u("0.02"))
			await gateway.connect(admin).setSelectorFeeConfig(SEL_OPEN, true, u("0.03"))
			const solver = ethers.Wallet.createRandom().address
			// sendLockOpen: user signs sendQuote; solver signs lockQuote + openPosition
			const ops = [makeSignedOp(user.address, SEL_SEND), makeSignedOp(solver, SEL_LOCK), makeSignedOp(solver, SEL_OPEN)]
			const tx = await gateway.connect(relayer).relayInstantTemplate(7, ops, ["0x", "0x", "0x"], [[], [], []], [[], [], []])
			expect(await instant.lastTemplateId()).to.equal(7)
			expect(await instant.lastOperationCount()).to.equal(3)
			expect(await core.operationalFeesCharged(user.address)).to.equal(u("0.01")) // sendQuote
			expect(await core.operationalFeesCharged(solver)).to.equal(u("0.05")) // lock + open
			await expect(tx).to.emit(gateway, "InstantTemplateRelayed").withArgs(relayer.address, 7, 3, 2, u("0.06"))
		})

		it("relayInstantTemplate rolls back fees when execution fails (atomicity)", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("0.01"))
			await instant.setForceExecutionFailure(true)
			const op = makeSignedOp(user.address)
			await expect(gateway.connect(relayer).relayInstantTemplate(0, [op], ["0x"], [[]], [[]])).to.be.revertedWithCustomError(
				instant,
				"ForcedExecutionFailure",
			)
			expect(await core.operationalFeesCharged(user.address)).to.equal(0)
		})

		it("relayInstantTemplate is relayer-only", async () => {
			const op = makeSignedOp(user.address)
			await expect(gateway.connect(stranger).relayInstantTemplate(0, [op], ["0x"], [[]], [[]])).to.be.revert(ethers)
		})
	})

	describe("fee quote/charge parity", () => {
		// getAccountOperationalFee is the quote the relayer/frontend prices from; relayInstantBatch is the
		// actual charge. The quota clamp is single-sourced (_usedFreeOpsToday / _remainingFreeOps); these
		// assertions lock the two paths together across the quota boundaries so they cannot silently drift.
		const parityOps = (count: number) =>
			Array.from({ length: count }, (_unused, i) => ({
				...makeSignedOp(user.address),
				replayAttackHeader: { nonce: BigInt(i), deadline: 0n, salt: ethers.id(`parity-${i}`) },
			}))

		it("quote equals the charge when a batch straddles the free quota", async () => {
			await gateway.connect(admin).setDailyFreeOpsLimit(2)
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const ops = parityOps(3)

			const [amountDue, freeOpsApplied, wouldBlock] = await gateway.getAccountOperationalFee(user.address, ops)
			expect(wouldBlock).to.equal(false)
			expect(freeOpsApplied).to.equal(2n)
			expect(amountDue).to.equal(u("1")) // 2 free, 1 charged

			const before = await core.operationalFeesCharged(user.address)
			await gateway.connect(relayer).relayInstantBatch(...batchArgs(ops))
			expect((await core.operationalFeesCharged(user.address)) - before).to.equal(amountDue)
		})

		it("quote equals the charge with the quota disabled", async () => {
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			const ops = parityOps(2)

			const [amountDue, freeOpsApplied, wouldBlock] = await gateway.getAccountOperationalFee(user.address, ops)
			expect(wouldBlock).to.equal(false)
			expect(freeOpsApplied).to.equal(0n)
			expect(amountDue).to.equal(u("2"))

			const before = await core.operationalFeesCharged(user.address)
			await gateway.connect(relayer).relayInstantBatch(...batchArgs(ops))
			expect((await core.operationalFeesCharged(user.address)) - before).to.equal(amountDue)
		})

		it("quote flags a block and the charge reverts in block mode", async () => {
			await gateway.connect(admin).setDailyFreeOpsLimit(1)
			await gateway.connect(admin).setDefaultSelectorFee(u("1"))
			await gateway.connect(admin).setRevertWhenFreeQuotaExhausted(true)
			const ops = parityOps(2)

			const [amountDue, , wouldBlock] = await gateway.getAccountOperationalFee(user.address, ops)
			expect(wouldBlock).to.equal(true)
			expect(amountDue).to.equal(0n)

			await expect(gateway.connect(relayer).relayInstantBatch(...batchArgs(ops))).to.be.revertedWithCustomError(gateway, "DailyFreeOpsLimitExceeded")
		})
	})
})
