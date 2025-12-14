import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect, use } from "chai"
import { AbiCoder, encodeBytes32String, InterfaceAbi, ZeroAddress, AddressLike, toUtf8Bytes, EthersError, BytesLike, TypedDataDomain } from "ethers"
import { ethers, network } from "hardhat"

import { InstantLayer } from "../../src/types"
import { initializeFixture } from "../Initialize.fixture"
import { PositionType, QuoteStatus } from "../models/Enums"
import { Hedger } from "../models/Hedger"
import { RunContext } from "../models/RunContext"
import { User } from "../models/User"
import { limitOpenRequestBuilder, OpenRequest } from "../models/requestModels/OpenRequest"
import { limitQuoteRequestBuilder, QuoteRequest } from "../models/requestModels/QuoteRequest"
import { decimal, getBlockTimestamp } from "../utils/Common"
// import { IMultiAccount } from "../../src/types/contracts/interfaces"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "../utils/SignatureUtils"
import { cloneTypes, DELEGATE_TYPES } from "./instantLayerEIP712Types"

export function shouldBehaveLikeInstantLayer(): void {
	let context: RunContext, partyA1: User, partyA2: User, partyB1: Hedger, partyB2: Hedger
	let quoteCallData: string, lockQuoteCallData: string, openQuoteCallData: string, bindToPartyBCallData: string
	let lockQuoteCallDataTemplate: string, openQuoteCallDataTemplate: string
	let saltOpen1: string, saltOpen2: string, saltLock: string, saltOpen: string

	let ops: InstantLayer.OperationStruct[]

	let requestSendQuote: QuoteRequest
	let requestOpenQuote: OpenRequest

	let types: ReturnType<typeof cloneTypes>
	let domain: TypedDataDomain

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		partyA1 = new User(context, context.signers.user)
		partyA2 = new User(context, context.signers.user2)
		partyB1 = new Hedger(context, context.signers.hedger)
		partyB2 = new Hedger(context, context.signers.hedger2)

		await partyA1.setup()
		await partyA2.setup()
		await partyB1.setup()
		await partyB2.setup()

		await partyA1.setBalances(decimal(100000n), decimal(5000n), decimal(2000n))
		await partyA2.setBalances(decimal(100000n), decimal(5000n))

		const { instantLayer, partyAFacet, partyBPositionActionsFacet, partyBQuoteActionsFacet, accountFacet } = context
		await context.controlFacet.grantRole(instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))

		// await context.controlFacet.setUnbindingCooldown(120)

		saltOpen1 = ethers.keccak256(ethers.toUtf8Bytes("saltOpen1"))
		saltOpen2 = ethers.keccak256(ethers.toUtf8Bytes("saltOpen2"))
		saltLock = ethers.keccak256(ethers.toUtf8Bytes("saltLock"))
		saltOpen = ethers.keccak256(ethers.toUtf8Bytes("saltFill"))

		const latestBlock = await getBlockTimestamp()
		const deadline = latestBlock + 300n

		requestSendQuote = limitQuoteRequestBuilder()
			.partyBWhiteList([await context.symmioPartyB.getAddress()])
			.build()
		requestOpenQuote = limitOpenRequestBuilder().build()

		quoteCallData = partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
			requestSendQuote.partyBWhiteList,
			requestSendQuote.symbolId,
			requestSendQuote.positionType,
			requestSendQuote.orderType,
			requestSendQuote.price,
			requestSendQuote.quantity,
			requestSendQuote.cva,
			requestSendQuote.lf,
			requestSendQuote.partyAmm,
			requestSendQuote.partyBmm,
			requestSendQuote.maxFundingRate,
			await requestSendQuote.deadline,
			requestSendQuote.affiliate,
			await requestSendQuote.upnlSig,
		])

		lockQuoteCallData = partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [1, await getDummySingleUpnlSig(10n)])
		openQuoteCallData = partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
			1,
			requestOpenQuote.filledAmount,
			requestOpenQuote.openPrice,
			await getDummyPairUpnlAndPriceSig(10n),
		])

		lockQuoteCallDataTemplate = partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [6, await getDummySingleUpnlSig(10n)])
		openQuoteCallDataTemplate = partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
			4,
			requestOpenQuote.filledAmount,
			requestOpenQuote.openPrice,
			await getDummyPairUpnlAndPriceSig(10n),
		])

		bindToPartyBCallData = accountFacet.interface.encodeFunctionData("bindToPartyB", [await context.symmioPartyB.getAddress()])

		ops = [
			{
				sourceIndices: [],
				insertionPoints: [],
			},
			{
				sourceIndices: [],
				insertionPoints: [],
			},
			{
				sourceIndices: [0],
				insertionPoints: [0],
			},
			{
				sourceIndices: [0],
				insertionPoints: [0],
			},
		]

		types = cloneTypes() // fresh copy for each test
		domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: await context.instantLayer.getAddress(),
		}

		await context.instantLayer.setAccountHub(await context.accountHub.getAddress())
	})

	async function signOperation(
		signer: any,
		domain: TypedDataDomain,
		types: ReturnType<typeof cloneTypes>,
		op: InstantLayer.SignedOperationStruct,
	): Promise<string> {
		return signer.signTypedData(domain, types, op)
	}

	describe("Registering PartyB", async function () {
		it("Should be failed when Sender not Setter Role ", async () => {
			await expect(context.instantLayer.connect(partyA1.getSigner).registerPartyBs([partyA1.address])).to.be.reverted
		})

		it("Should Add PartyB to Whitelisted Bs", async () => {
			await expect(context.instantLayer.registerPartyBs([partyB1.address])).not.to.be.reverted

			expect(await context.instantLayer.registeredPartyBs(partyB1.address)).to.be.equal(true)
			expect(await context.instantLayer.registeredPartyBs(partyB2.address)).to.be.equal(false)
		})

		it("Should be granted the right role", async () => {
			const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
			expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB1.address)).to.be.equal(false)
			expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB2.address)).to.be.equal(false)
			await expect(context.instantLayer.registerPartyBs([partyB1.address, partyB2.address])).not.to.be.reverted

			expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB1.address)).to.be.equal(true)
			expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB2.address)).to.be.equal(true)
		})
	})

	describe("Unregistering PartyB", async function () {
		it("Should be failed when Sender not Setter Role ", async () => {
			await expect(context.instantLayer.connect(partyA1.getSigner).registerPartyBs([partyB1.address])).to.be.reverted
			await expect(context.instantLayer.connect(partyA1.getSigner).unregisterPartyB(partyB1.address)).to.be.reverted
		})

		it("Should remove PartyB from Whitelisted Bs", async () => {
			await expect(context.instantLayer.registerPartyBs([partyB1.address])).not.to.be.reverted
			await expect(context.instantLayer.unregisterPartyB(partyB1.address)).not.to.be.reverted

			expect(await context.instantLayer.registeredPartyBs(partyB1.address)).to.be.equal(false)
		})

		it("Should remove the right role", async () => {
			await expect(context.instantLayer.registerPartyBs([partyB1.address])).not.to.be.reverted
			await expect(context.instantLayer.unregisterPartyB(partyB1.address)).not.to.be.reverted
			const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))

			expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB1.address)).to.be.equal(false)
		})
	})

	describe("Configuring AccountHub", async function () {
		it("Should be failed when Sender not Setter Role ", async () => {
			await expect(context.instantLayer.connect(context.signers.hedger).setAccountHub(partyB1.address)).to.be.reverted
		})

		it("Should update the accountHub address", async () => {
			const hub1 = await context.accountHub.getAddress()
			await expect(context.instantLayer.setAccountHub(hub1)).not.to.be.reverted
			expect(await context.instantLayer.accountHub()).to.equal(hub1)
		})
	})

	describe("Unregistering AccountHub", async function () {
		it("Should be failed when Sender not Setter Role ", async () => {
			await expect(context.instantLayer.connect(partyA1.getSigner).setAccountHub(ZeroAddress)).to.be.reverted
		})

		it("Should allow clearing the accountHub when caller has role", async () => {
			const hub1 = await context.accountHub.getAddress()
			await expect(context.instantLayer.setAccountHub(hub1)).not.to.be.reverted
			await expect(context.instantLayer.setAccountHub(ZeroAddress)).to.be.revertedWithCustomError(context.instantLayer, "UnregisteredAccountHub")
		})
	})

	describe("Adding Template", async function () {
		it("Should be failed when Sender not have Setter Role ", async () => {
			await expect(context.instantLayer.connect(partyA1.getSigner).addTemplate("test", ops)).to.be.reverted
			//TODO adapt to recent changes
		})

		it("Should Set the template Active Mode to true", async () => {
			await expect(context.instantLayer.addTemplate("test", ops)).not.to.be.reverted
			let template = await context.instantLayer.getTemplate(0)
			expect(template.active).to.be.equal(true)
		})

		it("Should Set the template Name as expected", async () => {
			let name = "myTemp"
			await expect(context.instantLayer.addTemplate(name, ops)).not.to.be.reverted
			let template = await context.instantLayer.getTemplate(0)
			expect(template.name).to.be.equal(name)
		})

		it("Should Set the template Operations as expected", async () => {
			let name = "myTemp"
			await expect(context.instantLayer.addTemplate(name, ops)).not.to.be.reverted
			const tempID = (await context.instantLayer.nextTemplateId()) - 1n
			let template: InstantLayer.TemplateStruct = await context.instantLayer.getTemplate(tempID)

			expect(template.operations.length).to.be.equal(ops.length) // equals 2
			expect(template.name).to.equal(name)
			expect(template.active).to.equal(true)

			for (let i = 0; i < template.operations.length; i++) {
				expect(template.operations[i].sourceIndices).to.deep.equal(ops[i].sourceIndices)
				expect(template.operations[i].insertionPoints).to.deep.equal(ops[i].insertionPoints)
			}
		})
	})

	// describe("Is Valid Signature?", async function () {
	// 	let harness: SigCheckHarness

	// 	beforeEach(async () => {
	// 		const Harness = await ethers.getContractFactory("SigCheckHarness")
	// 		harness = await Harness.deploy()
	// 		await harness.waitForDeployment()
	// 	})

	// 	it("EOA: returns true for a valid signMessage signature when using the EIP-191 digest", async () => {
	// 		const [alice] = await ethers.getSigners()

	// 		// Original 32-byte payload you conceptually want to sign (could be your EIP-712 digest too)
	// 		const raw = ethers.keccak256(ethers.toUtf8Bytes("hello"))

	// 		// 1) Sign with signMessage (adds EIP-191 prefix)
	// 		const sig = await alice.signMessage(ethers.getBytes(raw))

	// 		// 2) Compute the *prefixed* digest that the wallet actually signed
	// 		const eip191Digest = ethers.hashMessage(ethers.getBytes(raw)) // keccak256("\x19Ethereum Signed Message...\n32" || raw)

	// 		// 3) Ask the harness to check (ECDSA path)
	// 		expect(await harness.check(await alice.getAddress(), eip191Digest, sig)).to.equal(true)
	// 	})

	// 	// it("EOA: returns false if digest mismatches the signature", async () => {
	// 	// 	const deadline = await getBlockTimestamp(300n)
	// 	// 	const saltHex = "0xabc123"
	// 	// 	const salt = hexZeroPad(saltHex, 32)
	// 	// 	const saltStr: string = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"

	// 	// 	if (!/^0x[0-9a-fA-F]{64}$/.test(salt) || !/^0x[0-9a-fA-F]{64}$/.test(saltStr)) {
	// 	// 		throw new Error("Invalid bytes32 format")
	// 	// 	}

	// 	// 	const opOpenA: InstantLayer.SignedOperationStruct = {
	// 	// 		actualSigner: partyA1.address,

	// 	// 		signature: "0x",
	// 	// 		side: 0,
	// 	// 		params: {
	// 	// 			target: context.diamond,
	// 	// 			callData: sendQuoteParamsOnly, // parameters only
	// 	// 			paramHash: sendQuoteParamHash,
	// 	// 			functionSignature: sendQuoteWithAffiliateSignature, // canonical
	// 	// 		},
	// 	// 		delegator: {
	// 	// 			multiAccount: ZeroAddress,
	// 	// 			accountAddress: ZeroAddress,
	// 	// 			accountOwner: ZeroAddress,
	// 	// 			selector: "0x10987654",
	// 	// 		},
	// 	// 	}
	// 	// 	const hash = await context.instantLayer.getOperationHash(opOpenA, true)
	// 	// 	opOpenA.signature = await partyA1.sign(ethers.getBytes(hash))
	// 	// 	console.log("Hash:", hash)
	// 	// 	console.log("signature:", opOpenA.signature)

	// 	// 	// un-prefixed raw will fail:
	// 	// 	expect(await harness.check(opOpenA.actualSigner, hash, opOpenA.signature)).to.equal(false)
	// 	// })

	// 	// it("EOA: returns True if digest matches the signature", async () => {
	// 	// 	const deadline = await getBlockTimestamp(300n)
	// 	// 	const saltHex = "0xabc123"
	// 	// 	const salt = hexZeroPad(saltHex, 32)
	// 	// 	const saltStr: string = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
	// 	// 	if (!/^0x[0-9a-fA-F]{64}$/.test(salt) || !/^0x[0-9a-fA-F]{64}$/.test(saltStr)) {
	// 	// 		throw new Error("Invalid bytes32 format")
	// 	// 	}
	// 	// 	const opOpenA: InstantLayer.SignedOperationStruct = {
	// 	// 		actualSigner: partyA1.address,
	// 	// 		callData: "0x1234",
	// 	// 		nonce: 12,
	// 	// 		salt: salt,
	// 	// 		deadline: deadline,
	// 	// 		signature: "0x",
	// 	// 		side: 0,
	// 	// 		delegator: {
	// 	// 			multiAccount: ZeroAddress,
	// 	// 			accountAddress: ZeroAddress,
	// 	// 			accountOwner: ZeroAddress,
	// 	// 			selector: "0x0",
	// 	// 		},
	// 	// 	}
	// 	// 	const hash = await context.instantLayer.getOperationHash(opOpenA, true)
	// 	// 	opOpenA.signature = await partyA1.sign(ethers.getBytes(hash))

	// 	// 	expect(await harness.check(opOpenA.actualSigner, ethers.hashMessage(ethers.getBytes(hash)), opOpenA.signature)).to.equal(true)
	// 	// })
	// })

	describe("execute Batch", async function () {
		let opSendQuoteA1: InstantLayer.SignedOperationStruct, opSendQuoteA2: InstantLayer.SignedOperationStruct
		let opLockB1: InstantLayer.SignedOperationStruct, opOpenQuoteB1: InstantLayer.SignedOperationStruct
		let opSendQuoteSignature1: BytesLike
		let opSendQuoteSignature2: BytesLike
		let opLockSignature: BytesLike
		let opOpenSignature: BytesLike
		let accounts: any[]

		// Domain must match the executor's EIP712(name,version)
		let sendQuoteParamsOnly
		let sendQuoteParamHash
		let sendQuoteSelector

		let lockQuoteParamsOnly
		let lockQuoteParamHash
		let lockQuoteSelector

		let openQuoteParamsOnly
		let openQuoteParamHash
		let openQuoteSelector

		beforeEach(async function () {
			const deadline = await getBlockTimestamp(300n)
			const symmioAddress = context.diamond

			// Granting Roles
			await context.instantLayer.registerPartyBs([context.symmioPartyB]) // Admin with SETTER Role
			await context.controlFacet.registerPartyB(await context.symmioPartyB.getAddress())
			await context.instantLayer.setAccountHub(await context.accountHub.getAddress()) // Admin with SETTER Role
			await context.symmioPartyB.grantRole(ethers.keccak256(toUtf8Bytes("SETTER_ROLE")), await context.signers.admin.getAddress())
			await context.symmioPartyB.setSigner(partyB1.getSigner) // Admin with SETTER Role

			await expect(context.accountManager.connect(partyA1.getSigner).addAccount("testAccount")).not.to.reverted // here the party A Role is an EOA to create an Party A address
			accounts = await context.accountManager.getAccounts(partyA1.address, 0, 100)
			await expect(context.collateral.connect(partyA1.getSigner).approve(context.diamond, ethers.MaxUint256)).not.reverted
			// await context.symmioPartyB.grantRole(ethers.keccak256(toUtf8Bytes("TRUSTED_ROLE")), partyA1.address)
			// await expect(context.symmioPartyB.connect(partyA1.getSigner)._approve(context.collateral, decimal(30n))).not.to.be.reverted // for symmoio contract
			await expect(context.collateral.connect(partyA1.getSigner).mint(accounts[0].accountAddress, decimal(30n))).to.not.reverted
			await context.accountFacet.connect(partyA1.getSigner).depositFor(accounts[0].accountAddress, decimal(20n))
			await context.accountFacet.connect(partyA1.getSigner).internalTransfer(accounts[0].accountAddress, decimal(1000n))

			//Delegating Access
			const selectorQuote = quoteCallData.slice(0, 10)
			const selectorLock = lockQuoteCallData.slice(0, 10)
			const selectorOpen = openQuoteCallData.slice(0, 10)
			await context.instantLayer.connect(partyA1.getSigner).grantDelegation({
				account: {
					addr: accounts[0].accountAddress,
					isPartyB: false,
				},
				delegatedSigner: context.signers.admin.address,
				selectors: [selectorQuote],
				expiryTimestamp: await getBlockTimestamp(100n),
			})

			// Bind to Party B
			await context.accountManager.connect(partyA1.getSigner)._call(accounts[0].accountAddress, [bindToPartyBCallData])

			// Whitelisting Symbol type
			await context.symbolControlFacet.whitelistSymbolType(context.symmioPartyB.getAddress(), 1)

			const sendQuoteWithAffiliateSignature =
				"sendQuoteWithAffiliate(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(int256,uint256,uint256,uint256,bytes))"
			const lockQuoteSignature = "lockQuote(uint256,(int256,uint256,uint256,uint256,bytes))"
			sendQuoteParamsOnly = ("0x" + quoteCallData.slice(10)) as `0x${string}` // strip selector
			lockQuoteParamsOnly = ("0x" + lockQuoteCallData.slice(10)) as `0x${string}` // strip selector
			openQuoteParamsOnly = ("0x" + openQuoteCallData.slice(10)) as `0x${string}` // strip selector

			sendQuoteParamHash = ethers.keccak256(sendQuoteParamsOnly)
			lockQuoteParamHash = ethers.keccak256(lockQuoteParamsOnly)
			openQuoteParamHash = ethers.keccak256(openQuoteParamsOnly)

			sendQuoteSelector = context.partyAFacet.interface.getFunction("sendQuoteWithAffiliate").selector as `0x${string}`
			lockQuoteSelector = context.partyBQuoteActionsFacet.interface.getFunction("lockQuote").selector as `0x${string}`
			openQuoteSelector = context.partyBPositionActionsFacet.interface.getFunction("openPosition").selector as `0x${string}`

			opSendQuoteA1 = {
				signer: context.signers.admin.address,
				target: symmioAddress,
				callData: quoteCallData,
				signerAccount: {
					addr: accounts[0].accountAddress,
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opSendQuoteA2 = {
				signer: partyA1.address, // it should work for contracts as well as EOAs
				target: symmioAddress,
				callData: quoteCallData,
				signerAccount: {
					addr: accounts[0].accountAddress,
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 2n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opLockB1 = {
				signer: await context.symmioPartyB.getAddress(),
				target: symmioAddress,
				callData: lockQuoteCallData,
				signerAccount: {
					addr: await context.symmioPartyB.getAddress(),
					isPartyB: true,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opOpenQuoteB1 = {
				signer: await context.symmioPartyB.getAddress(),
				target: symmioAddress,
				callData: openQuoteCallData,
				signerAccount: {
					addr: await context.symmioPartyB.getAddress(),
					isPartyB: true,
				},
				replayAttackHeader: {
					nonce: 2n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opSendQuoteSignature1 = new Uint8Array([0x1, 0x2])
			opSendQuoteSignature2 = new Uint8Array([0x1, 0x2])
			opLockSignature = new Uint8Array([0x1, 0x2])
			opOpenSignature = new Uint8Array([0x1, 0x2])
		})

		it("Should be failed when Sender not have Operator Role ", async () => {
			await expect(context.instantLayer.connect(partyA1.getSigner).executeBatch([], [])).to.be.reverted // with "AccessControl" Error
		})

		it("Should be failed when input Ops have zero length ", async () => {
			await expect(context.instantLayer.executeBatch([], [])).to.be.revertedWithCustomError(context.instantLayer, "EmptyBatch")
		})

		it("reverts with ArrayLengthMismatch when signedOps.length != signatures.length", async () => {
			// Make 1 valid op/signature pair first
			const sig1 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			// Pass 1 op but 0 signatures
			await expect(context.instantLayer.executeBatch([opSendQuoteA1], [])).to.be.revertedWithCustomError(context.instantLayer, "ArrayLengthMismatch")

			// Pass 2 ops but 1 signature
			await expect(context.instantLayer.executeBatch([opSendQuoteA1, opLockB1], [sig1])).to.be.revertedWithCustomError(
				context.instantLayer,
				"ArrayLengthMismatch",
			)
		})

		it("reverts when an operation's deadline has passed (verify stage)", async () => {
			// craft an op with a past deadline and a valid signature
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 100
			const op: InstantLayer.SignedOperationStruct = {
				...opSendQuoteA1,
				replayAttackHeader: {
					...opSendQuoteA1.replayAttackHeader,
					deadline: BigInt(deadline),
					// keep a fresh salt to avoid any caching
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}
			const sig = await context.signers.admin.signTypedData(domain, types, op)
			await expect(context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted

			await time.increase(100)
			const sigAfter = await signOperation(context.signers.admin, domain, types, op)
			await expect(context.instantLayer.executeBatch([op], [sigAfter])).to.be.revertedWithCustomError(context.instantLayer, "DeadlineExpired")
		})

		it("bubbles inner target failures via OperationFailed(i, returndata)", async () => {
			/**
			 * Force _executeOperationSafe to fail by calling a PartyB action
			 * that requires an existing quote BEFORE any sendQuote happened.
			 * Put it first so failure index = 0.
			 */
			const badFirst = opLockB1
			const sigBadFirst = await context.signers.hedger.signTypedData(domain, types, badFirst)

			await expect(context.instantLayer.executeBatch([badFirst], [sigBadFirst])).to.be.revertedWithCustomError(
				context.instantLayer,
				"OperationFailed",
			)
			// .withArgs(0, anyValue) // returndata is tool-specific; we just assert it exists
		})

		it("emits BatchExecuted with the caller and correct count on success", async () => {
			const sig1 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			const sig2 = await context.signers.user.signTypedData(domain, types, opSendQuoteA2)
			const sig3 = await context.signers.hedger.signTypedData(domain, types, opLockB1)

			await expect(context.instantLayer.executeBatch([opSendQuoteA1, opSendQuoteA2, opLockB1], [sig1, sig2, sig3]))
				.to.emit(context.instantLayer, "BatchExecuted")
				.withArgs(context.signers.admin.address, 3)
		})

		it("allows mixed EOA and contract signers in the same batch (independent verify paths)", async () => {
			// Your earlier happy path already demonstrated this subtly; here we assert it directly.
			const sig1 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1) // EOA
			const sig2 = await context.signers.hedger.signTypedData(domain, types, opLockB1) // contract PartyB signer (or its EOA, depending on your setup)

			await expect(context.instantLayer.executeBatch([opSendQuoteA1, opLockB1], [sig1, sig2])).not.to.be.reverted

			// Optional: verify side-effects minimally (quote 1 exists & is locked)
			const q1 = await context.viewFacetQuote.getQuote(1)
			expect(q1.requestedOpenPrice).to.equal(requestSendQuote.price)
			expect(q1.quantity).to.equal(requestSendQuote.quantity)
			expect(q1.quoteStatus).to.equal(QuoteStatus.LOCKED)
		})

		it("does not continue after a failed op (loop short-circuits via success flag)", async () => {
			// First op fails (lock before send), second would succeed if reached.
			const failing = opLockB1
			const sigFailing = await context.signers.hedger.signTypedData(domain, types, failing)

			const succeeding = opSendQuoteA1
			const sigSucceeding = await context.signers.admin.signTypedData(domain, types, succeeding)

			await expect(context.instantLayer.executeBatch([failing, succeeding], [sigFailing, sigSucceeding])).to.be.revertedWithCustomError(
				context.instantLayer,
				"OperationFailed",
			)
			// .withArgs(0, anyValue)
		})

		it("accepts valid batch and leaves environment clean (setCallFromInstantLayer toggled)", async () => {
			const sig1 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			const sig2 = await context.signers.user.signTypedData(domain, types, opSendQuoteA2)

			await expect(context.instantLayer.executeBatch([opSendQuoteA1, opSendQuoteA2], [sig1, sig2])).not.to.be.reverted
			const q1 = await context.viewFacetQuote.getQuote(1)
			const q2 = await context.viewFacetQuote.getQuote(2)

			expect(q1.requestedOpenPrice).to.equal(requestSendQuote.price)
			expect(q1.quantity).to.equal(requestSendQuote.quantity)
			expect(q1.quoteStatus).to.equal(QuoteStatus.PENDING)

			expect(q2.requestedOpenPrice).to.equal(requestSendQuote.price)
			expect(q2.quantity).to.equal(requestSendQuote.quantity)
			expect(q2.quoteStatus).to.equal(QuoteStatus.PENDING)
		})

		it("should Register Symmio PartyB when sending as PartyB", async function () {
			const op = { ...opLockB1, signerAccount: { addr: partyB2.address, isPartyB: true }, signer: partyB2.address }
			const sig = await context.signers.hedger.signTypedData(domain, types, op)
			await expect(context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(context.instantLayer, "UnregisteredPartyB")
		})

		it("reverts when AccountHub is not configured", async () => {
			await expect(context.instantLayer.setAccountHub(ZeroAddress)).to.be.revertedWithCustomError(context.instantLayer, "UnregisteredAccountHub")
		})

		it("should be signed with valid signer for partyB", async function () {
			// const op = { ...opLockB1, signerAccount: { addr: partyB2.address, isPartyB: true }, signer: partyB2.address }
			const sig = await context.signers.hedger2.signTypedData(domain, types, opLockB1)
			await expect(context.instantLayer.executeBatch([opLockB1], [sig])).to.be.revertedWithCustomError(context.instantLayer, "InvalidSignature")
		})

		it("reverts InvalidDelegation when delegate lacks selector grant", async () => {
			// remove delegation (or choose a selector not granted)
			const op = { ...opSendQuoteA1, signer: context.signers.user2.address } // not delegated
			const sig = await context.signers.user2.signTypedData(domain, types, op)
			await expect(context.instantLayer.executeBatch([op], [sig])).to.be.revertedWithCustomError(context.instantLayer, "InvalidDelegation")
		})

		it("should consider replay attack correctly", async () => {
			const sig = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			await expect(context.instantLayer.executeBatch([opSendQuoteA1], [sig])).not.to.be.reverted
			await expect(context.instantLayer.executeBatch([opSendQuoteA1], [sig])).to.be.revertedWithCustomError(
				context.instantLayer,
				"OperationAlreadyExecuted",
			)
		})

		it("accepts contract signature via EIP-1271", async () => {
			const Mock = await ethers.getContractFactory("Mock1271")
			const mock = await Mock.deploy(await context.signers.admin.getAddress())
			await mock.waitForDeployment()

			const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)
			const expiry = now + 3600n // 1 hour future
			const deadline = now + 600n // 10 mins future

			const acc = {
				addr: accounts[0].accountAddress, // account being delegated for
				isPartyB: false,
			}

			const nonceBefore: bigint = 1n
			const replayAttackHeader = {
				nonce: nonceBefore,
				deadline,
				salt: ethers.id("unique-salt-1"), // bytes32
			}

			const selectors = quoteCallData.slice(0, 10)
			const delegationInfo = {
				account: acc,
				delegatedSigner: await mock.getAddress(),
				selectors: [selectors],
				expiryTimestamp: expiry,
			}

			const signedDelegation = {
				delegationInfo,
				replayAttackHeader,
			}

			const sig1: BytesLike = await context.signers.user.signTypedData(domain, DELEGATE_TYPES, signedDelegation)
			await expect(context.instantLayer.connect(partyA1.getSigner).grantBatchDelegationBySig(signedDelegation, sig1)).not.to.be.reverted

			const op = { ...opSendQuoteA1, signer: await mock.getAddress() }
			const sig = await signOperation(context.signers.admin, domain, types, op) // signer is admin, validator is contract
			await expect(context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted
		})

		it("reverts MismatchSignerAndAccount for PartyB path when signer != signerAccount.addr", async () => {
			const bad = { ...opLockB1, signerAccount: { addr: partyB2.address, isPartyB: true } }
			const sig = await context.signers.hedger.signTypedData(domain, types, bad)
			await expect(context.instantLayer.executeBatch([bad], [sig]))
				.to.be.revertedWithCustomError(context.instantLayer, "MismatchSignerAndAccount")
				.withArgs(await context.symmioPartyB.getAddress(), partyB2.address)
		})

		it("should allow Sending Intents in a single batch", async function () {
			const { instantLayer, partyAFacet, partyBQuoteActionsFacet, partyBPositionActionsFacet } = context

			opSendQuoteSignature1 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			opSendQuoteSignature2 = await context.signers.user.signTypedData(domain, types, opSendQuoteA2)
			opLockSignature = await context.signers.hedger.signTypedData(domain, types, opLockB1)

			const signedOps: InstantLayer.SignedOperationStruct[] = [opSendQuoteA1, opSendQuoteA2, opLockB1]
			const sigCallDatas: BytesLike[] = [opSendQuoteSignature1, opSendQuoteSignature2, opLockSignature]

			await expect(instantLayer.executeBatch(signedOps, sigCallDatas)).not.to.be.reverted

			let quote = await context.viewFacetQuote.getQuote(1)
			let quote2 = await context.viewFacetQuote.getQuote(2)
			expect(quote.requestedOpenPrice).to.be.equal(requestSendQuote.price)
			expect(quote.quantity).to.be.equal(requestSendQuote.quantity)
			expect(quote2.requestedOpenPrice).to.be.equal(requestSendQuote.price)
			expect(quote2.quantity).to.be.equal(requestSendQuote.quantity)

			expect(quote.quoteStatus).to.be.equal(QuoteStatus.LOCKED)
			expect(quote2.quoteStatus).to.be.equal(QuoteStatus.PENDING)
		})

		// it("should allow Sending Intent, Locking and Filling in a single batch Seperately", async function () {
		// 	const { instantLayer, partyAFacet, partyBQuoteActionsFacet } = context
		// 	const multiAccount = context.multiAccount

		// 	//Sign using getOperationHash
		// 	const opSendAHash1 = await instantLayer.getOperationHash(opSendQuoteA1, false)
		// 	const opLockBHash = await instantLayer.getOperationHash(opLockB1, false)
		// 	const opOpenBHash = await instantLayer.getOperationHash(opOpenQuoteB1, false)
		// 	opSendQuoteA1.signature = await context.signers.admin.signMessage(ethers.getBytes(opSendAHash1))
		// 	opLockB1.signature = await partyB1.sign(ethers.getBytes(opLockBHash))
		// 	opOpenQuoteB1.signature = await partyB1.sign(ethers.getBytes(opOpenBHash))

		// 	const signedOps: InstantLayer.SignedOperationStruct[] = [opSendQuoteA1]
		// 	await expect(instantLayer.executeBatch(signedOps)).not.to.be.reverted // Admin with OPERATOR Role

		// 	let lastID = 1
		// 	let quote = await context.viewFacetQuote.getQuote(lastID)
		// 	expect(quote.requestedOpenPrice).to.be.equal(requestSendQuote.price)
		// 	expect(quote.quantity).to.be.equal(requestSendQuote.quantity)
		// 	console.log("Quote Status, ID:", lastID, quote.quoteStatus == BigInt(QuoteStatus.PENDING) ? "Pending" : quote.quoteStatus)

		// 	const signedOpsLock: InstantLayer.SignedOperationStruct[] = [opLockB1]
		// 	await expect(instantLayer.executeBatch(signedOpsLock)).not.to.be.reverted
		// 	quote = await context.viewFacetQuote.getQuote(lastID)
		// 	console.log("Quote Status, ID:", lastID, quote.quoteStatus == BigInt(QuoteStatus.LOCKED) ? "Locked" : quote.quoteStatus)
		// 	expect(quote.quoteStatus).to.be.equal(QuoteStatus.LOCKED)

		// 	const signedOpsFill: InstantLayer.SignedOperationStruct[] = [opOpenQuoteB1]
		// 	await expect(instantLayer.executeBatch(signedOpsFill)).not.to.be.reverted
		// 	quote = await context.viewFacetQuote.getQuote(lastID)
		// 	console.log("Quote Status, ID:", lastID, quote.quoteStatus == BigInt(QuoteStatus.OPENED) ? "Opened" : quote.quoteStatus)

		// 	expect(quote.quoteStatus).to.be.equal(QuoteStatus.OPENED)
		// })

		// it("should allow Sending Intent, Locking and Filling in a single batch Altogether", async function () {
		// 	const { instantLayer } = context
		// 	const multiAccount = context.multiAccount

		// 	//Sign using getOperationHash
		// 	const opOpenAHash1 = await instantLayer.getOperationHash(opSendQuoteA1, false)
		// 	const opLockBHash = await instantLayer.getOperationHash(opLockB1, false)
		// 	const opFillBHash = await instantLayer.getOperationHash(opOpenQuoteB1, false)
		// 	opSendQuoteA1.signature = await context.signers.admin.signMessage(ethers.getBytes(opOpenAHash1))
		// 	opLockB1.signature = await partyB1.sign(ethers.getBytes(opLockBHash))
		// 	opOpenQuoteB1.signature = await partyB1.sign(ethers.getBytes(opFillBHash))

		// 	//Execution
		// 	const signedOps: InstantLayer.SignedOperationStruct[] = [opSendQuoteA1, opLockB1, opOpenQuoteB1]
		// 	await expect(instantLayer.executeBatch(signedOps)).not.to.be.reverted // Admin with OPERATOR Role

		// 	//Verificaiton
		// 	let lastID = 1
		// 	let quote = await context.viewFacetQuote.getQuote(lastID)
		// 	console.log("Quote Status, ID:", lastID, quote.quoteStatus == BigInt(QuoteStatus.OPENED) ? "Opened" : quote.quoteStatus)
		// 	expect(quote.quoteStatus).to.be.equal(QuoteStatus.OPENED)
		// })

		it("should Fail Signature verification with Invalid Nonce", async function () {
			const op1: InstantLayer.SignedOperationStruct = {
				...opSendQuoteA1,
				replayAttackHeader: {
					...opSendQuoteA1.replayAttackHeader,
					nonce: 2n,
				},
			}

			const sig = await signOperation(context.signers.admin, domain, types, op1)
			await expect(context.instantLayer.executeBatch([op1], [sig])).to.be.revertedWithCustomError(context.instantLayer, "InvalidNonce")

			const op2: InstantLayer.SignedOperationStruct = {
				...opSendQuoteA1,
				replayAttackHeader: {
					...opSendQuoteA1.replayAttackHeader,
					nonce: 1n,
				},
			}
			const op3: InstantLayer.SignedOperationStruct = {
				...opSendQuoteA1,
				replayAttackHeader: {
					...opSendQuoteA1.replayAttackHeader,
					nonce: 0n,
				},
			}
			const op4: InstantLayer.SignedOperationStruct = {
				...opSendQuoteA1,
				replayAttackHeader: {
					...opSendQuoteA1.replayAttackHeader,
					nonce: 2n,
				},
			}

			const sig2 = await signOperation(context.signers.admin, domain, types, op2)
			const sig3 = await signOperation(context.signers.admin, domain, types, op3)
			const sig4 = await signOperation(context.signers.admin, domain, types, op4)
			await expect(context.instantLayer.executeBatch([op2, op3, op4], [sig2, sig3, sig4])).not.to.be.reverted
		})

		// it("should Update Nonce on Signature verification with Valid nonce", async function () {
		// 	const latestBlock = await getLatestBlockTime()
		// 	const deadline = latestBlock + 300
		// 	// Granting Roles
		// 	await context.instantLayer.registerMultiAccount(context.multiAccount)
		// 	await expect(context.multiAccount.connect(partyA1.getSigner).addAccount("testAccount")).not.to.reverted // here the party A Role is an EOA to create an Party A address
		// 	accounts = await context.multiAccount.getAccounts(partyA1.address, 0, 100)
		// 	const saltHex = "0xabc123"
		// 	const salt = hexZeroPad(saltHex, 32)
		// 	if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) {
		// 		throw new Error("Invalid bytes32 format")
		// 	}
		// 	const nonce = 1
		// 	const opOpenALocal: InstantLayer.SignedOperationStruct = {
		// 		accountSource: await context.multiAccount.getAddress(),
		// 		signer: accounts[0].account,
		// 		callData: openIntentCallData,
		// 		nonce: nonce,
		// 		salt: salt,
		// 		deadline: deadline,
		// 		signature: "0x",
		// 	}
		// 	const oldNonce = await context.instantLayer.nonces(opOpenALocal.signer)
		// 	const hash = await context.instantLayer.getOperationHash(opOpenALocal)
		// 	opOpenALocal.signature = await partyA1.sign(ethers.getBytes(hash))
		// 	await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		// 	await expect(context.instantLayer.executeBatch([opOpenALocal])).not.to.be.reverted
		// 	let newNonce = await context.instantLayer.nonces(opOpenALocal.signer)
		// 	console.log("New Nonce:", newNonce)
		// 	expect(newNonce).to.be.equal(nonce)
		// 	expect(newNonce).to.be.equal(oldNonce + 1n)
		// })

		it("Should be failed when ", async () => {
			// await context.instantLayer.registerPartyB(partyB1.getSigner)
			// for(let i =0; i< signedOps.length; i++){
			// 	let hash = await context.instantLayer.getOperationHash(signedOps[i])
			// 	console.log("Hash Of Operation " + i +":",hash)
			// }
			// await expect(context.instantLayer.executeBatch(signedOps)).not.to.be.reverted
			//TODO
		})
	})

	describe("execute Template", async function () {
		let opSendQuoteA1: InstantLayer.SignedOperationStruct, opSendQuoteA2: InstantLayer.SignedOperationStruct
		let opLockB1: InstantLayer.SignedOperationStruct, opOpenQuoteB1: InstantLayer.SignedOperationStruct
		let opSendQuoteSignature1: BytesLike
		let opSendQuoteSignature2: BytesLike
		let opLockSignature: BytesLike
		let opOpenSignature: BytesLike
		let accounts: any[]

		beforeEach(async function () {
			const deadline = await getBlockTimestamp(300n)
			const symmioAddress = context.diamond

			// Granting Roles
			await context.instantLayer.registerPartyBs([context.symmioPartyB]) // Admin with SETTER Role
			await context.controlFacet.registerPartyB(await context.symmioPartyB.getAddress())
			await context.instantLayer.setAccountHub(await context.accountHub.getAddress()) // Admin with SETTER Role
			await context.symmioPartyB.grantRole(ethers.keccak256(toUtf8Bytes("SETTER_ROLE")), await context.signers.admin.getAddress())
			await context.symmioPartyB.setSigner(partyB1.getSigner) // Admin with SETTER Role

			await expect(context.accountManager.connect(partyA1.getSigner).addAccount("testAccount")).not.to.reverted // here the party A Role is an EOA to create an Party A address
			accounts = await context.accountManager.getAccounts(partyA1.address, 0, 100)

			await expect(context.collateral.connect(partyA1.getSigner).approve(context.diamond, ethers.MaxUint256)).not.reverted
			await context.symmioPartyB.grantRole(ethers.keccak256(toUtf8Bytes("TRUSTED_ROLE")), partyA1.address)

			await expect(context.symmioPartyB.connect(partyA1.getSigner)._approve(context.collateral, decimal(30n))).not.to.be.reverted // for symmoio contract

			await expect(context.collateral.connect(partyA1.getSigner).mint(accounts[0].accountAddress, decimal(30n))).to.not.reverted
			await context.accountFacet.connect(partyA1.getSigner).depositFor(accounts[0].accountAddress, decimal(20n))
			await context.accountFacet.connect(partyA1.getSigner).internalTransfer(accounts[0].accountAddress, decimal(1000n))

			//Delegating Access
			const selectorQuote = quoteCallData.slice(0, 10)
			await context.instantLayer.connect(partyA1.getSigner).grantDelegation({
				account: {
					addr: accounts[0].accountAddress,
					isPartyB: false,
				},
				delegatedSigner: context.signers.admin.address,
				selectors: [selectorQuote],
				expiryTimestamp: await getBlockTimestamp(100n),
			})

			// Bind to Party B
			await context.accountManager.connect(partyA1.getSigner)._call(accounts[0].accountAddress, [bindToPartyBCallData])

			// Whitelisting Symbol type
			await context.symbolControlFacet.whitelistSymbolType(context.symmioPartyB.getAddress(), 1)

			const sendQuoteWithAffiliateSignature =
				"sendQuoteWithAffiliate(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(int256,uint256,uint256,uint256,bytes))"
			const lockQuoteSignature = "lockQuote(uint256,(int256,uint256,uint256,uint256,bytes))"

			opSendQuoteA1 = {
				signer: context.signers.admin.address,
				target: symmioAddress,
				callData: quoteCallData,
				signerAccount: {
					addr: accounts[0].accountAddress,
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opSendQuoteA2 = {
				signer: partyA1.address,
				target: symmioAddress,
				callData: quoteCallData,
				signerAccount: {
					addr: accounts[0].accountAddress,
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 2n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opLockB1 = {
				signer: await context.symmioPartyB.getAddress(),
				target: symmioAddress,
				callData: lockQuoteCallDataTemplate,
				signerAccount: {
					addr: await context.symmioPartyB.getAddress(),
					isPartyB: true,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opOpenQuoteB1 = {
				signer: await context.symmioPartyB.getAddress(),
				target: symmioAddress,
				callData: openQuoteCallDataTemplate,
				signerAccount: {
					addr: await context.symmioPartyB.getAddress(),
					isPartyB: true,
				},
				replayAttackHeader: {
					nonce: 2n, // second nonce for the the same signer
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opSendQuoteSignature1 = new Uint8Array([0x1, 0x2])
			opSendQuoteSignature2 = new Uint8Array([0x1, 0x2])
			opLockSignature = new Uint8Array([0x1, 0x2])
			opOpenSignature = new Uint8Array([0x1, 0x2])

			await context.instantLayer.addTemplate("MyTempFull", ops)
			await context.instantLayer.addTemplate("basic", [
				{ insertionPoints: [], sourceIndices: [] }, // op0
				{ insertionPoints: [0], sourceIndices: [0] }, // op1
			])
		})
		it("Should be failed when Sender not have Operator Role ", async () => {
			await expect(context.instantLayer.connect(partyA1.getSigner).executeTemplate(0, [], [])).to.be.reverted // with "AccessControl" Error
		})

		it("reverts with InvalidTemplate for unknown template id", async () => {
			const bogus = (await context.instantLayer.getNextTemplateId()) + 123n
			await expect(context.instantLayer.executeTemplate(bogus, [], []))
				.to.be.revertedWithCustomError(context.instantLayer, "InvalidTemplate")
				.withArgs(bogus)
		})

		it("Should be failed when Template Inactive ", async () => {
			const tempID = (await context.instantLayer.getNextTemplateId()) - 1n
			await context.instantLayer.setTemplateActive(tempID, false)
			await expect(context.instantLayer.executeTemplate(tempID, [opSendQuoteA1], [opSendQuoteSignature1])).to.be.revertedWithCustomError(
				context.instantLayer,
				"TemplateNotActive",
			)
		})

		it("reverts with ArrayLengthMismatch when signedOps.length != signatures.length", async () => {
			const sig0 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)

			await expect(context.instantLayer.executeTemplate(0, [opSendQuoteA1, opLockB1], [sig0])).to.be.revertedWithCustomError(
				context.instantLayer,
				"ArrayLengthMismatch",
			)
		})

		it("Should be failed when Template Operation Input length Mismatch ", async () => {
			const opsLocal: InstantLayer.OperationStruct[] = [
				{
					sourceIndices: [],
					insertionPoints: [1],
				},
			]
			await context.instantLayer.addTemplate("MyTemp", opsLocal)
			const tempID = (await context.instantLayer.getNextTemplateId()) - 1n
			await expect(context.instantLayer.executeTemplate(tempID, [], [])).to.be.revertedWithCustomError(
				context.instantLayer,
				"TemplateOperationLengthMismatch",
			)
		})

		it("reverts with DeadlineExpired when any op is past deadline", async () => {
			const pastDeadline = (await getBlockTimestamp()) - 20n
			const expired = {
				...opSendQuoteA1,
				replayAttackHeader: { ...opSendQuoteA1.replayAttackHeader, deadline: pastDeadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}
			const sigExpired = await context.signers.admin.signTypedData(domain, types, expired)
			const sig1 = await context.signers.hedger.signTypedData(domain, types, opLockB1)

			const opsLocal: InstantLayer.OperationStruct[] = [
				{
					sourceIndices: [],
					insertionPoints: [],
				},
				{
					sourceIndices: [0],
					insertionPoints: [0],
				},
			]
			await context.instantLayer.addTemplate("MyTempTest", opsLocal)
			const tempID = (await context.instantLayer.getNextTemplateId()) - 1n
			await expect(context.instantLayer.executeTemplate(tempID, [expired, opLockB1], [sigExpired, sig1]))
				.to.be.revertedWithCustomError(context.instantLayer, "DeadlineExpired")
				.withArgs(pastDeadline)
		})

		it("bubbles target revert with OperationFailed(index, returndata)", async () => {
			const sigBad = await context.signers.hedger.signTypedData(domain, types, opLockB1)

			await context.instantLayer.addTemplate("singleLock", [{ insertionPoints: [], sourceIndices: [] }])
			const oneStep = (await context.instantLayer.getNextTemplateId()) - 1n

			await expect(context.instantLayer.executeTemplate(oneStep, [opLockB1], [sigBad]))
				.to.be.revertedWithCustomError(context.instantLayer, "OperationFailed")
				.withArgs(0, anyValue)
		})

		it("reverts with MissingSourceResult when operation self references ", async () => {
			await context.instantLayer.addTemplate("badAtOp0", [
				{ insertionPoints: [0], sourceIndices: [0] }, // op0 will reference results[1] (invalid)
			])
			const badAtOp0 = (await context.instantLayer.getNextTemplateId()) - 1n

			const sig0 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			await expect(context.instantLayer.executeTemplate(badAtOp0, [opSendQuoteA1], [sig0])).to.be.revertedWithCustomError(
				context.instantLayer,
				"MissingSourceResult",
			)
		})

		it("reverts in MissingSourceResult when source result is empty (non-32 bytes)", async () => {
			await context.instantLayer.addTemplate("injectFromEmpty", [
				{ insertionPoints: [0], sourceIndices: [0] },
				{ insertionPoints: [0], sourceIndices: [0] },
			])
			const templateId = (await context.instantLayer.getNextTemplateId()) - 1n

			opSendQuoteSignature1 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			opSendQuoteSignature2 = await context.signers.user.signTypedData(domain, types, opSendQuoteA2)
			const signedOps: InstantLayer.SignedOperationStruct[] = [opSendQuoteA1, opSendQuoteA2]
			const sigCallDatas: BytesLike[] = [opSendQuoteSignature1, opSendQuoteSignature2]
			await expect(context.instantLayer.executeBatch(signedOps, sigCallDatas)).not.to.be.reverted

			const sig0 = await context.signers.hedger.signTypedData(domain, types, opLockB1)
			const sig1 = await context.signers.hedger.signTypedData(domain, types, opLockB1)

			// Expect revert from abi.decode inside _insertResults:
			await expect(context.instantLayer.executeTemplate(templateId, [opLockB1, opLockB1], [sig0, sig1])).to.be.revertedWithCustomError(
				context.instantLayer,
				"MissingSourceResult",
			)
		})

		it("reverts with InvalidSourceIndex when operation references a future/missing result", async () => {
			await context.instantLayer.addTemplate("badAtOp0", [
				{ insertionPoints: [0], sourceIndices: [1] }, // op0 will reference results[1] (invalid)
			])
			const badAtOp0 = (await context.instantLayer.getNextTemplateId()) - 1n

			const sig0 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			await expect(context.instantLayer.executeTemplate(badAtOp0, [opSendQuoteA1], [sig0]))
				.to.be.revertedWithCustomError(context.instantLayer, "InvalidSourceIndex")
				.withArgs(1)
		})

		it("reverts with InsertionPointOutOfBounds for large offset", async () => {
			// Create a template that writes far beyond calldata length
			await context.instantLayer.addTemplate("oobInsert", [
				{ insertionPoints: [], sourceIndices: [] }, // op0
				{ insertionPoints: [opSendQuoteA1.callData.length], sourceIndices: [0] }, // op1 tries to write way past end
			])
			let oob = (await context.instantLayer.getNextTemplateId()) - 1n
			const lastTemp = await context.instantLayer.getTemplate(oob)
			console.log("last index:", oob)
			console.log("last temp:", lastTemp.name)
			console.log("opSendQuoteA1 length:", opSendQuoteA1.callData.length)
			console.log("opLockB1 length:", opLockB1.callData.length)
			console.log("opLockB1 calldata:", opLockB1.callData)

			const sig0 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			const sig1 = await context.signers.hedger.signTypedData(domain, types, opLockB1)

			await expect(context.instantLayer.executeTemplate(oob, [opSendQuoteA1, opLockB1], [sig0, sig1])).to.be.revertedWithCustomError(
				context.instantLayer,
				"InsertionPointOutOfBounds",
			)

			await context.instantLayer.addTemplate("oobInsert", [
				{ insertionPoints: [], sourceIndices: [] }, // op0
				{ insertionPoints: [opSendQuoteA1.callData.length - 36, 3], sourceIndices: [0, 1] }, // op1 tries to write way past end
			])
			oob = (await context.instantLayer.getNextTemplateId()) - 1n

			// await expect(context.instantLayer.executeTemplate(oob, [opSendQuoteA1, opLockB1], [sig0, sig1])).not.to.reverted
			await expect(context.instantLayer.executeTemplate(oob, [opSendQuoteA1, opLockB1], [sig0, sig1])).to.be.revertedWithCustomError(
				context.instantLayer,
				"InsertionPointOutOfBounds",
			)
		})

		it("executes a basic template and emits OperationsExecuted", async () => {
			const sig0 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			const sig1 = await context.signers.hedger.signTypedData(domain, types, opLockB1)

			const templateIdBasic = (await context.instantLayer.getNextTemplateId()) - 1n
			await expect(context.instantLayer.executeTemplate(templateIdBasic, [opSendQuoteA1, opLockB1], [sig0, sig1]))
				.to.emit(context.instantLayer, "OperationsExecuted")
				.withArgs(templateIdBasic, context.signers.admin.address)

			const q1 = await context.viewFacetQuote.getQuote(1)
			expect(q1.requestedOpenPrice).to.equal(requestSendQuote.price)
			expect(q1.quantity).to.equal(requestSendQuote.quantity)
			expect(q1.quoteStatus).to.equal(QuoteStatus.LOCKED)
		})

		// it("injects previous result into next op calldata (send → lock with injected quoteId)", async () => {
		// 	// 1) craft op0 (send) normally
		// 	const sigSend = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)

		// 	// 2) craft op1 (lock) with placeholder for the first arg (quoteId = 0)
		// 	//    Assuming original `lockQuoteCallData` encodes: lockQuote(uint256 quoteId, ...)
		// 	const stripSelector = (data: `0x${string}`) => ("0x" + data.slice(10)) as `0x${string}`

		// 	const lockArgsOnly = stripSelector(lockQuoteCallData)
		// 	// overwrite first 32 bytes of args with zero (quoteId placeholder)
		// 	const zero32 = "0x" + "00".repeat(32)
		// 	const patchedArgs = (zero32 + lockArgsOnly.slice(66)) as `0x${string}` // replace first 32-byte word
		// 	const lockSelector = context.partyBQuoteActionsFacet.interface.getFunction("lockQuote").selector as `0x${string}`
		// 	const lockPatched = (lockSelector + patchedArgs.slice(2)) as `0x${string}`

		// 	const opLockPatched = { ...opLockB1, callData: lockPatched }
		// 	const sigLock = await context.signers.hedger.signTypedData(domain, types, opLockPatched)

		// 	// 3) Execute the injection template: op0 result -> op1 first arg (offset 0)
		// 	await expect(context.instantLayer.executeTemplate(1, [opSendQuoteA1, opLockPatched], [sigSend, sigLock])).not.to.be.reverted

		// 	// 4) Verify the quote is locked (means the injected quoteId was correct)
		// 	const q1 = await context.viewFacetQuote.getQuote(1)
		// 	expect(q1.quoteStatus).to.equal(QuoteStatus.LOCKED)
		// })

		// 	it("should Register Symmio PartyB when sending as PartyB", async function () {
		// 		const deadline = (await getLatestBlockTime()) + 24
		// 		let saltStr: string = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
		// 		const opOpenALocal: InstantLayer.SignedOperationStruct = {
		// 			accountSource: ZeroAddress,
		// 			signer: partyA1.address,
		// 			callData: "0x", // no matter
		// 			nonce: 100, // no matter
		// 			salt: saltStr, // no matter
		// 			deadline: deadline,
		// 			signature: "0x",
		// 		}
		// 		const tempID = (await context.instantLayer.getLastTemplateID()) - 1n
		// 		await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		// 		await expect(context.instantLayer.executeTemplate(tempID, [opOpenALocal, opOpenA1, opLockB1, opFillB1])).to.be.revertedWithCustomError(
		// 			context.instantLayer,
		// 			"UnregisteredPartyB",
		// 		)
		// 	})

		// 	it("should allow Sending Intents with a single Operation", async function () {
		// 		const { instantLayer, collateralNL, partyAOpenFacet, partyBOpenFacet, symmioPartyB } = context
		// 		const multiAccount = context.multiAccount
		// 		// Granting Roles
		// 		await context.instantLayer.registerPartyB(symmioPartyB) // Admin with SETTER Role, grants OPERATOR_ROLE to the us
		// 		await context.instantLayer.registerMultiAccount(multiAccount) // Admin with SETTER Role, grants OPERATOR_ROLE to the user
		// 		await context.symmioPartyB.setSigner(partyB1.getSigner) // Admin with SETTER Role
		// 		await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE"))) // to call Control faucet
		// 		await context.controlFacet.setPartyBConfig(context.symmioPartyB.getAddress(), {
		// 			// Admin with PARTY_B_MANAGER_ROLE
		// 			isActive: true,
		// 			lossCoverage: 0,
		// 			oracleId: 1,
		// 		})
		// 		await context.controlFacet.setPartyBSupportedSymbolTypes(context.symmioPartyB.getAddress(), [0], [true])
		// 		//Sign using getOperationHash
		// 		const opOpenAHash1 = await instantLayer.getOperationHash(opOpenA1)
		// 		const opOpenAHash2 = await instantLayer.getOperationHash(opOpenA2)
		// 		const opLockBHash = await instantLayer.getOperationHash(opLockB1)
		// 		const opFillBHash = await instantLayer.getOperationHash(opFillB1)
		// 		opOpenA1.signature = await partyA1.sign(ethers.getBytes(opOpenAHash1))
		// 		opOpenA2.signature = await partyA1.sign(ethers.getBytes(opOpenAHash2))
		// 		opLockB1.signature = await partyB1.sign(ethers.getBytes(opLockBHash))
		// 		opFillB1.signature = await partyB1.sign(ethers.getBytes(opFillBHash))
		// 		console.log("OpenIntent Interface:", openIntentCallData)
		// 		console.log("LockIntent Interface:", lockIntentCallData)
		// 		console.log("FillIntent Interface:", fillIntentCallData)
		// 		console.log("PartyA address:", partyA1.address)
		// 		console.log("PartyA Account address:", accounts[0].account)
		// 		console.log("PartyB1 address:", partyB1.address)
		// 		console.log("Symmio PartyB address:", await context.symmioPartyB.getAddress())
		// 		console.log("MultiAccount address:", await multiAccount.getAddress())
		// 		console.log("Signature and length PartyA Open:", opOpenA1.signature.length, opOpenA1.signature)
		// 		console.log("Signature and length PartyB Lock:", opLockB1.signature.length, opLockB1.signature)
		// 		console.log("Signature and length PartyB Fill:", opFillB1.signature.length, opFillB1.signature)
		// 		try {
		// 			let recoveredAddress = ethers.verifyMessage(ethers.getBytes(opOpenAHash1), opOpenA1.signature)
		// 			console.log("Party A Verifyed:", recoveredAddress === partyA1.address)
		// 			console.log("signer vs Recovered", opOpenA1.signer, " vs ", recoveredAddress)
		// 			recoveredAddress = ethers.verifyMessage(ethers.getBytes(opLockBHash), opLockB1.signature)
		// 			console.log("Party B Verifyed:", recoveredAddress === opLockB1.signer)
		// 			console.log("signer vs Recovered", opLockB1.signer, " vs ", recoveredAddress)
		// 			recoveredAddress = ethers.verifyMessage(ethers.getBytes(opFillBHash), opFillB1.signature)
		// 			console.log("Party B Fill Verifyed:", recoveredAddress === opFillB1.signer)
		// 			console.log("signer vs Recovered", opFillB1.signer, " vs ", recoveredAddress)
		// 		} catch (error) {
		// 			console.error("Verification failed:", error)
		// 			return false
		// 		}
		// 		const tempID = (await context.instantLayer.getLastTemplateID()) - 1n
		// 		const signedOps: InstantLayer.SignedOperationStruct[] = [opOpenA1, opOpenA2, opLockB1, opFillB1]
		// 		await expect(instantLayer.executeTemplate(tempID, signedOps)).not.to.be.revertedWithCustomError(context.instantLayer, "InvalidTemplate")
		// 		// try {
		// 		// 	await instantLayer.executeTemplate(tempID, signedOps)
		// 		// } catch (error: unknown) {
		// 		// 	console.log("Error Fetched:", error)
		// 		// }
		// 		let intent: OpenIntentStruct = await context.viewFacet.getOpenIntent(1)
		// 		console.log("Intent Status:", intent.status == IntentStatus.FILLED ? "Filled" : intent.status)
		// 		expect(intent.price).to.be.equal(request.price)
		// 		expect(intent.tradeAgreements.quantity).to.be.equal(request.quantity)
		// 	})

		it("should allow Sending Intent, Locking and Filling in a single batch Altogether", async function () {
			// console.log(types)
			opSendQuoteSignature1 = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			opSendQuoteSignature2 = await context.signers.user.signTypedData(domain, types, opSendQuoteA2)
			opLockSignature = await context.signers.hedger.signTypedData(domain, types, opLockB1)
			opOpenSignature = await context.signers.hedger.signTypedData(domain, types, opOpenQuoteB1)

			opLockB1.callData = lockQuoteCallDataTemplate
			opOpenQuoteB1.callData = openQuoteCallDataTemplate

			const signedOps: InstantLayer.SignedOperationStruct[] = [opSendQuoteA1, opSendQuoteA2, opLockB1, opOpenQuoteB1]
			const sigCallDatas: string[] = [opSendQuoteSignature1, opSendQuoteSignature2, opLockSignature, opOpenSignature]

			const { instantLayer, symmioPartyB } = context
			const accountHubAddr = await context.accountHub.getAddress()
			// Granting Roles
			await context.instantLayer.registerPartyBs([symmioPartyB])
			await context.instantLayer.setAccountHub(accountHubAddr)
			await context.symmioPartyB.setSigner(partyB1.getSigner)
			// await context.symmioPartyB.setMulticastWhitelist(context.common.diamondAddress, true)

			const tempID = 0
			//Execution

			await expect(instantLayer.executeTemplate(tempID, signedOps, sigCallDatas)).not.to.be.reverted

			//Verification
			let quote = await context.viewFacetQuote.getQuote(1)
			let quote2 = await context.viewFacetQuote.getQuote(2)
			expect(quote.requestedOpenPrice).to.be.equal(requestSendQuote.price)
			expect(quote.quantity).to.be.equal(requestSendQuote.quantity)
			expect(quote2.requestedOpenPrice).to.be.equal(requestSendQuote.price)
			expect(quote2.quantity).to.be.equal(requestSendQuote.quantity)

			expect(quote.quoteStatus).to.be.equal(QuoteStatus.OPENED)
			expect(quote2.quoteStatus).to.be.equal(QuoteStatus.PENDING)
		})

		it("increments account nonce when nonce > 0 and enforces ordering", async () => {
			// Prepare ops with explicit nonces 1 and 2 for the same account
			const op1 = { ...opSendQuoteA1, replayAttackHeader: { ...opSendQuoteA1.replayAttackHeader, nonce: 1n } }
			const op2 = { ...opSendQuoteA1, replayAttackHeader: { ...opSendQuoteA1.replayAttackHeader, nonce: 2n } }
			const op3 = { ...opSendQuoteA1, replayAttackHeader: { ...opSendQuoteA1.replayAttackHeader, nonce: 0n } }
			const op4 = { ...opLockB1, replayAttackHeader: { ...opLockB1.replayAttackHeader, nonce: 1n } }

			const sig1 = await context.signers.admin.signTypedData(domain, types, op1)
			const sig2 = await context.signers.admin.signTypedData(domain, types, op2)
			const sig3 = await context.signers.admin.signTypedData(domain, types, op3)
			const sig4 = await context.signers.hedger.signTypedData(domain, types, op4)

			// make a 2-op template with no injections
			await context.instantLayer.addTemplate("nonceBasic", [
				{ insertionPoints: [], sourceIndices: [] },
				{ insertionPoints: [], sourceIndices: [] },
				{ insertionPoints: [], sourceIndices: [] },
				{ insertionPoints: [0], sourceIndices: [0] },
			])
			const nonceTpl = (await context.instantLayer.getNextTemplateId()) - 1n

			const before = await context.instantLayer.nonces(op1.signerAccount.addr)
			await expect(context.instantLayer.executeTemplate(nonceTpl, [op1, op2, op3, op4], [sig1, sig2, sig3, sig4])).not.to.be.reverted

			const after = await context.instantLayer.nonces(op1.signerAccount.addr)
			expect(after).to.equal(before + 2n) // both ops consumed
		})

		// 	it("should Fail Signature verification with Invalid Nonce", async function () {
		// 		const latestBlock = await getLatestBlockTime()
		// 		const deadline = latestBlock + 300
		// 		// Granting Roles
		// 		await context.instantLayer.registerMultiAccount(context.multiAccount)
		// 		let saltStr: string = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
		// 		if (!/^0x[0-9a-fA-F]{64}$/.test(saltStr)) {
		// 			throw new Error("Invalid bytes32 format")
		// 		}
		// 		const opOpenALocal: InstantLayer.SignedOperationStruct = {
		// 			accountSource: await context.multiAccount.getAddress(),
		// 			signer: accounts[0].account,
		// 			callData: openIntentCallData,
		// 			nonce: 2,
		// 			salt: saltStr,
		// 			deadline: deadline,
		// 			signature: "0x",
		// 		}
		// 		const hash = await context.instantLayer.getOperationHash(opOpenALocal)
		// 		opOpenALocal.signature = await partyA1.sign(ethers.getBytes(hash))
		// 		await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		// 		await expect(context.instantLayer.executeBatch([opOpenALocal])).to.be.revertedWithCustomError(context.instantLayer, "InvalidNonce")
		// 	})

		// 	it("should Update Nonce on Signature verification with Valid nonce", async function () {
		// 		const latestBlock = await getLatestBlockTime()
		// 		const deadline = latestBlock + 300
		// 		// Granting Roles
		// 		await context.instantLayer.registerMultiAccount(context.multiAccount)
		// 		await expect(context.multiAccount.connect(partyA1.getSigner).addAccount("testAccount")).not.to.reverted // here the party A Role is an EOA to create an Party A address
		// 		accounts = await context.multiAccount.getAccounts(partyA1.address, 0, 100)
		// 		const saltHex = "0xabc123"
		// 		const salt = hexZeroPad(saltHex, 32)
		// 		if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) {
		// 			throw new Error("Invalid bytes32 format")
		// 		}
		// 		const nonce = 1
		// 		const opOpenALocal: InstantLayer.SignedOperationStruct = {
		// 			accountSource: await context.multiAccount.getAddress(),
		// 			signer: accounts[0].account,
		// 			callData: openIntentCallData,
		// 			nonce: nonce,
		// 			salt: salt,
		// 			deadline: deadline,
		// 			signature: "0x",
		// 		}
		// 		const oldNonce = await context.instantLayer.nonces(opOpenALocal.signer)
		// 		const hash = await context.instantLayer.getOperationHash(opOpenALocal)
		// 		opOpenALocal.signature = await partyA1.sign(ethers.getBytes(hash))
		// 		await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		// 		await expect(context.instantLayer.executeBatch([opOpenALocal])).not.to.be.reverted
		// 		let newNonce = await context.instantLayer.nonces(opOpenALocal.signer)
		// 		console.log("New Nonce:", newNonce)
		// 		expect(newNonce).to.be.equal(nonce)
		// 		expect(newNonce).to.be.equal(oldNonce + 1n)
		// 	})
		// 	// it("Should be failed when ", async () => {
		// 	// 	// await context.instantLayer.registerPartyB(partyB1.getSigner)
		// 	// 	// for(let i =0; i< signedOps.length; i++){
		// 	// 	// 	let hash = await context.instantLayer.getOperationHash(signedOps[i])
		// 	// 	// 	console.log("Hash Of Operation " + i +":",hash)
		// 	// 	// }
		// 	// 	// await expect(context.instantLayer.executeBatch(signedOps)).not.to.be.reverted
		// 	// 	//TODO
		// 	// })
	})

	describe("grantBatchDelegationBySig", () => {
		let accounts: any[]
		beforeEach(async () => {
			await expect(context.accountManager.connect(partyA1.getSigner).addAccount("testAccount")).not.to.reverted // here the party A Role is an EOA to create an Party A address
			accounts = await context.accountManager.getAccounts(partyA1.address, 0, 100)
			await context.instantLayer.setAccountHub(await context.accountHub.getAddress()) // Admin with SETTER Role
		})

		function ifaceSelectors(...fragments: string[]): string[] {
			// Build function selectors as 0x........ (bytes4)
			const IF = new ethers.Interface(fragments.map(sig => `function ${sig}`))
			return fragments.map(sig => IF.getFunction(sig)!.selector)
		}

		it("grants batch delegations and bumps nonce", async () => {
			// --- Arrange
			const acc = {
				addr: accounts[0].accountAddress, // account being delegated for
				isPartyB: false,
			}

			const selectors = quoteCallData.slice(0, 10)

			const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)
			const expiry = now + 3600n // 1 hour future
			const deadline = now + 600n // 10 mins future

			const nonceBefore: bigint = 1n

			const replayAttackHeader = {
				nonce: nonceBefore,
				deadline,
				salt: ethers.id("unique-salt-1"), // bytes32
			}

			const delegationInfo = {
				account: acc,
				delegatedSigner: await context.signers.admin.getAddress(),
				selectors: [selectors],
				expiryTimestamp: expiry,
			}

			const signedDelegation = {
				delegationInfo,
				replayAttackHeader,
			}

			const sig: BytesLike = await context.signers.user.signTypedData(domain, DELEGATE_TYPES, signedDelegation)

			// --- Act
			// submitter sends the tx (meta-tx style)
			await expect(context.instantLayer.connect(partyA1.getSigner).grantBatchDelegationBySig(signedDelegation, sig)).not.to.reverted
			// .to.emit(context.instantLayer, "DelegationGranted")
			// .withArgs(acc.addr, await context.signers.admin.getAddress(), selectors[0], expiry)
			// .and.to.emit(context.instantLayer, "DelegationGranted")
			// .withArgs(acc.addr, await context.signers.admin.getAddress(), selectors[1], expiry)
			// .and.to.emit(context.instantLayer, "DelegationNonceIncremented")
			// .withArgs(acc.addr, nonceBefore + 1n)

			//--- Assert storage
			const exp0 = await context.instantLayer.delegations(acc.addr, await context.signers.admin.getAddress(), selectors)
			expect(exp0).to.equal(expiry)

			const nonceAfter: bigint = await context.instantLayer.delegationNonces(acc.addr)
			expect(nonceAfter).to.equal(nonceBefore)
		})
	})

	describe("Virtual Account Delegation Support", () => {
		let accounts: any[]
		let subAccountAddress: string
		let virtualAccountAddress: string
		let quoteCallDataLocal: string
		let symmioAddress: string

		beforeEach(async () => {
			const { instantLayer, partyAFacet, accountFacet, partyBQuoteActionsFacet } = context
			symmioAddress = context.diamond

			// Setup InstantLayer
			await context.instantLayer.registerPartyBs([context.symmioPartyB])
			await context.controlFacet.registerPartyB(await context.symmioPartyB.getAddress())
			await context.instantLayer.setAccountHub(await context.accountHub.getAddress())
			await context.symmioPartyB.grantRole(ethers.keccak256(toUtf8Bytes("SETTER_ROLE")), await context.signers.admin.getAddress())
			await context.symmioPartyB.setSigner(partyB1.getSigner)

			// Create sub-account with MARKET isolation (type 1) - allows multiple quotes with same symbol
			const subAccountData = [
				{
					name: "VIRTUAL_DELEGATION_TEST",
					metadata: ethers.keccak256(toUtf8Bytes("metadata")),
					symmioCore: context.diamond,
					isolationType: 1, // MARKET isolation - allows multiple quotes per virtual account
				},
			]
			await context.accountHub.connect(partyA1.getSigner).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
			accounts = await context.accountHub.getUserSubAccountsAddresses(partyA1.address, 0, 100)
			subAccountAddress = accounts[0]

			// Deposit for sub-account (need balance for transfers, NOT allocatedBalance)
			await context.collateral.connect(partyA1.getSigner).approve(context.diamond, ethers.MaxUint256)
			await context.collateral.connect(partyA1.getSigner).mint(subAccountAddress, decimal(5000n))
			await context.accountFacet.connect(partyA1.getSigner).depositFor(subAccountAddress, decimal(3000n))

			// Bind sub-account to PartyB
			await context.accountHub.connect(partyA1.getSigner)._call(subAccountAddress, [bindToPartyBCallData])

			// Whitelist symbol type
			await context.symbolControlFacet.whitelistSymbolType(context.symmioPartyB.getAddress(), 1)

			// Create quote calldata
			quoteCallDataLocal = partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
				requestSendQuote.partyBWhiteList,
				requestSendQuote.symbolId,
				requestSendQuote.positionType,
				requestSendQuote.orderType,
				requestSendQuote.price,
				requestSendQuote.quantity,
				requestSendQuote.cva,
				requestSendQuote.lf,
				requestSendQuote.partyAmm,
				requestSendQuote.partyBmm,
				requestSendQuote.maxFundingRate,
				await requestSendQuote.deadline,
				requestSendQuote.affiliate,
				await requestSendQuote.upnlSig,
			])

			// Create a virtual account by sending a quote from the sub-account
			await context.accountHub.connect(partyA1.getSigner)._call(subAccountAddress, [quoteCallDataLocal])

			// Get the created virtual account address
			const virtualAccounts = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(subAccountAddress, 0, 10)
			virtualAccountAddress = virtualAccounts[0]

			// Grant delegation on the PARENT sub-account (not the virtual account)
			const selectorQuote = quoteCallDataLocal.slice(0, 10)
			await context.instantLayer.connect(partyA1.getSigner).grantDelegation({
				account: {
					addr: subAccountAddress, // Delegation is granted on the parent sub-account
					isPartyB: false,
				},
				delegatedSigner: context.signers.admin.address,
				selectors: [selectorQuote],
				expiryTimestamp: await getBlockTimestamp(3600n),
			})
		})

		it("should allow delegate to execute operations on virtual account using parent's delegation", async () => {
			const deadline = await getBlockTimestamp(300n)

			// Transfer more funds to the virtual account for the new quote (internal transfer from sub-account)
			const internalTransferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccountAddress, decimal(500n)])
			await context.accountHub.connect(partyA1.getSigner)._call(subAccountAddress, [internalTransferCallData])

			// Create operation targeting the VIRTUAL account but signed by the delegate
			const opSendQuoteOnVirtual: InstantLayer.SignedOperationStruct = {
				signer: context.signers.admin.address, // delegate (granted delegation on parent)
				target: symmioAddress,
				callData: quoteCallDataLocal,
				signerAccount: {
					addr: virtualAccountAddress, // targeting the virtual account
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			const sig = await context.signers.admin.signTypedData(domain, types, opSendQuoteOnVirtual)

			// This should succeed because:
			// 1. The signer (admin) is a delegate
			// 2. The virtual account's parent (subAccountAddress) has delegation granted to admin
			// 3. The InstantLayer now checks delegation against the parent account for virtual accounts
			await expect(context.instantLayer.executeBatch([opSendQuoteOnVirtual], [sig])).not.to.be.reverted

			// Verify a new quote was created
			const quoteIds = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
			expect(quoteIds.length).to.equal(2) // Original quote + new quote
		})

		it("should reject operation on virtual account when delegate lacks parent's delegation", async () => {
			const deadline = await getBlockTimestamp(300n)

			// Create operation targeting the virtual account with a non-delegated signer
			const opSendQuoteOnVirtual: InstantLayer.SignedOperationStruct = {
				signer: context.signers.user2.address, // NOT delegated on parent
				target: symmioAddress,
				callData: quoteCallDataLocal,
				signerAccount: {
					addr: virtualAccountAddress,
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			const sig = await context.signers.user2.signTypedData(domain, types, opSendQuoteOnVirtual)

			// Should fail because user2 doesn't have delegation on the parent account
			await expect(context.instantLayer.executeBatch([opSendQuoteOnVirtual], [sig])).to.be.revertedWithCustomError(
				context.instantLayer,
				"InvalidDelegation",
			)
		})

		it("should allow owner to execute on virtual account directly without delegation check", async () => {
			const deadline = await getBlockTimestamp(300n)

			// Transfer more funds to the virtual account for the new quote (internal transfer from sub-account)
			const internalTransferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccountAddress, decimal(500n)])
			await context.accountHub.connect(partyA1.getSigner)._call(subAccountAddress, [internalTransferCallData])

			// Create operation where signer is the owner of the parent account
			const opSendQuoteOnVirtual: InstantLayer.SignedOperationStruct = {
				signer: partyA1.address, // owner of the sub-account (parent of virtual account)
				target: symmioAddress,
				callData: quoteCallDataLocal,
				signerAccount: {
					addr: virtualAccountAddress,
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			const sig = await context.signers.user.signTypedData(domain, types, opSendQuoteOnVirtual)

			// Should succeed because signer is the owner (no delegation check needed)
			await expect(context.instantLayer.executeBatch([opSendQuoteOnVirtual], [sig])).not.to.be.reverted
		})

		it("should correctly identify parent account for delegation check on virtual accounts", async () => {
			// Verify the virtual account exists and has the correct parent
			const virtualAccountDetail = await context.accountHub.getVirtualAccount(virtualAccountAddress)
			expect(virtualAccountDetail.isExists).to.be.true
			expect(virtualAccountDetail.parentAccount).to.equal(subAccountAddress)

			// Verify isDelegationActive works with parent address
			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`
			const isActive = await context.instantLayer.isDelegationActive(subAccountAddress, context.signers.admin.address, selectorQuote)
			expect(isActive).to.be.true

			// Verify isDelegationActive returns false for virtual account address directly
			// (because delegation was granted on parent, not virtual)
			const isActiveOnVirtual = await context.instantLayer.isDelegationActive(virtualAccountAddress, context.signers.admin.address, selectorQuote)
			expect(isActiveOnVirtual).to.be.false
		})

		it("should handle delegation revocation on parent affecting virtual account operations", async () => {
			const selectorQuote = quoteCallDataLocal.slice(0, 10) as `0x${string}`

			// Set revocation cooldown (minimum 5 minutes = 300 seconds)
			await context.instantLayer.connect(context.signers.admin).setRevocationCooldown(300)

			// Initiate revocation
			await context.instantLayer
				.connect(partyA1.getSigner)
				.initiateRevokeDelegation({ addr: subAccountAddress, isPartyB: false }, context.signers.admin.address, [selectorQuote])

			// Move time past cooldown (300 seconds + 1)
			await time.increase(301)

			// Finalize revocation
			await context.instantLayer.finalizeRevokeDelegation({ addr: subAccountAddress, isPartyB: false }, context.signers.admin.address, [
				selectorQuote,
			])

			// Get a fresh deadline AFTER time increase
			const freshDeadline = await getBlockTimestamp(300n)

			// Now try to execute on virtual account - should fail
			const opSendQuoteOnVirtual: InstantLayer.SignedOperationStruct = {
				signer: context.signers.admin.address,
				target: symmioAddress,
				callData: quoteCallDataLocal,
				signerAccount: {
					addr: virtualAccountAddress,
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: freshDeadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			const sig = await context.signers.admin.signTypedData(domain, types, opSendQuoteOnVirtual)

			await expect(context.instantLayer.executeBatch([opSendQuoteOnVirtual], [sig])).to.be.revertedWithCustomError(
				context.instantLayer,
				"InvalidDelegation",
			)
		})
	})

	describe("revoke Delegation", () => {
		let delegatorAcct: InstantLayer.AccountStruct
		let delegateAddr: string
		let selA: string // bytes4
		let selB: string // bytes4
		let cooldown: number
		const SETTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE"))
		const REVOKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REVOKER_ROLE"))

		async function increaseTime(seconds: number) {
			await network.provider.send("evm_increaseTime", [seconds])
			await network.provider.send("evm_mine")
		}

		beforeEach(async () => {
			delegateAddr = context.signers.admin.address

			await expect(context.accountManager.connect(partyA1.getSigner).addAccount("testAccount")).not.to.reverted // here the party A Role is an EOA to create an Party A address

			delegatorAcct = {
				addr: (await context.accountManager.getAccounts(partyA1.address, 0, 1))[0].accountAddress,
				isPartyB: false,
			}

			await context.instantLayer.setAccountHub(await context.accountHub.getAddress())
			// choose two real selectors you already used
			selA = context.partyAFacet.interface.getFunction("sendQuoteWithAffiliate").selector as `0x${string}`
			selB = context.partyBQuoteActionsFacet.interface.getFunction("lockQuote").selector as `0x${string}`

			// Grant a delegation that is currently active (expiry > now)
			const exp = await getBlockTimestamp(3600n) // +1h
			await context.instantLayer.connect(partyA1.getSigner).grantDelegation({
				account: delegatorAcct,
				delegatedSigner: delegateAddr,
				selectors: [selA, selB],
				expiryTimestamp: exp,
			})

			// Set a reasonable cooldown (e.g. 10 minutes)
			cooldown = 10 * 60
			await context.instantLayer.connect(context.signers.admin).setRevocationCooldown(cooldown)
		})

		describe("Set Revoke CoolDown", () => {
			it("setter: updates cooldown within bounds and emits event", async () => {
				const old = cooldown
				const next = 20 * 60 // 20 minutes

				await expect(context.instantLayer.connect(context.signers.admin).setRevocationCooldown(next))
					.to.emit(context.instantLayer, "RevocationCooldownUpdated")
					.withArgs(old, next)
			})

			it("setter: rejects values out of bounds (too small / too large)", async () => {
				await expect(
					context.instantLayer.connect(context.signers.admin).setRevocationCooldown(30), // < 1 minute
				).to.be.revertedWithCustomError(context.instantLayer, "InvalidCallData")

				await expect(
					context.instantLayer.connect(context.signers.admin).setRevocationCooldown(31 * 24 * 3600), // > 30 days
				).to.be.revertedWithCustomError(context.instantLayer, "InvalidCallData")
			})

			it("only SETTER_ROLE can update cooldown", async () => {
				await expect(context.instantLayer.connect(partyA1.getSigner).setRevocationCooldown(600)).to.be.reverted
			})
		})

		describe("Initialize Revoke Delegation", () => {
			it("owner can schedule revocation for active selectors (emits RevocationScheduled) and ignores inactive", async () => {
				await context.instantLayer.connect(partyA1.getSigner).grantDelegation({
					account: delegatorAcct,
					delegatedSigner: delegateAddr,
					selectors: [selB],
					expiryTimestamp: (await getBlockTimestamp()) + 12n, // inactive
				})

				await increaseTime(12) // make selB to Expire

				await expect(context.instantLayer.connect(partyA1.getSigner).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selB, selA]))
					// only selA is active => only one schedule event
					.to.emit(context.instantLayer, "RevocationScheduled")
					.withArgs(delegatorAcct.addr, delegateAddr, selA, anyValue)
			})

			it("delegate can schedule revocation for themselves", async () => {
				await expect(context.instantLayer.connect(context.signers.admin).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB]))
					.to.emit(context.instantLayer, "RevocationScheduled")
					.withArgs(delegatorAcct.addr, delegateAddr, selA, anyValue)
					.and.to.emit(context.instantLayer, "RevocationScheduled")
					.withArgs(delegatorAcct.addr, delegateAddr, selB, anyValue)
			})

			it("REVOKER_ROLE can schedule revocation for any pair", async () => {
				await context.instantLayer.grantRole(REVOKER_ROLE, context.signers.user.address)

				await expect(context.instantLayer.connect(context.signers.user).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA]))
					.to.emit(context.instantLayer, "RevocationScheduled")
					.withArgs(delegatorAcct.addr, delegateAddr, selA, anyValue)
			})

			it("random caller (not owner/delegate/revoker) is rejected", async () => {
				await expect(context.instantLayer.connect(partyB1.getSigner).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA]))
					.to.be.revertedWithCustomError(context.instantLayer, "NotOwnerOfAccount")
					.withArgs(partyB1.address, delegatorAcct.addr)
			})
		})

		describe("Finalize Revoke Delegation", () => {
			it("reverts with RevocationCooldownNotOver if cooldown not elapsed", async () => {
				await context.instantLayer.connect(partyA1.getSigner).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA])

				await expect(context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA])).to.be.revertedWithCustomError(
					context.instantLayer,
					"RevocationCooldownNotOver",
				) // ETA in args is dynamic
			})

			it("finalizes after cooldown: clears delegation & pending, emits DelegationSelectorRevoked", async () => {
				// Schedule for both selectors (they're active due to the first grant)
				await context.instantLayer.connect(partyA1.getSigner).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB])

				await increaseTime(cooldown + 1)

				await expect(context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB]))
					.to.emit(context.instantLayer, "DelegationSelectorRevoked")
					.withArgs(delegatorAcct.addr, delegateAddr, selA)
					.and.to.emit(context.instantLayer, "DelegationSelectorRevoked")
					.withArgs(delegatorAcct.addr, delegateAddr, selB)

				// Check on-chain view that delegations are gone (mapping is public in your contract)
				const aExp = await context.instantLayer.delegations(delegatorAcct.addr, delegateAddr, selA as any)
				const bExp = await context.instantLayer.delegations(delegatorAcct.addr, delegateAddr, selB as any)
				expect(aExp).to.equal(0n)
				expect(bExp).to.equal(0n)

				const aEta = await context.instantLayer.pendingRevocationEta(delegatorAcct.addr, delegateAddr, selA as any)
				const bEta = await context.instantLayer.pendingRevocationEta(delegatorAcct.addr, delegateAddr, selB as any)
				expect(aEta).to.equal(0n)
				expect(bEta).to.equal(0n)
			})

			it("finalize is idempotent: calling again with no scheduled items is a no-op (no revert)", async () => {
				await context.instantLayer.connect(partyA1.getSigner).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA])
				await increaseTime(cooldown + 1)
				await context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA])

				// second call: eta=0, code path just continues
				await expect(context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA])).not.to.be.reverted
			})

			it("mixed set: only selectors with ETA set are revoked; others are ignored", async () => {
				// Only schedule selA
				await context.instantLayer.connect(partyA1.getSigner).initiateRevokeDelegation(delegatorAcct, delegateAddr, [selA])

				await increaseTime(cooldown + 1)

				// Try finalizing both selA (scheduled) and selB (not scheduled)
				await expect(context.instantLayer.finalizeRevokeDelegation(delegatorAcct, delegateAddr, [selA, selB]))
					.to.emit(context.instantLayer, "DelegationSelectorRevoked")
					.withArgs(delegatorAcct.addr, delegateAddr, selA)

				// After finalize: selA removed, selB still active
				const aExp = await context.instantLayer.delegations(delegatorAcct.addr, delegateAddr, selA as any)
				const bExp = await context.instantLayer.delegations(delegatorAcct.addr, delegateAddr, selB as any)
				expect(aExp).to.equal(0n)
				expect(bExp).to.be.greaterThan(0n)
			})
		})
	})

	describe("Target contract routing", () => {
		let accountAddress: string
		let mockTarget: any
		let targetAddress: string
		let deadline: bigint

		beforeEach(async () => {
			const MockInstantTarget = await ethers.getContractFactory("MockInstantTarget")
			mockTarget = await MockInstantTarget.deploy()
			targetAddress = await mockTarget.getAddress()
			await context.instantLayer.setTargetWhitelist(targetAddress, true)

			await context.accountManager.connect(partyA1.getSigner).addAccount("targetRoute")
			const accounts = await context.accountManager.getAccounts(partyA1.address, 0, 10)
			accountAddress = accounts[accounts.length - 1].accountAddress

			deadline = await getBlockTimestamp(300n)
		})

		const buildTargetOp = (target: string, signer: string): InstantLayer.SignedOperationStruct => {
			return {
				signer,
				target,
				callData: mockTarget.interface.encodeFunctionData("store", [123n]),
				signerAccount: {
					addr: accountAddress,
					isPartyB: false,
				},
				replayAttackHeader: {
					nonce: 0n,
					deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}
		}

		it("executes whitelisted target call and updates target state", async () => {
			// happy path on direct target
			const op = buildTargetOp(targetAddress, partyA1.address)
			const sig = await partyA1.getSigner.signTypedData(domain, types, op)

			await expect(context.instantLayer.executeBatch([op], [sig])).not.to.be.reverted
			expect(await mockTarget.lastValue()).to.equal(123n)
		})

		it("reverts when target is not whitelisted", async () => {
			// target must be explicitly whitelisted
			const MockInstantTarget = await ethers.getContractFactory("MockInstantTarget")
			const unlisted = await MockInstantTarget.deploy()
			const op = buildTargetOp(await unlisted.getAddress(), partyA1.address)
			const sig = await partyA1.getSigner.signTypedData(domain, types, op)

			await expect(context.instantLayer.executeBatch([op], [sig]))
				.to.be.revertedWithCustomError(context.instantLayer, "UnwhitelistedTarget")
				.withArgs(await unlisted.getAddress())
		})

		it("bubbles target revert inside OperationFailed", async () => {
			// revert from target should handle by instant layer
			await mockTarget.setShouldRevert(true, "xxx")
			const op = buildTargetOp(targetAddress, partyA1.address)
			const sig = await partyA1.getSigner.signTypedData(domain, types, op)

			await expect(context.instantLayer.executeBatch([op], [sig]))
				.to.be.revertedWithCustomError(context.instantLayer, "OperationFailed")
				.withArgs(0, anyValue)
		})
	})
}
function now() {
	throw new Error("Function not implemented.")
}
