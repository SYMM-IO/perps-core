import { expect } from "chai"

import { deployGaslessLayerLibraries, gaslessLayerFactoryOptions } from "../../scripts/gaslessLayer/layer-libraries.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { createTimelockApprovalSigner } from "../helpers/accountLayerTimelock.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import type { RunContext } from "../models/RunContext.js"

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
type WalletCall = { target: string; value: bigint; data: string }

describe("Gasless wallet delegated authority", function () {
	let context: RunContext
	let gateway: any
	let signerAccount: string
	let wallet: any
	let walletRoot: string
	let sentinel: string
	let wrapperSelector: string
	let transferSelector: string

	async function operation(calls: WalletCall[], signer = context.signers.hedger2, walletId = 0n) {
		const target = await gateway.getGaslessWalletAddress(context.signers.user.address, walletId)
		const op = {
			signer: signer.address,
			target,
			callData: wallet.interface.encodeFunctionData("execute", [calls]),
			signerAccount: { addr: signerAccount, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: {
				nonce: (await gateway.walletOperationNonces(context.signers.user.address, walletId, signerAccount)) + 1n,
				deadline: ethers.MaxUint256,
				salt: ethers.ZeroHash,
			},
		}
		const signature = await signer.signTypedData(
			{
				name: "GaslessGateway",
				version: "1",
				chainId: (await ethers.provider.getNetwork()).chainId,
				verifyingContract: await gateway.getAddress(),
			},
			walletTypes,
			op,
		)
		return { op, signature, walletId }
	}

	async function relay(calls: WalletCall[], signer = context.signers.hedger2, walletId = 0n) {
		const { op, signature } = await operation(calls, signer, walletId)
		return gateway.relayInstantBatch([op], [signature], [], [], [walletId])
	}

	async function grant(selectors: string[]) {
		await context.instantLayer.connect(context.signers.user).grantDelegation({
			account: { addr: signerAccount, isPartyB: false },
			delegatedSigner: context.signers.hedger2.address,
			selectors,
			expiryTimestamp: ethers.MaxUint256,
		})
	}

	function accountCall(data: string): WalletCall {
		return { target: context.accountLayerDiamond, value: 0n, data }
	}

	function wrap(data: string, depth = 1): string {
		for (let i = 0; i < depth; i++) data = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[], data])
		return data
	}

	function transfer(): string {
		return context.alCoreFacet.interface.encodeFunctionData("transferSubAccountOwnership", [walletRoot, context.signers.hedger2.address])
	}

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		const owner = context.signers.user
		const creation = [{ name: "delegation-test", metadata: "0x", symmioCore: context.diamond, isolationType: 0, singleVAMode: false }]
		const affiliate = await context.accountManager.getAddress()
		;[signerAccount] = await context.alCoreFacet.connect(owner).createSubAccounts.staticCall(affiliate, creation)
		await context.alCoreFacet.connect(owner).createSubAccounts(affiliate, creation)
		await context.instantLayer.setAccountLayer(context.accountLayerDiamond)
		const libraries = await deployGaslessLayerLibraries(ethers)
		const factory = await ethers.getContractFactory("GaslessLayer", gaslessLayerFactoryOptions(libraries))
		const implementation = await factory.deploy()
		const init = factory.interface.encodeFunctionData("initialize", [
			context.signers.admin.address,
			context.diamond,
			context.accountLayerDiamond,
			await context.instantLayer.getAddress(),
			context.signers.admin.address,
			0n,
			0n,
			1n,
		])
		const proxy = await (
			await ethers.getContractFactory("contracts/gaslessLayer/mocks/LayerProxy.sol:LayerProxy")
		).deploy(implementation.target, init)
		gateway = await ethers.getContractAt("GaslessLayer", proxy.target)
		await gateway.grantRole(await gateway.RELAYER_ROLE(), context.signers.admin.address)
		wallet = await ethers.getContractAt("GaslessWallet", await gateway.getGaslessWalletAddress(owner.address, 0n))
		sentinel = await gateway.WALLET_EXECUTION_SENTINEL_SELECTOR()
		wrapperSelector = context.alTimelockFacet.interface.getFunction("executeTimelockOp")!.selector
		transferSelector = context.alCoreFacet.interface.getFunction("transferSubAccountOwnership")!.selector
		// Create the affected account through the actual wallet call, so the wallet really owns it.
		await relay([accountCall(context.alCoreFacet.interface.encodeFunctionData("createSubAccounts", [affiliate, creation]))], owner)
		;[walletRoot] = await context.alViewFacet.getUserSubAccountsAddresses(wallet.target, 0, 1)
		expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(wallet.target)
	})

	for (const depth of [1, 3]) {
		it(`rejects a wrapper-only delegation through ${depth} timelock wrappers without consuming the nonce`, async function () {
			await grant([sentinel, wrapperSelector])
			await expect(relay([accountCall(wrap(transfer(), depth))]))
				.to.be.revertedWithCustomError(gateway, "WalletDelegationMissing")
				.withArgs(signerAccount, context.signers.hedger2.address, transferSelector)
			expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(wallet.target)
			expect(await gateway.walletOperationNonces(context.signers.user.address, 0n, signerAccount)).to.equal(1n)
		})

		it(`allows the delegated inner operation through ${depth} wrappers without a wrapper grant`, async function () {
			await grant([sentinel, transferSelector])
			await relay([accountCall(wrap(transfer(), depth))])
			expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(context.signers.hedger2.address)
		})
	}

	it("still requires the sentinel even with permission for the inner operation", async function () {
		await grant([transferSelector])
		await expect(relay([accountCall(wrap(transfer()))]))
			.to.be.revertedWithCustomError(gateway, "WalletDelegationMissing")
			.withArgs(signerAccount, context.signers.hedger2.address, sentinel)
	})

	it("preserves owner-signed wrapped calls without any delegation", async function () {
		await relay([accountCall(wrap(transfer(), 2))], context.signers.user)
		expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(context.signers.hedger2.address)
	})

	it("keeps the independent inner timelock enforced and accepts a valid unlocker approval", async function () {
		const unlocker = context.signers.hedger
		const setup = context.alTimelockFacet.interface.encodeFunctionData("setupTimelocks", [walletRoot, unlocker.address, 300n, [transferSelector]])
		await relay([accountCall(setup)], context.signers.user)
		await grant([sentinel, transferSelector])
		await expect(relay([accountCall(wrap(transfer()))])).to.be.revertedWithCustomError(wallet, "WalletCallFailed")
		expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(wallet.target)
		const signApproval = createTimelockApprovalSigner(
			{
				name: "SymmioAccountLayerTimelock",
				version: "1",
				chainId: (await ethers.provider.getNetwork()).chainId,
				verifyingContract: context.accountLayerDiamond,
			},
			unlocker,
			walletRoot,
		)
		const signed = await signApproval(ethers.keccak256(transfer()))
		await relay([accountCall(context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[signed], transfer()]))])
		expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(context.signers.hedger2.address)
	})

	for (const nested of [false, true]) {
		for (const mutation of ["head", "offset", "length", "selector"]) {
			it(`rejects malformed ${nested ? "nested" : "outer"} wrapper ${mutation}`, async function () {
				await grant([sentinel, wrapperSelector, transferSelector])
				let data = wrap(transfer())
				if (mutation === "head") data = ethers.concat([wrapperSelector, ethers.ZeroHash])
				else {
					const offset = mutation === "offset" ? 36 : 4 + Number(BigInt(ethers.dataSlice(data, 36, 68)))
					data = ethers.concat([
						ethers.dataSlice(data, 0, offset),
						ethers.toBeHex(mutation === "selector" ? 3n : ethers.MaxUint256, 32),
						ethers.dataSlice(data, offset + 32),
					])
				}
				if (nested) data = wrap(data)
				await expect(relay([accountCall(data)])).to.be.revertedWithCustomError(gateway, "InvalidWalletDelegationCallData")
				expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(wallet.target)
				expect(await gateway.walletOperationNonces(context.signers.user.address, 0n, signerAccount)).to.equal(1n)
			})
		}
	}

	it("preserves selector-only authorization at a different target with the wrapper selector", async function () {
		await grant([sentinel, wrapperSelector])
		await relay([{ target: context.signers.user2.address, value: 0n, data: wrapperSelector }])
		expect(await gateway.walletOperationNonces(context.signers.user.address, 0n, signerAccount)).to.equal(2n)
	})

	it("accepts a valid wrapper with a noncanonical inner-data offset", async function () {
		await grant([sentinel, transferSelector])
		const data = wrap(transfer())
		const innerOffset = Number(BigInt(ethers.dataSlice(data, 36, 68)))
		const lengthPosition = 4 + innerOffset
		const padded = ethers.concat([
			ethers.dataSlice(data, 0, 36),
			ethers.toBeHex(innerOffset + 32, 32),
			ethers.dataSlice(data, 68, lengthPosition),
			ethers.ZeroHash,
			ethers.dataSlice(data, lengthPosition),
		])
		await relay([accountCall(wrap(padded))])
		expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(context.signers.hedger2.address)
	})

	it("bounds a nested payload by its parent rather than the enclosing buffer", async function () {
		await grant([sentinel, wrapperSelector, transferSelector])
		const inner = wrap(transfer())
		const lengthPosition = 4 + Number(BigInt(ethers.dataSlice(inner, 36, 68)))
		const malformed = ethers.concat([
			ethers.dataSlice(inner, 0, lengthPosition),
			ethers.toBeHex(ethers.dataLength(inner), 32),
			ethers.dataSlice(inner, lengthPosition + 32),
		])
		const padded = ethers.concat([wrap(malformed), new Uint8Array(512)])
		await expect(relay([accountCall(padded)])).to.be.revertedWithCustomError(gateway, "InvalidWalletDelegationCallData")
		expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(wallet.target)
	})

	it("preserves zero-value delegated contract calls and reserves payable calls for the owner", async function () {
		const target = await (await ethers.getContractFactory("MockWalletTarget")).deploy()
		const marker = ethers.id("delegated-record")
		const data = target.interface.encodeFunctionData("record", [marker])
		await grant([sentinel, target.interface.getFunction("record")!.selector])
		await context.signers.user.sendTransaction({ to: wallet.target, value: 1n })
		await expect(relay([{ target: await target.getAddress(), value: 1n, data }]))
			.to.be.revertedWithCustomError(gateway, "DelegatedWalletValueNotAllowed")
			.withArgs(0n, 1n)
		expect(await target.lastCaller()).to.equal(ethers.ZeroAddress)
		expect(await ethers.provider.getBalance(target.target)).to.equal(0n)
		await relay([{ target: await target.getAddress(), value: 0n, data }])
		expect(await target.lastCaller()).to.equal(wallet.target)
		expect(await target.lastMarker()).to.equal(marker)
		await relay([{ target: await target.getAddress(), value: 1n, data }], context.signers.user)
		expect(await ethers.provider.getBalance(target.target)).to.equal(1n)
	})

	for (const walletId of [0n, 2n]) {
		it(`rejects native spending by a selector-authorized delegate from wallet ${walletId}`, async function () {
			const target = await gateway.getGaslessWalletAddress(context.signers.user.address, walletId)
			const value = ethers.parseEther("1")
			await context.signers.user.sendTransaction({ to: target, value })
			await grant([sentinel, transferSelector])
			const recipient = context.signers.hedger2.address
			const before = await ethers.provider.getBalance(recipient)
			const nonce = await gateway.walletOperationNonces(context.signers.user.address, walletId, signerAccount)
			const attempt = relay([{ target: recipient, value, data: transferSelector }], context.signers.hedger2, walletId)
			await expect(attempt).to.be.revert(ethers)
			await expect(attempt).to.be.revertedWithCustomError(gateway, "DelegatedWalletValueNotAllowed").withArgs(0n, value)
			expect(await ethers.provider.getBalance(target)).to.equal(value)
			expect(await ethers.provider.getBalance(recipient)).to.equal(before)
			expect(await gateway.walletOperationNonces(context.signers.user.address, walletId, signerAccount)).to.equal(nonce)
			if (walletId > 0n) expect(await ethers.provider.getCode(target)).to.equal("0x")
			// The same funded wallet remains spendable by its owner, including empty native-transfer calldata.
			await relay([{ target: recipient, value, data: "0x" }], context.signers.user, walletId)
			expect(await ethers.provider.getBalance(target)).to.equal(0n)
			expect(await ethers.provider.getBalance(recipient)).to.equal(before + value)
		})
	}

	it("rejects native value in a later call before executing an earlier authorized call", async function () {
		await grant([sentinel, transferSelector])
		await context.signers.user.sendTransaction({ to: wallet.target, value: 1n })
		await expect(relay([accountCall(transfer()), { target: context.signers.hedger2.address, value: 1n, data: transferSelector }]))
			.to.be.revertedWithCustomError(gateway, "DelegatedWalletValueNotAllowed")
			.withArgs(1n, 1n)
		expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(wallet.target)
		expect(await ethers.provider.getBalance(wallet.target)).to.equal(1n)
	})

	it("rolls back an earlier signed operation if a later delegated operation sends native value", async function () {
		await grant([sentinel, transferSelector])
		await context.signers.user.sendTransaction({ to: wallet.target, value: 1n })
		const first = await operation([accountCall(transfer())])
		const second = await operation([{ target: context.signers.hedger2.address, value: 1n, data: transferSelector }], context.signers.hedger2, 2n)
		await expect(
			gateway.relayInstantBatch([first.op, second.op], [first.signature, second.signature], [], [], [0n, 2n]),
		).to.be.revertedWithCustomError(gateway, "DelegatedWalletValueNotAllowed")
		expect(await context.alViewFacet.ownerOf(walletRoot)).to.equal(wallet.target)
		expect(await gateway.walletOperationNonces(context.signers.user.address, 0n, signerAccount)).to.equal(1n)
	})
})
