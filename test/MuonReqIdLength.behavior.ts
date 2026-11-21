import { expect } from "chai"

import { deployExpressProvider } from "../tasks/deploy/expressWithdrawLayerDiamond.js"
import { initializeFixture } from "./Initialize.fixture.js"
import connection, { ethers, hre } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { decimal } from "./utils/Common.js"
import { DUMMY_EXPRESS_REQ_ID } from "./utils/MuonSignature.js"
import { DUMMY_REQ_ID, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
const SIGNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ROLE"))

/// @notice Non-32-byte reqIds under test: empty, one byte short, one byte long,
///         and the reported 52-byte ID (20 bytes longer than the required 32).
const INVALID_REQ_IDS = [
	{ label: "empty", reqId: "0x", length: 0n },
	{ label: "31 bytes", reqId: "0x" + "55".repeat(31), length: 31n },
	{ label: "33 bytes", reqId: "0x" + "66".repeat(33), length: 33n },
	{ label: "52 bytes", reqId: "0x" + "77".repeat(52), length: 52n },
]

export function shouldBehaveLikeMuonReqIdLength(): void {
	describe("Muon reqId length", function () {
		describe("core deallocate", function () {
			let context: RunContext, user: User

			beforeEach(async function () {
				context = await loadFixture(initializeFixture)
				user = new User(context, context.signers.user)
				await user.setup()
				await user.setBalances(decimal(500n), decimal(300n), decimal(300n))
			})

			it("accepts a signature with a 32-byte reqId", async function () {
				expect(ethers.getBytes(DUMMY_REQ_ID).length).to.equal(32)
				const userAddress = await user.getAddress()
				const amount = decimal(50n)

				await context.accountFacet.connect(context.signers.user).deallocate(amount, await getDummySingleUpnlSig())

				expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(decimal(300n) - amount)
			})

			for (const { label, reqId, length } of INVALID_REQ_IDS) {
				it(`rejects a ${label} reqId with InvalidMuonReqIdLength`, async function () {
					expect(ethers.getBytes(reqId).length).to.equal(Number(length))
					const sig = { ...(await getDummySingleUpnlSig()), reqId }

					// The mock verifier accepts any crypto, so a revert here can only come
					// from the new length check; assert its specific error, not just any revert.
					await expect(context.accountFacet.connect(context.signers.user).deallocate(decimal(50n), sig as any))
						.to.be.revertedWithCustomError(context.accountFacet, "InvalidMuonReqIdLength")
						.withArgs(length)
				})
			}
		})

		describe("express credit reservation", function () {
			async function deployFixture() {
				const context: RunContext = await initializeFixture()
				const allSigners = await ethers.getSigners()
				const deployer = context.signers.admin
				const user = context.signers.user
				const botSigner = allSigners[13]
				const operator = allSigners[14]
				const receiver = allSigners[15]
				const affiliateOwner = allSigners[16]

				const collateral = context.collateral
				const affiliate = affiliateOwner.address
				const accountLayer = await ethers.deployContract("MockExpressAccountLayer")
				await accountLayer.setAccounts(
					allSigners.map(signer => signer.address),
					affiliate,
					true,
				)

				const expressProvider = await deployExpressProvider(hre, connection, {
					admin: deployer.address,
					symmio: context.diamond,
					collateral: await collateral.getAddress(),
					accountLayer: await accountLayer.getAddress(),
				})
				const muonVerifier = await ethers.deployContract("MockMuonSignatureVerifier")

				await context.controlFacet.connect(deployer).registerExpressProvider(await expressProvider.getAddress())
				await context.controlFacet.connect(deployer).setMaxWithdrawParts(50)
				await context.controlFacet.connect(deployer).setWithdrawCooldownPeriod(43200)
				await expressProvider["grantRole(address,bytes32)"](botSigner.address, SIGNER_ROLE)
				await expressProvider["grantRole(address,bytes32)"](operator.address, OPERATOR_ROLE)
				await expressProvider.setCreditLineMuonConfig(await muonVerifier.getAddress(), 1n, 3600n)

				const userBalance = 100_000n * 10n ** 18n
				await collateral.mint(user.address, userBalance)
				await collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
				await context.accountFacet.connect(user).deposit(userBalance)

				const generalFunding = 10_000n * 10n ** 18n
				await collateral.mint(deployer.address, generalFunding)
				await collateral.approve(await expressProvider.getAddress(), generalFunding)
				await expressProvider.depositToGeneral(generalFunding)

				const affiliateFunding = 5_000n * 10n ** 18n
				await collateral.mint(deployer.address, affiliateFunding)
				await collateral.approve(await expressProvider.getAddress(), affiliateFunding)
				await expressProvider.depositToAffiliate(affiliate, affiliateFunding)

				return { context, deployer, botSigner, operator, user, receiver, affiliate, collateral, expressProvider }
			}

			function computePartsHash(parts: any[]): string {
				const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
					["tuple(uint256 id, uint256 amount, int256 chainId, bytes receiver, address virtualProvider, address expressProvider)[]"],
					[parts],
				)
				return ethers.keccak256(encoded)
			}

			function buildCreditData(reqId: string, eligibleBase: bigint, timestamp: number): string {
				return ethers.AbiCoder.defaultAbiCoder().encode(
					[
						"tuple(bytes reqId, uint256 eligibleBase, uint256 timestamp, bytes gatewaySignature, tuple(uint256 signature, address owner, address nonce) sigs)",
					],
					[
						{
							reqId,
							eligibleBase,
							timestamp,
							gatewaySignature: "0x",
							sigs: { signature: 0n, owner: ethers.ZeroAddress, nonce: ethers.ZeroAddress },
						},
					],
				)
			}

			async function initiateWindowedWithCredit(fixture: any, reqId: string) {
				const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
				const withdrawAmount = 500n * 10n ** 18n
				const creditAmount = 100n * 10n ** 18n
				const expressAddr = await expressProvider.getAddress()
				const parts = [
					{
						id: 0n,
						amount: withdrawAmount,
						chainId: 31337n,
						receiver: receiver.address,
						virtualProvider: ethers.ZeroAddress,
						expressProvider: expressAddr,
					},
				]
				const partsHash = computePartsHash(parts)
				const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600
				const nonce = await expressProvider.nonces(user.address)
				const domain = {
					name: "ExpressProvider",
					version: "1",
					chainId: 31337,
					verifyingContract: expressAddr,
				}
				const types = {
					WithdrawOption: [
						{ name: "user", type: "address" },
						{ name: "nonce", type: "uint256" },
						{ name: "optionType", type: "uint8" },
						{ name: "availableAt", type: "uint256" },
						{ name: "affiliate", type: "address" },
						{ name: "affiliateAmount", type: "uint256" },
						{ name: "creditAmount", type: "uint256" },
						{ name: "fee", type: "uint256" },
						{ name: "operatorFee", type: "uint256" },
						{ name: "maxUserFee", type: "uint256" },
						{ name: "maxAccelerationFee", type: "uint256" },
						{ name: "partsHash", type: "bytes32" },
						{ name: "deadline", type: "uint256" },
					],
				}
				const signature = await botSigner.signTypedData(domain, types, {
					user: user.address,
					nonce,
					optionType: 1,
					availableAt: 0,
					affiliate,
					affiliateAmount: 0n,
					creditAmount,
					fee: 0n,
					operatorFee: 0n,
					maxUserFee: 0n,
					maxAccelerationFee: 0n,
					partsHash,
					deadline,
				})
				const now = (await ethers.provider.getBlock("latest"))!.timestamp
				const offerData = ethers.AbiCoder.defaultAbiCoder().encode(
					["uint256", "uint8", "uint256", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes"],
					[nonce, 1, 0, affiliate, 0n, creditAmount, 0n, 0n, 0n, 0n, deadline, signature],
				)
				const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "uint256[]"], [[], []])
				const providerData = ethers.AbiCoder.defaultAbiCoder().encode(
					["bytes", "bytes", "bytes"],
					[offerData, validatorData, buildCreditData(reqId, 10_000n * 10n ** 18n, now)],
				)
				return { parts, providerData, creditAmount }
			}

			it("accepts credit data with a 32-byte reqId", async function () {
				expect(ethers.getBytes(DUMMY_EXPRESS_REQ_ID).length).to.equal(32)
				const fixture = await deployFixture()
				const { context, user, expressProvider } = fixture
				const { parts, providerData, creditAmount } = await initiateWindowedWithCredit(fixture, DUMMY_EXPRESS_REQ_ID)

				await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

				const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)
				const info = await expressProvider.getWithdrawInfo(user.address, requestId)
				expect(info.status).to.equal(1n) // ACCEPTED
				expect(info.creditAmount).to.equal(creditAmount)
			})

			for (const { label, reqId, length } of INVALID_REQ_IDS) {
				it(`rejects credit data with a ${label} reqId with InvalidMuonReqIdLength`, async function () {
					expect(ethers.getBytes(reqId).length).to.equal(Number(length))
					const fixture = await deployFixture()
					const { context, user, expressProvider } = fixture
					const { parts, providerData } = await initiateWindowedWithCredit(fixture, reqId)

					// The mock verifier accepts any crypto, so a revert here can only come
					// from the new length check; assert its specific error, not just any revert.
					await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData))
						.to.be.revertedWithCustomError(expressProvider, "InvalidMuonReqIdLength")
						.withArgs(length)
				})
			}
		})
	})
}
