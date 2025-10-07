import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect, use } from "chai"
import { initializeFixture } from "../Initialize.fixture"
import { PositionType, QuoteStatus } from "../models/Enums"
import { Hedger } from "../models/Hedger"
import { RunContext } from "../models/RunContext"
import { User } from "../models/User"
import { limitOpenRequestBuilder, marketOpenRequestBuilder, OpenRequest } from "../models/requestModels/OpenRequest"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder, QuoteRequest, QuoteRequestWithData } from "../models/requestModels/QuoteRequest"
import { OpenPositionValidator } from "../models/validators/OpenPositionValidator"
import { decimal, getBlockTimestamp, getQuoteQuantity, pausePartyB } from "../utils/Common"
import { ethers, network } from "hardhat"
import {
	AbiCoder,
	encodeBytes32String,
	InterfaceAbi,
	ZeroAddress,
	AddressLike,
	toUtf8Bytes,
	EthersError,
	BytesLike,
	MulticoinProviderPlugin,
	TypedDataDomain,
} from "ethers"
import { bigint, int } from "hardhat/internal/core/params/argumentTypes"
import { config } from "dotenv"

import * as diamond from "../../artifacts/contracts/Diamond.sol/Diamond.json"
// import * as partyAOpenIntent from "../artifacts/contracts/facets/PartyAOpen/PartyAOpenFacet.sol/PartyAOpenFacet.json"
// import * as partyBOpenIntent from "../artifacts/contracts/facets/PartyBOpen/PartyBOpenFacet.sol/PartyBOpenFacet.json"
import { trace } from "console"
import { hexZeroPad, zeroPad } from "@ethersproject/bytes"
import { Context } from "mocha"
import { asyncWrapProviders } from "async_hooks"
import { InstantLayer, SigCheckHarness, MultiAccount, SymmioPartyB, SymmioPartyA } from "../../src/types"
import { hedgerActionsMap } from "../models/Actions"

// import { IMultiAccount } from "../../src/types/contracts/interfaces"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "../utils/SignatureUtils"
import { IMultiAccount } from "../../src/types/contracts/multiAccount/MultiAccount"
import { cloneTypes } from "./instantLayerEIP712Types"

export function shouldBehaveLikeInstantLayer(): void {
	let context: RunContext, partyA1: User, partyA2: User, partyB1: Hedger, partyB2: Hedger
	let quoteCallData: string, lockQuoteCallData: string, openQuoteCallData: string, bindToPartyBCallData: string
	let saltOpen1: string, saltOpen2: string, saltLock: string, saltOpen: string

	let ops: InstantLayer.OperationStruct[]
	let signedOps: InstantLayer.SignedOperationStruct[]
	let ABI: InterfaceAbi

	let requestSendQuote: QuoteRequest
	let requestOpenQuote: OpenRequest

	let types: ReturnType<typeof cloneTypes>

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

		const { instantLayer, partyAFacet, partyBBatchActionsFacet, partyBPositionActionsFacet, partyBQuoteActionsFacet, accountFacet } = context
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
	})

	// describe("Registering PartyB", async function () {
	// 	it("Should be failed when Sender not Setter Role ", async () => {
	// 		await expect(context.instantLayer.connect(partyA1.getSigner).registerPartyB(partyA1.address)).to.be.reverted
	// 	})

	// 	it("Should Add PartyB to Whitelisted Bs", async () => {
	// 		await expect(context.instantLayer.registerPartyB(partyB1.address)).not.to.be.reverted

	// 		expect(await context.instantLayer.registeredPartyBs(partyB1.address)).to.be.equal(true)
	// 		expect(await context.instantLayer.registeredPartyBs(partyB2.address)).to.be.equal(false)
	// 	})

	// 	it("Should be granted the right role", async () => {
	// 		await expect(context.instantLayer.registerPartyB(partyB1.address)).not.to.be.reverted
	// 		const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))

	// 		expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB1.address)).to.be.equal(true)
	// 	})
	// })

	// describe("Unregistering PartyB", async function () {
	// 	it("Should be failed when Sender not Setter Role ", async () => {
	// 		await expect(context.instantLayer.connect(partyA1.getSigner).registerPartyB(partyB1.address)).to.be.reverted
	// 		await expect(context.instantLayer.connect(partyA1.getSigner).unregisterPartyB(partyB1.address)).to.be.reverted
	// 	})

	// 	it("Should remove PartyB from Whitelisted Bs", async () => {
	// 		await expect(context.instantLayer.registerPartyB(partyB1.address)).not.to.be.reverted
	// 		await expect(context.instantLayer.unregisterPartyB(partyB1.address)).not.to.be.reverted

	// 		expect(await context.instantLayer.registeredPartyBs(partyB1.address)).to.be.equal(false)
	// 	})

	// 	it("Should remove the right role", async () => {
	// 		await expect(context.instantLayer.registerPartyB(partyB1.address)).not.to.be.reverted
	// 		await expect(context.instantLayer.unregisterPartyB(partyB1.address)).not.to.be.reverted
	// 		const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))

	// 		expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB1.address)).to.be.equal(false)
	// 	})
	// })

	// describe("Registering PartyB Batch", async function () {
	// 	it("Should be failed when Sender not Setter Role ", async () => {
	// 		await expect(context.instantLayer.connect(context.signers.hedger).registerPartyBBatch([partyB1.address, partyB2.address])).to.be.reverted
	// 	})

	// 	it("Should Add PartyB to Whitelisted Bs", async () => {
	// 		await expect(context.instantLayer.registerPartyBBatch([partyB1.address, partyB2.address])).not.to.be.reverted

	// 		expect(await context.instantLayer.registeredPartyBs(partyB1.address)).to.be.equal(true)
	// 		expect(await context.instantLayer.registeredPartyBs(partyB2.address)).to.be.equal(true)
	// 	})

	// 	it("Should be granted the right role", async () => {
	// 		await expect(context.instantLayer.registerPartyBBatch([partyB1.address, partyB2.address])).not.to.be.reverted
	// 		const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))

	// 		expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB1.address)).to.be.equal(true)
	// 		expect(await context.instantLayer.hasRole(OPERATOR_ROLE, partyB2.address)).to.be.equal(true)
	// 	})
	// })

	// describe("Registering MultiAccount Batch", async function () {
	// 	it("Should be failed when Sender not Setter Role ", async () => {
	// 		await expect(context.instantLayer.connect(context.signers.hedger).registerMultiAccountBatch([partyB1.address])).to.be.reverted
	// 	})

	// 	it("Should Add the multiAccount addresses batch to Whitelisted mapping", async () => {
	// 		await expect(context.instantLayer.registerMultiAccountBatch([partyA1.address, partyA2.address])).not.to.be.reverted

	// 		expect(await context.instantLayer.registeredMultiAccounts(partyA1.address)).to.be.equal(true)
	// 		expect(await context.instantLayer.registeredMultiAccounts(partyA2.address)).to.be.equal(true)
	// 	})
	// })

	// describe("Registering MultiAccount", async function () {
	// 	it("Should be failed when Sender not Setter Role ", async () => {
	// 		await expect(context.instantLayer.connect(partyA1.getSigner).registerMultiAccount(partyA2.address)).to.be.reverted
	// 	})

	// 	it("Should Add the multiAccount address to Whitelisted mapping", async () => {
	// 		await expect(context.instantLayer.registerMultiAccount(partyA1.address)).not.to.be.reverted

	// 		expect(await context.instantLayer.registeredMultiAccounts(partyA1.address)).to.be.equal(true)
	// 	})
	// })

	// describe("Unregistering MultiAccount", async function () {
	// 	it("Should be failed when Sender not Setter Role ", async () => {
	// 		await expect(context.instantLayer.connect(partyA1.getSigner).unregisterMultiAccount(partyA1.address)).to.be.reverted
	// 	})

	// 	it("Should Remove the multiAccount address from Whitelisted mapping", async () => {
	// 		await expect(context.instantLayer.unregisterMultiAccount(partyA1.address)).not.to.be.reverted

	// 		expect(await context.instantLayer.registeredMultiAccounts(partyA1.address)).to.be.equal(false)
	// 	})
	// })

	// describe("Adding Template", async function () {
	// 	it("Should be failed when Sender not have Setter Role ", async () => {
	// 		await expect(context.instantLayer.connect(partyA1.getSigner).addTemplate("test", ops)).to.be.reverted
	// 		//TODO adapt to recent changes
	// 	})

	// 	it("Should Set the template Active Mode to true", async () => {
	// 		await expect(context.instantLayer.addTemplate("test", ops)).not.to.be.reverted
	// 		let template = await context.instantLayer.getTemplate(0)
	// 		expect(template.active).to.be.equal(true)
	// 	})

	// 	it("Should Set the template Name as expected", async () => {
	// 		let name = "myTemp"
	// 		await expect(context.instantLayer.addTemplate(name, ops)).not.to.be.reverted
	// 		let template = await context.instantLayer.getTemplate(0)
	// 		expect(template.name).to.be.equal(name)
	// 	})

	// 	it("Should Set the template Operations as expected", async () => {
	// 		let name = "myTemp"
	// 		await expect(context.instantLayer.addTemplate(name, ops)).not.to.be.reverted
	// 		const tempID = (await context.instantLayer.getLastTemplateID()) - 1n
	// 		let template: InstantLayer.TemplateStruct = await context.instantLayer.getTemplate(tempID)

	// 		expect(template.operations.length).to.be.equal(ops.length) // equals 2
	// 		expect(template.name).to.equal(name)
	// 		expect(template.active).to.equal(true)

	// 		for (let i = 0; i < template.operations.length; i++) {
	// 			expect(template.operations[i].sourceIndices).to.deep.equal(ops[i].sourceIndices)
	// 			expect(template.operations[i].insertionPoints).to.deep.equal(ops[i].insertionPoints)
	// 		}
	// 	})
	// })

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

	describe.only("execute Batch", async function () {
		let opSendQuoteA1: InstantLayer.SignedOperationStruct, opSendQuoteA2: InstantLayer.SignedOperationStruct
		let opLockB1: InstantLayer.SignedOperationStruct, opOpenQuoteB1: InstantLayer.SignedOperationStruct
		let opSendQuoteSignature1: InstantLayer.SignatureCallDataStruct
		let opSendQuoteSignature2: InstantLayer.SignatureCallDataStruct
		let opLockSignature: InstantLayer.SignatureCallDataStruct
		let accounts: IMultiAccount.AccountStructOutput[]

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

			// Granting Roles
			await context.instantLayer.registerPartyB(context.symmioPartyB) // Admin with SETTER Role
			await context.controlFacet.registerPartyB(await context.symmioPartyB.getAddress())
			await context.instantLayer.registerMultiAccount(context.multiAccount) // Admin with SETTER Role
			await context.symmioPartyB.setSigner(partyB1.getSigner) // Admin with SETTER Role
			// await context.symmioPartyB.setMulticastWhitelist(context.diamond, true)

			await expect(context.multiAccount.connect(partyA1.getSigner).addAccount("testAccount")).not.to.reverted // here the party A Role is an EOA to create an Party A address
			accounts = await context.multiAccount.getAccounts(partyA1.address, 0, 100)

			await expect(context.collateral.connect(partyA1.getSigner).approve(context.diamond, ethers.MaxUint256)).not.reverted
			await context.symmioPartyB.grantRole(ethers.keccak256(toUtf8Bytes("TRUSTED_ROLE")), partyA1.address)
			await expect(context.symmioPartyB.connect(partyA1.getSigner)._approve(context.collateral, decimal(30n))).not.to.be.reverted // for symmoio contract

			await expect(context.collateral.connect(partyA1.getSigner).mint(accounts[0].accountAddress, decimal(30n))).to.not.reverted
			await context.accountFacet.connect(partyA1.getSigner).depositFor(accounts[0].accountAddress, decimal(20n))
			await context.accountFacet.connect(partyA1.getSigner).internalTransfer(accounts[0].accountAddress, decimal(1000n))

			//Delegating Access
			// const delegator: AccountStruct = {}
			const selectorQuote = quoteCallData.slice(0, 10)
			const selectorLock = lockQuoteCallData.slice(0, 10)
			const selectorOpen = openQuoteCallData.slice(0, 10)
			console.log("Quote Selector:", selectorQuote)
			await context.instantLayer.connect(partyA1.getSigner).grantDelegation(
				{
					multiAccount: await context.multiAccount.getAddress(),
					partyA_AccountAddress: accounts[0].accountAddress,
					accountOwner: partyA1.address,
					selector: selectorQuote,
				},
				context.signers.admin.address,
				await getBlockTimestamp(100n),
			)
			// await context.instantLayer.connect(partyB1.getSigner).grantDelegation(await context.symmioPartyB.getAddress(), await getBlockTimestamp(100n))

			// Bind to Party B
			await context.multiAccount.connect(partyA1.getSigner)._call(accounts[0].accountAddress, [bindToPartyBCallData])
			console.log("Bound to Party B")

			// Whitelisting Symbol type
			await context.controlFacet.setPartyBWhitelistedSymbolTypeStatus(context.symmioPartyB.getAddress(), 1, true)

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
			console.log("Quote Param data:", sendQuoteParamsOnly)

			opSendQuoteA1 = {
				signer: context.signers.admin.address,
				params: {
					targetContract: context.diamond,
					keyValueHash: ethers.ZeroHash,
					keyValue: "",
					callDataHash: sendQuoteParamHash,
					functionSignature: sendQuoteWithAffiliateSignature, // canonical
				},
				side: 0, // PartyA
				delegator: {
					multiAccount: await context.multiAccount.getAddress(),
					partyA_AccountAddress: accounts[0].accountAddress,
					accountOwner: partyA1.address,
					selector: selectorQuote,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opSendQuoteA2 = {
				signer: partyA1.address,
				params: {
					targetContract: context.diamond,
					keyValueHash: ethers.ZeroHash,
					keyValue: "",
					callDataHash: sendQuoteParamHash,
					functionSignature: sendQuoteWithAffiliateSignature, // canonical
				},
				side: 0, // PartyA
				delegator: {
					multiAccount: await context.multiAccount.getAddress(),
					partyA_AccountAddress: accounts[0].accountAddress,
					accountOwner: partyA1.address,
					selector: selectorQuote,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opLockB1 = {
				signer: await context.symmioPartyB.getAddress(),
				params: {
					targetContract: context.diamond,
					keyValueHash: ethers.ZeroHash,
					keyValue: "",
					callDataHash: lockQuoteParamHash,
					functionSignature: lockQuoteSignature, // canonical
				},
				side: 1, // PartyB
				delegator: {
					multiAccount: ZeroAddress,
					partyA_AccountAddress: ZeroAddress,
					accountOwner: ZeroAddress,
					selector: selectorLock,
				},
				replayAttackHeader: {
					nonce: 1n,
					deadline: deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			opSendQuoteSignature1 = {
				signature: new Uint8Array([0x1, 0x2]),
				callData: sendQuoteParamsOnly,
			}

			opSendQuoteSignature2 = {
				signature: new Uint8Array([0x1, 0x2]),
				callData: sendQuoteParamsOnly,
				
			}

			opLockSignature = {
				signature: new Uint8Array([0x1, 0x2]),
				callData: lockQuoteParamsOnly,
				
			}

			// opLockB1 = {
			// 	actualSigner: partyA1.address,
			// 	signature: new Uint8Array([0x1, 0x2]),
			// 	params: {
			// 		target: context.diamond,
			// 		callData: sendQuoteParamsOnly, // parameters only
			// 		paramHash: sendQuoteParamHash,
			// 		functionSignature: sendQuoteWithAffiliateSignature, // canonical
			// 	},
			// 	side: 0, // PartyA
			// 	delegator: {
			// 		multiAccount: await context.multiAccount.getAddress(),
			// 		accountAddress: accounts[0].accountAddress,
			// 		accountOwner: partyA1.address,
			// 		selector: selectorQuote,
			// 	},
			// 	rpl: {
			// 		nonce: 1n,
			// 		deadline: deadline,
			// 		salt: ethers.hexlify(ethers.randomBytes(32)),
			// 	},
			// }

			// opLockB1 = {
			// 	actualSigner: context.symmioPartyB,
			// 	callData: lockQuoteCallData,
			// 	nonce: 0,
			// 	salt: saltLock,
			// 	deadline: deadline,
			// 	signature: new Uint8Array([0x1, 0x2]),
			// 	side: 1, //SignedOperationSides.PartyB,
			// 	delegator: {
			// 		multiAccount: ZeroAddress,
			// 		accountAddress: ZeroAddress,
			// 		accountOwner: ZeroAddress,
			// 		selector: "0x12345678",
			// 	},
			// }

			// opOpenQuoteB1 = {
			// 	actualSigner: context.symmioPartyB,
			// 	callData: openQuoteCallData,
			// 	nonce: 0,
			// 	salt: saltOpen,
			// 	deadline: deadline,
			// 	signature: new Uint8Array([0x1, 0x2]),
			// 	side: 1, //SignedOperationSides.PartyB,
			// 	delegator: {
			// 		multiAccount: ZeroAddress,
			// 		accountAddress: ZeroAddress,
			// 		accountOwner: ZeroAddress,
			// 		selector: "0x12345678",
			// 	},
			// }
		})

		// it("Should be failed when Sender not have Operator Role ", async () => {
		// 	await expect(context.instantLayer.connect(partyA1.getSigner).executeBatch([], [])).to.be.reverted // with "AccessControl" Error
		// })

		// it("Should be failed when input Ops have zero length ", async () => {
		// 	await expect(context.instantLayer.executeBatch([], [])).to.be.revertedWithCustomError(context.instantLayer, "EmptyBatch")
		// })

		// it("Should be failed when input Ops have passed the Deadline ", async () => {
		// 	const deadline = await getBlockTimestamp(24n)
		// 	await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline)])
		// 	await network.provider.send("evm_mine")
		// 	let saltStr: string = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
		// 	const opOpenALocal: InstantLayer.SignedOperationStruct = {
		// 		actualSigner: partyA1.address,
		// 		callData: "0x1234",
		// 		nonce: 100,
		// 		salt: saltLock,
		// 		deadline: deadline,
		// 		signature: "0x",
		// 		side: 0,
		// 		delegator: {
		// 			multiAccount: ZeroAddress,
		// 			accountAddress: ZeroAddress,
		// 			accountOwner: ZeroAddress,
		// 			selector: "0x12345678",
		// 		},
		// 	}
		// 	await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		// 	await expect(context.instantLayer.executeBatch([opOpenALocal])).to.be.revertedWithCustomError(context.instantLayer, "DeadlineExpired")
		// })

		// it("should Register Symmio PartyB when sending as PartyB", async function () {
		// 	const { instantLayer } = context
		// 	const deadline = await getBlockTimestamp(24n)

		// 	opLockB1.side = 1
		// 	opLockB1.actualSigner = partyB1.address

		// 	await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		// 	await expect(context.instantLayer.executeBatch([opLockB1])).to.be.revertedWithCustomError(context.instantLayer, "UnregisteredPartyB")
		// })

		it.only("should allow Sending Intents in a single batch", async function () {
			const domain: TypedDataDomain = {
				name: "SymmioInstantLayer",
				version: "1",
				chainId: (await ethers.provider.getNetwork()).chainId,
				verifyingContract: await context.instantLayer.getAddress(),
			}

			const { instantLayer, partyAFacet, partyBQuoteActionsFacet, partyBPositionActionsFacet } = context
			const multiAccount = context.multiAccount

			//Sign using getOperationHash
			// const opSendAHash1 = await instantLayer.getOperationHash(opSendQuoteA1, false)
			// const opSendAHash2 = await instantLayer.getOperationHash(opSendQuoteA2, false)
			// const opLockBHash = await instantLayer.getOperationHash(opLockB1, false)
			// const opOpenB`Hash = await instantLayer.getOperationHash(opOpenQuoteB1, false)
			console.log(types)
			opSendQuoteSignature1.signature = await context.signers.admin.signTypedData(domain, types, opSendQuoteA1)
			opSendQuoteSignature2.signature = await context.signers.user.signTypedData(domain, types, opSendQuoteA2)
			opLockSignature.signature = await context.signers.hedger.signTypedData(domain, types, opLockB1)

			// opLockB1.signature = await partyB1.sign(ethers.getBytes(opLockBHash))
			// opOpenQuoteB1.signature = await partyB1.sign(ethers.getBytes(opOpenBHash))

			console.log("Test signature:", opSendQuoteSignature1.signature)
			const signedOps: InstantLayer.SignedOperationStruct[] = [opSendQuoteA1, opSendQuoteA2, opLockB1]
			const sigCallDatas: InstantLayer.SignatureCallDataStruct[] = [opSendQuoteSignature1, opSendQuoteSignature2, opLockSignature]

			await expect(instantLayer.executeBatch(signedOps, sigCallDatas)).not.to.be.reverted

			let quote = await context.viewFacet.getQuote(1)
			let quote2 = await context.viewFacet.getQuote(2)
			expect(quote.requestedOpenPrice).to.be.equal(requestSendQuote.price)
			expect(quote.quantity).to.be.equal(requestSendQuote.quantity)
			expect(quote2.requestedOpenPrice).to.be.equal(requestSendQuote.price)
			expect(quote2.quantity).to.be.equal(requestSendQuote.quantity)

			expect(quote.quoteStatus).to.be.equal(QuoteStatus.LOCKED)
			expect(quote2.quoteStatus).to.be.equal(QuoteStatus.PENDING)

			console.log("done")
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
		// 	let quote = await context.viewFacet.getQuote(lastID)
		// 	expect(quote.requestedOpenPrice).to.be.equal(requestSendQuote.price)
		// 	expect(quote.quantity).to.be.equal(requestSendQuote.quantity)
		// 	console.log("Quote Status, ID:", lastID, quote.quoteStatus == BigInt(QuoteStatus.PENDING) ? "Pending" : quote.quoteStatus)

		// 	const signedOpsLock: InstantLayer.SignedOperationStruct[] = [opLockB1]
		// 	await expect(instantLayer.executeBatch(signedOpsLock)).not.to.be.reverted
		// 	quote = await context.viewFacet.getQuote(lastID)
		// 	console.log("Quote Status, ID:", lastID, quote.quoteStatus == BigInt(QuoteStatus.LOCKED) ? "Locked" : quote.quoteStatus)
		// 	expect(quote.quoteStatus).to.be.equal(QuoteStatus.LOCKED)

		// 	const signedOpsFill: InstantLayer.SignedOperationStruct[] = [opOpenQuoteB1]
		// 	await expect(instantLayer.executeBatch(signedOpsFill)).not.to.be.reverted
		// 	quote = await context.viewFacet.getQuote(lastID)
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
		// 	let quote = await context.viewFacet.getQuote(lastID)
		// 	console.log("Quote Status, ID:", lastID, quote.quoteStatus == BigInt(QuoteStatus.OPENED) ? "Opened" : quote.quoteStatus)
		// 	expect(quote.quoteStatus).to.be.equal(QuoteStatus.OPENED)
		// })

		// it("should Fail Signature verification with Invalid Nonce", async function () {
		// 	const latestBlock = await getLatestBlockTime()
		// 	const deadline = latestBlock + 300
		// 	// Granting Roles
		// 	await context.instantLayer.registerMultiAccount(context.multiAccount)
		// 	let saltStr: string = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
		// 	if (!/^0x[0-9a-fA-F]{64}$/.test(saltStr)) {
		// 		throw new Error("Invalid bytes32 format")
		// 	}
		// 	const opOpenALocal: InstantLayer.SignedOperationStruct = {
		// 		accountSource: await context.multiAccount.getAddress(),
		// 		signer: accounts[0].account,
		// 		callData: openIntentCallData,
		// 		nonce: 2,
		// 		salt: saltStr,
		// 		deadline: deadline,
		// 		signature: "0x",
		// 	}
		// 	const hash = await context.instantLayer.getOperationHash(opOpenALocal)
		// 	opOpenALocal.signature = await partyA1.sign(ethers.getBytes(hash))
		// 	await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		// 	await expect(context.instantLayer.executeBatch([opOpenALocal])).to.be.revertedWithCustomError(context.instantLayer, "InvalidNonce")
		// })

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
		// 	let opOpenA1: InstantLayer.SignedOperationStruct, opOpenA2: InstantLayer.SignedOperationStruct
		// 	let opLockB1: InstantLayer.SignedOperationStruct, opFillB1: InstantLayer.SignedOperationStruct
		// 	let accounts: MultiAccount.AccountStruct[]
		// 	beforeEach(async function () {
		// 		const latestBlock = await getLatestBlockTime()
		// 		const deadline = latestBlock + 300
		// 		await expect(context.multiAccount.connect(partyA1.getSigner).addAccount("testAccount")).not.to.reverted // here the party A Role is an EOA to create an Party A address
		// 		accounts = await context.multiAccount.getAccounts(partyA1.address, 0, 100)
		// 		// await expect(context.collateral.connect(partyA1.getSigner).approve(context.common.diamondAddress, ethers.MaxUint256)).not.reverted
		// 		await context.symmioPartyB.grantRole(ethers.keccak256(toUtf8Bytes("TRUSTED_ROLE")), partyA1.address)
		// 		await expect(context.symmioPartyB.connect(partyA1.getSigner)._approve(context.collateral, e(30))).not.to.be.reverted // for symmoio contract
		// 		await expect(context.collateral.connect(partyA1.getSigner).mint(accounts[0].account, e(30))).to.not.reverted
		// 		await expect(context.collateralNL.connect(partyA1.getSigner).mint(accounts[0].account, e(30))).to.not.reverted
		// 		await context.accountFacet.connect(partyA1.getSigner).depositFor(await context.collateral.getAddress(), accounts[0].account, e(20))
		// 		await context.accountFacet.connect(partyA1.getSigner).depositFor(await context.collateralNL.getAddress(), accounts[0].account, e(20))
		// 		opOpenA1 = {
		// 			accountSource: await context.multiAccount.getAddress(),
		// 			signer: accounts[0].account,
		// 			callData: openIntentCallData,
		// 			nonce: 0,
		// 			salt: saltOpen1,
		// 			deadline: deadline,
		// 			signature: new Uint8Array([0x1, 0x2]),
		// 		}
		// 		opOpenA2 = {
		// 			accountSource: await context.multiAccount.getAddress(),
		// 			signer: accounts[0].account,
		// 			callData: openIntentCallData,
		// 			nonce: 0,
		// 			salt: saltOpen2,
		// 			deadline: deadline,
		// 			signature: new Uint8Array([0x1, 0x2]),
		// 		}
		// 		opLockB1 = {
		// 			accountSource: ethers.ZeroAddress,
		// 			signer: await context.symmioPartyB.getAddress(),
		// 			callData: lockIntentCallData,
		// 			nonce: 0,
		// 			salt: saltLock,
		// 			deadline: deadline,
		// 			signature: new Uint8Array([0x1, 0x2]),
		// 		}
		// 		opFillB1 = {
		// 			accountSource: ethers.ZeroAddress,
		// 			signer: await context.symmioPartyB.getAddress(),
		// 			callData: fillIntentCallData,
		// 			nonce: 0,
		// 			salt: saltFill,
		// 			deadline: deadline,
		// 			signature: new Uint8Array([0x1, 0x2]),
		// 		}
		// 		await context.instantLayer.addTemplate("MyTemp", ops)
		// 	})
		// 	it("Should be failed when Sender not have Operator Role ", async () => {
		// 		await expect(context.instantLayer.connect(partyA1.getSigner).executeTemplate(1, [])).to.be.reverted // with "AccessControl" Error
		// 	})
		// 	it("Should be failed when Template Inactive ", async () => {
		// 		const tempID = (await context.instantLayer.getLastTemplateID()) - 1n
		// 		await context.instantLayer.setTemplateActive(tempID, false)
		// 		await expect(context.instantLayer.executeTemplate(tempID, [])).to.be.revertedWithCustomError(context.instantLayer, "TemplateNotActive")
		// 	})
		// 	it("Should be failed when Template Operation Input length Mismatch ", async () => {
		// 		const opsLocal: InstantLayer.OperationStruct[] = [
		// 			{
		// 				sourceIndices: [],
		// 				insertionPoints: [1],
		// 			},
		// 		]
		// 		await context.instantLayer.addTemplate("MyTemp", opsLocal)
		// 		const tempID = (await context.instantLayer.getLastTemplateID()) - 1n
		// 		await expect(context.instantLayer.executeTemplate(tempID, [])).to.be.revertedWithCustomError(context.instantLayer, "ArrayLengthMismatch")
		// 	})
		// 	it("Should be failed when input Ops have passed the Deadline ", async () => {
		// 		const deadline = await getLatestBlockTime()
		// 		await network.provider.send("evm_setNextBlockTimestamp", [deadline + 24])
		// 		await network.provider.send("evm_mine")
		// 		let saltStr: string = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
		// 		const opOpenALocal: InstantLayer.SignedOperationStruct = {
		// 			accountSource: ZeroAddress,
		// 			signer: ZeroAddress,
		// 			callData: "0x", // no matter
		// 			nonce: 100, // no matter
		// 			salt: saltStr, // no matter
		// 			deadline: deadline,
		// 			signature: "0x",
		// 		}
		// 		let opsLocal: InstantLayer.OperationStruct[]
		// 		opsLocal = [
		// 			{
		// 				sourceIndices: [],
		// 				insertionPoints: [],
		// 			},
		// 		]
		// 		await context.instantLayer.addTemplate("MyLocal", opsLocal)
		// 		const tempID = (await context.instantLayer.getLastTemplateID()) - 1n
		// 		await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
		// 		await expect(context.instantLayer.executeTemplate(tempID, [opOpenALocal])).to.be.revertedWithCustomError(
		// 			context.instantLayer,
		// 			"DeadlineExpired",
		// 		)
		// 	})
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
		// 	it("should allow Sending Intent, Locking and Filling in a single batch Altogether", async function () {
		// 		const { instantLayer, collateralNL, partyAOpenFacet, partyBOpenFacet, symmioPartyB } = context
		// 		const multiAccount = context.multiAccount
		// 		// Granting Roles
		// 		await context.instantLayer.registerPartyB(symmioPartyB)
		// 		await context.instantLayer.registerMultiAccount(multiAccount)
		// 		await context.symmioPartyB.setSigner(partyB1.getSigner)
		// 		// await context.symmioPartyB.setMulticastWhitelist(context.common.diamondAddress, true)
		// 		await context.controlFacet.grantRole(context.instantLayer, ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")))
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
		// 		const tempID = (await context.instantLayer.getLastTemplateID()) - 1n
		// 		//Execution
		// 		const signedOps: InstantLayer.SignedOperationStruct[] = [opOpenA1, opOpenA2, opLockB1, opFillB1]
		// 		await expect(instantLayer.executeTemplate(tempID, signedOps)).not.to.be.reverted
		// 		// try {
		// 		// 	await instantLayer.executeTemplate(tempID, signedOps) // Admin with OPERATOR Role
		// 		// } catch (error: unknown) {
		// 		// 	console.log("Error Fetched:", error)
		// 		// }
		// 		//Verification
		// 		const lastID = await context.viewFacet.getLastOpenIntentId()
		// 		expect(lastID).to.equal(2)
		// 		let intent: OpenIntentStruct = await context.viewFacet.getOpenIntent(1)
		// 		expect(intent.price).to.be.equal(request.price)
		// 		expect(intent.tradeAgreements.quantity).to.be.equal(request.quantity)
		// 		console.log("Intent Status", 1, intent.status == IntentStatus.FILLED ? "Filled" : intent.status)
		// 		expect(intent.status).to.be.equal(IntentStatus.FILLED)
		// 		const lastTradeId = await context.viewFacet.getLastTradeId()
		// 		let trade: TradeStruct = await context.viewFacet.getTrade(lastTradeId)
		// 		expect(trade.openIntentId).to.be.equal(intent.id)
		// 	})
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
}
