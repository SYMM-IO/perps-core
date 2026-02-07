import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { RunContext } from "./models/RunContext.js"

type Stakeholder = { receiver: string; share: bigint }
type AffiliateRegistrationInput = {
	name: string
	brandColor: string
	admin: string
	stakeholders: Stakeholder[]
	symmioShare: bigint
	metadata: string | Uint8Array
	legacyMultiAccounts: string[]
	symmioCores: string[]
}

const AffiliateState = {
	NONE: 0n,
	PENDING: 1n,
	ACTIVE: 2n,
	PAUSED: 3n,
	DEACTIVATED: 4n,
} as const

const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))

// SIGNER_SETTER_ROLE was renamed to SIGNER_ADMIN_ROLE
const SIGNER_ADMIN_ROLE = roleHash("SIGNER_ADMIN_ROLE")

export function shouldBehaveLikeAffiliateHub() {
	describe("AffiliateHub", function () {
		let context: RunContext

		const buildRegistration = (overrides: Partial<AffiliateRegistrationInput> = {}): AffiliateRegistrationInput => {
			const defaultStakeholders = [
				{ receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.4") },
				{ receiver: context.signers.feeCollector2.address, share: ethers.parseEther("0.3") },
			]

			return {
				name: overrides.name ?? "TradingPro",
				brandColor: overrides.brandColor ?? "#123123",
				admin: overrides.admin ?? context.signers.user.address,
				stakeholders: overrides.stakeholders ? overrides.stakeholders.map(s => ({ ...s })) : defaultStakeholders.map(s => ({ ...s })),
				symmioShare: overrides.symmioShare ?? ethers.parseEther("0.3"),
				metadata: overrides.metadata ?? "0x",
				legacyMultiAccounts: overrides.legacyMultiAccounts ? [...overrides.legacyMultiAccounts] : [],
				symmioCores: overrides.symmioCores ? [...overrides.symmioCores] : [context.diamond],
			}
		}

		const requestAffiliate = async (registrationOverrides: Partial<AffiliateRegistrationInput> = {}) => {
			const registration = buildRegistration(registrationOverrides)
			const signer = context.signers.user
			const predicted = await context.alAffiliateFacet.connect(signer).requestToRegisterAffiliate.staticCall(registration)
			await expect(context.alAffiliateFacet.connect(signer).requestToRegisterAffiliate(registration))
				.to.emit(context.alAffiliateFacet, "AffiliateRegistered")
				.withArgs(predicted, registration.name)
			return { affiliate: predicted, registration }
		}

		const approveAffiliate = async (affiliate: string) => {
			await expect(context.alAffiliateFacet.connect(context.signers.admin).approveAffiliate(affiliate)).to.emit(
				context.alAffiliateFacet,
				"AffiliateApproved",
			)
		}

		const activateAffiliate = async (registrationOverrides: Partial<AffiliateRegistrationInput> = {}) => {
			const { affiliate, registration } = await requestAffiliate(registrationOverrides)
			await approveAffiliate(affiliate)
			return { affiliate, registration }
		}

		const deployMockCore = async () => {
			const mockFactory = await ethers.getContractFactory("MockAffiliateHub")
			const mock = await mockFactory.deploy()
			await mock.setCollateral(await context.collateral.getAddress())
			await context.alControlFacet.connect(context.signers.admin).setWhitelistedSymmioCore(await mock.getAddress(), true)
			return mock
		}

		const depositFeesForAffiliate = async (affiliate: string, amount: bigint, coreAddress: string) => {
			const feeDistributor = await context.alViewFacet.getAffiliateFeeDistributor(affiliate)
			await context.collateral.connect(context.signers.admin).mint(context.signers.admin.address, amount)
			await context.collateral.connect(context.signers.admin).approve(coreAddress, amount)
			const mock = await ethers.getContractAt("MockAffiliateHub", coreAddress)
			await mock.connect(context.signers.admin).depositFor(feeDistributor, amount)
		}

		const pauseAffiliateHub = async () => {
			const pauserRole = roleHash("PAUSER_ROLE")
			await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, pauserRole)
			await context.alControlFacet.connect(context.signers.admin).pause()
		}

		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			await context.controlFacet.connect(context.signers.admin).grantRole(context.accountLayerDiamond, SIGNER_ADMIN_ROLE)
		})

		describe("requestToRegisterAffiliate", function () {
			it("rejects invalid inputs", async function () {
				// zero admin
				await expect(
					context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ admin: ethers.ZeroAddress })),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "ZeroAddress")

				// names non-empty and under 100 chars
				await expect(
					context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ name: "" })),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "InvalidNameLength")
				await expect(
					context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ name: "a".repeat(101) })),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "InvalidNameLength")

				// symmio share cannot exceed 100%
				await expect(
					context.alAffiliateFacet
						.connect(context.signers.user)
						.requestToRegisterAffiliate(buildRegistration({ symmioShare: ethers.parseEther("1.1") })),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "InvalidShare")

				// stakeholder receivers must be non-zero
				await expect(
					context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(
						buildRegistration({
							stakeholders: [
								{ receiver: ethers.ZeroAddress, share: ethers.parseEther("0.7") },
								{ receiver: context.signers.feeCollector2.address, share: ethers.parseEther("0.3") },
							],
							symmioShare: ethers.parseEther("0"),
						}),
					),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "ZeroAddress")

				// totals must add up to 100%
				await expect(
					context.alAffiliateFacet
						.connect(context.signers.user)
						.requestToRegisterAffiliate(buildRegistration({ symmioShare: ethers.parseEther("0.2") })),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "SharesMustSumTo100")

				// core must be one of the approved ones
				await expect(
					context.alAffiliateFacet
						.connect(context.signers.user)
						.requestToRegisterAffiliate(buildRegistration({ symmioCores: [context.signers.others[0].address] })),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "NoWhitelistedSymmioCore")
			})

			it("enforces unique registrations per affiliate id for the same sender", async function () {
				// register once
				const { registration } = await requestAffiliate()
				// repeated call by same user reverts
				await expect(context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"AlreadyRegistered",
				)
			})

			it("allows same affiliate name from different users", async function () {
				// different users can reuse the same payload
				const registration = buildRegistration()
				// user 1
				await expect(context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(
					context.alAffiliateFacet,
					"AffiliateRegistered",
				)
				// user 2
				await expect(context.alAffiliateFacet.connect(context.signers.user2).requestToRegisterAffiliate(registration)).to.emit(
					context.alAffiliateFacet,
					"AffiliateRegistered",
				)
			})

			it("stores validated registration data", async function () {
				const { affiliate, registration } = await requestAffiliate()
				expect(await context.alViewFacet.getAffiliateState(affiliate)).to.equal(AffiliateState.PENDING)
				expect(await context.alViewFacet.getAffiliateAdmin(affiliate)).to.equal(registration.admin)
				expect(await context.alViewFacet.getAffiliateSymmioCores(affiliate)).to.deep.equal([context.diamond])
			})

			describe("cancelRegistration", function () {
				let affiliate: string
				let registration: AffiliateRegistrationInput

				beforeEach(async function () {
					const pending = await requestAffiliate()
					affiliate = pending.affiliate
					registration = pending.registration
				})

				it("allows only the affiliate admin to cancel", async function () {
					// cancel by non admin
					await expect(context.alAffiliateFacet.connect(context.signers.others[0]).cancelRegistration(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"NotAffiliateAdmin",
					)
					// cancel by admin
					await expect(context.alAffiliateFacet.connect(context.signers.user).cancelRegistration(affiliate))
						.to.emit(context.alAffiliateFacet, "RegistrationCancelled")
						.withArgs(affiliate)
					await expect(context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(
						context.alAffiliateFacet,
						"AffiliateRegistered",
					)
				})

				it("reverts once the affiliate is approved", async function () {
					await approveAffiliate(affiliate)
					await expect(context.alAffiliateFacet.connect(context.signers.user).cancelRegistration(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"NotPending",
					)
				})

				it("respects the global pause guard", async function () {
					await pauseAffiliateHub()
					await expect(context.alAffiliateFacet.connect(context.signers.user).cancelRegistration(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"EnforcedPause",
					)
				})
			})

			describe("rejectRegistration", function () {
				let affiliate: string
				let registration: AffiliateRegistrationInput

				beforeEach(async function () {
					const pending = await requestAffiliate()
					affiliate = pending.affiliate
					registration = pending.registration
				})

				it("lets the protocol admin reject a pending registration", async function () {
					const adminRole = roleHash("APPROVER_ROLE")
					expect(await context.alViewFacet.hasRole(context.signers.admin.address, adminRole)).to.equal(true)
					await expect(context.alAffiliateFacet.connect(context.signers.admin).rejectRegistration(affiliate))
						.to.emit(context.alAffiliateFacet, "RegistrationRejected")
						.withArgs(affiliate, context.signers.admin.address)
					await expect(context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(
						context.alAffiliateFacet,
						"AffiliateRegistered",
					)
				})

				it("reverts rejects from non-admin or non-pending entries", async function () {
					await expect(context.alAffiliateFacet.connect(context.signers.user).rejectRegistration(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"MustHaveRole",
					)
					await context.alAffiliateFacet.connect(context.signers.admin).rejectRegistration(affiliate)
					await expect(context.alAffiliateFacet.connect(context.signers.admin).rejectRegistration(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"NotPending",
					)
				})
			})

			describe("approveAffiliate", function () {
				let affiliate: string

				beforeEach(async function () {
					affiliate = (await requestAffiliate()).affiliate
				})

				it("requires approver role and pending state", async function () {
					// approve without role
					await expect(context.alAffiliateFacet.connect(context.signers.user).approveAffiliate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"MustHaveRole",
					)

					await approveAffiliate(affiliate)
					// approve on not pending state
					await expect(context.alAffiliateFacet.connect(context.signers.admin).approveAffiliate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"NotPending",
					)
				})

				// happy path
				it("deploys the account manager, fee distributor, and assigns permissions", async function () {
					const nonceBefore = await context.alViewFacet.globalNonce()
					await approveAffiliate(affiliate)

					expect(await context.alViewFacet.getAffiliateState(affiliate)).to.equal(AffiliateState.ACTIVE)
					const feeDistributor = await context.alViewFacet.getAffiliateFeeDistributor(affiliate)
					expect(feeDistributor).to.not.equal(ethers.ZeroAddress)
					expect(await context.viewFacet.getFeeCollector(affiliate)).to.equal(feeDistributor)
					expect(await context.alViewFacet.globalNonce()).to.equal(nonceBefore + 1n)

					// AccountManager mapping stays in AffiliateHub
					const manager = await context.alViewFacet.getAffiliateAccountManager(affiliate)
					expect(manager).to.not.equal(ethers.ZeroAddress)
					expect(manager).to.equal(affiliate)
					// SIGNER_SETTER_ROLE is granted during deployment
					expect(await context.alViewFacet.hasRole(manager, roleHash("SIGNER_SETTER_ROLE"))).to.equal(true)
				})

				it("cannot be called while the hub is paused", async function () {
					await pauseAffiliateHub()
					await expect(context.alAffiliateFacet.connect(context.signers.admin).approveAffiliate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"EnforcedPause",
					)
				})
			})
		})

		describe("Admin management", function () {
			let affiliate: string

			beforeEach(async function () {
				affiliate = (await activateAffiliate()).affiliate
			})

			describe("proposeAdminTransfer", function () {
				it("allows only the current admin to propose transfer", async function () {
					// admin can propose a new admin
					await expect(context.alAffiliateFacet.connect(context.signers.user).proposeAdminTransfer(affiliate, context.signers.user2.address)).to.emit(
						context.alAffiliateFacet,
						"AdminTransferProposed",
					)

					// non admin cant propose a new admin
					await expect(
						context.alAffiliateFacet.connect(context.signers.user2).proposeAdminTransfer(affiliate, context.signers.user.address),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "NotAffiliateAdmin")
				})

				it("reverts when the contract is paused", async function () {
					await pauseAffiliateHub()
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).proposeAdminTransfer(affiliate, context.signers.user2.address),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "EnforcedPause")
				})

				it("requires the affiliate to stay active", async function () {
					await context.alAffiliateFacet.connect(context.signers.user).pauseAffiliate(affiliate)
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).proposeAdminTransfer(affiliate, context.signers.user2.address),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "AffiliateNotActive")
				})
			})

			describe("acceptAdminTransfer", function () {
				beforeEach(async function () {
					// have admin nominate a new owner
					await context.alAffiliateFacet.connect(context.signers.user).proposeAdminTransfer(affiliate, context.signers.user2.address)
				})

				it("only allows the pending admin to accept", async function () {
					// pending admin can accept
					await expect(context.alAffiliateFacet.connect(context.signers.user2).acceptAdminTransfer(affiliate)).to.emit(
						context.alAffiliateFacet,
						"AdminTransferCompleted",
					)
					expect(await context.alViewFacet.getAffiliateAdmin(affiliate)).to.equal(context.signers.user2.address)
				})

				it("reverts for non-pending admins", async function () {
					// non pending cant accept
					await expect(context.alAffiliateFacet.connect(context.signers.others[0]).acceptAdminTransfer(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"Unauthorized",
					)
				})

				it("blocks acceptance while the contract is paused", async function () {
					await pauseAffiliateHub()
					await expect(context.alAffiliateFacet.connect(context.signers.user2).acceptAdminTransfer(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"EnforcedPause",
					)
				})
			})

			describe("cancelAdminTransfer", function () {
				beforeEach(async function () {
					// set up a pending transfer that we can cancel
					await context.alAffiliateFacet.connect(context.signers.user).proposeAdminTransfer(affiliate, context.signers.user2.address)
				})

				it("clears pending admin proposals", async function () {
					// admin cancels before new admin accepts
					await expect(context.alAffiliateFacet.connect(context.signers.user).cancelAdminTransfer(affiliate)).to.emit(
						context.alAffiliateFacet,
						"AdminTransferCancelled",
					)
					// pending admin no longer can accept
					await expect(context.alAffiliateFacet.connect(context.signers.user2).acceptAdminTransfer(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"Unauthorized",
					)
				})

				it("respects the global pause state", async function () {
					await pauseAffiliateHub()
					await expect(context.alAffiliateFacet.connect(context.signers.user).cancelAdminTransfer(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"EnforcedPause",
					)
				})
			})

			describe("updateAffiliateDetails", function () {
				it("requires the active affiliate admin", async function () {
					// new colors and name
					const newDetails = { name: "newnewname", brandColor: "#111111" }
					// non admin still blocked
					await expect(
						context.alAffiliateFacet.connect(context.signers.user2).updateAffiliateDetails(affiliate, newDetails.name, newDetails.brandColor),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "NotAffiliateAdmin")
					// admin can update
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).updateAffiliateDetails(affiliate, newDetails.name, newDetails.brandColor),
					).to.emit(context.alAffiliateFacet, "AffiliateUpdated")
				})

				it("reverts when affiliate is paused", async function () {
					await context.alAffiliateFacet.connect(context.signers.user).pauseAffiliate(affiliate)
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).updateAffiliateDetails(affiliate, "x", "#fff"),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "AffiliateNotActive")
				})

				it("reverts when the hub is paused", async function () {
					await pauseAffiliateHub()
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).updateAffiliateDetails(affiliate, "x", "#fff"),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "EnforcedPause")
				})
			})
		})

		describe("Pausing", function () {
			let affiliate: string

			beforeEach(async function () {
				// keep a fresh active affiliate handy
				affiliate = (await activateAffiliate()).affiliate
			})

			describe("pauseAffiliate", function () {
				it("allows authorized callers to pause", async function () {
					const pauserRole = roleHash("PAUSER_ROLE")
					await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.liquidator.address, pauserRole)

					// random accounts cant pause
					await expect(context.alAffiliateFacet.connect(context.signers.others[0]).pauseAffiliate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"Unauthorized",
					)
					// role holder can pause fine
					await expect(context.alAffiliateFacet.connect(context.signers.liquidator).pauseAffiliate(affiliate))
						.to.emit(context.alAffiliateFacet, "AffiliatePaused")
						.withArgs(affiliate)
					expect(await context.alViewFacet.getAffiliateState(affiliate)).to.equal(AffiliateState.PAUSED)
				})
			})

			describe("unpauseAffiliate", function () {
				beforeEach(async function () {
					const pauserRole = roleHash("PAUSER_ROLE")
					const unpauserRole = roleHash("UNPAUSER_ROLE")
					await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.liquidator.address, pauserRole)
					await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.hedger.address, unpauserRole)
					// start from paused state
					await context.alAffiliateFacet.connect(context.signers.liquidator).pauseAffiliate(affiliate)
				})

				it("requires the unpauser role", async function () {
					// missing role means revert
					await expect(context.alAffiliateFacet.connect(context.signers.others[0]).unpauseAffiliate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"MustHaveRole",
					)
					// unpauser role restores active state
					await expect(context.alAffiliateFacet.connect(context.signers.hedger).unpauseAffiliate(affiliate))
						.to.emit(context.alAffiliateFacet, "AffiliateUnpaused")
						.withArgs(affiliate)
					expect(await context.alViewFacet.getAffiliateState(affiliate)).to.equal(AffiliateState.ACTIVE)
				})
			})

			describe("contract pause state", function () {
				beforeEach(async function () {
					const pauserRole = roleHash("PAUSER_ROLE")
					const unpauserRole = roleHash("UNPAUSER_ROLE")
					await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, pauserRole)
					await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, unpauserRole)
				})

				it("blocks actions when paused", async function () {
					// pause whole contract
					await context.alControlFacet.connect(context.signers.admin).pause()
					// registrations revert while paused
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ name: "Paused" })),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "EnforcedPause")
					// unpause and allow registrations again
					await context.alControlFacet.connect(context.signers.admin).unpause()
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ name: "LiveAgain" })),
					).to.emit(context.alAffiliateFacet, "AffiliateRegistered")
				})

				it("enforces role checks on pause toggles", async function () {
					await expect(context.alControlFacet.connect(context.signers.user).pause()).to.be.revertedWithCustomError(
						context.alControlFacet,
						"MustHaveRole",
					)
					await expect(context.alControlFacet.connect(context.signers.user).unpause()).to.be.revertedWithCustomError(
						context.alControlFacet,
						"MustHaveRole",
					)
				})
			})
		})

		describe("Fee management", function () {
			let affiliate: string
			let coreAddress: string

			beforeEach(async function () {
				// deploy a mock core and link affiliate to it
				const mockCore = await deployMockCore()
				coreAddress = await mockCore.getAddress()
				affiliate = (await activateAffiliate({ symmioCores: [coreAddress] })).affiliate
			})

			describe("requestFeeUpdate", function () {
				it("records pending updates from the affiliate admin", async function () {
					// admin picks a new distribution
					const newStakeholders = [{ receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.8") }]
					// request logs the update
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).requestFeeUpdate(affiliate, newStakeholders, ethers.parseEther("0.2")),
					).to.emit(context.alAffiliateFacet, "StakeholdersUpdateRequested")
				})

				it("rejects calls from non-admin accounts", async function () {
					const newStakeholders = [{ receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.8") }]
					await expect(
						context.alAffiliateFacet.connect(context.signers.user2).requestFeeUpdate(affiliate, newStakeholders, ethers.parseEther("0.2")),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "NotAffiliateAdmin")
				})

				it("requires an active affiliate and unpaused hub", async function () {
					const newStakeholders = [{ receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.8") }]
					await context.alAffiliateFacet.connect(context.signers.user).pauseAffiliate(affiliate)
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).requestFeeUpdate(affiliate, newStakeholders, ethers.parseEther("0.2")),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "AffiliateNotActive")

					// resume affiliate for next assertion
					await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, roleHash("UNPAUSER_ROLE"))
					await context.alAffiliateFacet.connect(context.signers.admin).unpauseAffiliate(affiliate)
					await pauseAffiliateHub()
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).requestFeeUpdate(affiliate, newStakeholders, ethers.parseEther("0.2")),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "EnforcedPause")
				})

				it("validates stakeholder definitions and symmio share", async function () {
					// zero receiver
					await expect(
						context.alAffiliateFacet
							.connect(context.signers.user)
							.requestFeeUpdate(affiliate, [{ receiver: ethers.ZeroAddress, share: ethers.parseEther("0.7") }], ethers.parseEther("0.3")),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "ZeroAddress")

					// totals must sum to one
					await expect(
						context.alAffiliateFacet
							.connect(context.signers.user)
							.requestFeeUpdate(affiliate, [{ receiver: context.signers.user.address, share: ethers.parseEther("0.9") }], ethers.parseEther("0.2")),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "SharesMustSumTo100")
				})
			})

			describe("cancelFeeUpdate", function () {
				beforeEach(async function () {
					// queue an update to cancel
					const updated = [{ receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.7") }]
					await context.alAffiliateFacet.connect(context.signers.user).requestFeeUpdate(affiliate, updated, ethers.parseEther("0.3"))
				})

				it("allows the admin to cancel pending updates", async function () {
					await expect(context.alAffiliateFacet.connect(context.signers.user).cancelFeeUpdate(affiliate)).to.emit(
						context.alAffiliateFacet,
						"FeeUpdateCancelled",
					)
				})

				it("blocks non-admin users", async function () {
					await expect(context.alAffiliateFacet.connect(context.signers.user2).cancelFeeUpdate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"NotAffiliateAdmin",
					)
				})

				it("reverts when the hub is paused", async function () {
					await pauseAffiliateHub()
					await expect(context.alAffiliateFacet.connect(context.signers.user).cancelFeeUpdate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"EnforcedPause",
					)
				})
			})

			describe("approveFeeUpdate", function () {
				beforeEach(async function () {
					// queue an update so approver can finalize it
					const newStakeholders = [{ receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.8") }]
					await context.alAffiliateFacet.connect(context.signers.user).requestFeeUpdate(affiliate, newStakeholders, ethers.parseEther("0.2"))
				})

				it("applies the pending update and clears it", async function () {
					await expect(context.alAffiliateFacet.connect(context.signers.admin).approveFeeUpdate(affiliate)).to.emit(
						context.alAffiliateFacet,
						"StakeholdersUpdated",
					)
				})

				it("requires the approver role", async function () {
					await expect(context.alAffiliateFacet.connect(context.signers.user).approveFeeUpdate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"MustHaveRole",
					)
				})

				it("reverts while the contract is paused", async function () {
					await pauseAffiliateHub()
					await expect(context.alAffiliateFacet.connect(context.signers.admin).approveFeeUpdate(affiliate)).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"EnforcedPause",
					)
				})
			})

			describe("claimFees", function () {
				const feeAmount = ethers.parseEther("100")

				beforeEach(async function () {
					// deposit fees to the mock core
					await depositFeesForAffiliate(affiliate, feeAmount, coreAddress)
				})

				it("distributes fees to stakeholders", async function () {
					// grab balances before claiming
					const stakeholder = context.signers.feeCollector
					const before = await context.collateral.balanceOf(stakeholder.address)
					// stakeholder claims
					await expect(context.alAffiliateFacet.connect(stakeholder).claimFees(affiliate, coreAddress, feeAmount)).to.emit(
						context.alAffiliateFacet,
						"FeesClaimed",
					)
					// confirm increase matches share
					const after = await context.collateral.balanceOf(stakeholder.address)
					expect(after - before).to.equal((feeAmount * ethers.parseEther("0.4")) / ethers.parseEther("1"))
					expect(await context.collateral.balanceOf(context.accountLayerDiamond)).to.equal(0)
				})

				it("blocks unauthorized callers", async function () {
					// random caller cannot touch fees
					await expect(
						context.alAffiliateFacet.connect(context.signers.others[0]).claimFees(affiliate, coreAddress, 1n),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "Unauthorized")
				})

				it("reverts when the contract is paused", async function () {
					await pauseAffiliateHub()
					await expect(
						context.alAffiliateFacet.connect(context.signers.feeCollector).claimFees(affiliate, coreAddress, feeAmount),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "EnforcedPause")
				})

				it("transfers the protocol share to the Symmio fee receiver", async function () {
					const receiver = context.signers.symmioFeeReceiver
					const before = await context.collateral.balanceOf(receiver.address)

					await context.alAffiliateFacet.connect(context.signers.feeCollector).claimFees(affiliate, coreAddress, feeAmount)

					const after = await context.collateral.balanceOf(receiver.address)
					expect(after - before).to.equal((feeAmount * ethers.parseEther("0.3")) / ethers.parseEther("1"))
					expect(await context.collateral.balanceOf(context.accountLayerDiamond)).to.equal(0)
				})

				it("allows accounts with the distributor role to claim", async function () {
					const distributorRole = roleHash("DISTRIBUTOR_ROLE")
					const distributor = context.signers.others[1]
					await context.alControlFacet.connect(context.signers.admin).grantRole(distributor.address, distributorRole)

					await expect(context.alAffiliateFacet.connect(distributor).claimFees(affiliate, coreAddress, feeAmount)).to.emit(
						context.alAffiliateFacet,
						"FeesClaimed",
					)
					expect(await context.collateral.balanceOf(context.accountLayerDiamond)).to.equal(0)
				})
			})

			describe("dryClaimAllFees", function () {
				it("previews the distribution without transferring funds", async function () {
					// deposit so theres something to preview
					const totalFees = ethers.parseEther("50")
					await depositFeesForAffiliate(affiliate, totalFees, coreAddress)
					// dry run for a preview
					const [holders, shares] = await context.alViewFacet.dryClaimAllFees(affiliate, coreAddress)
					// balances stay the same but preview is correct
					expect(holders).to.include(context.signers.feeCollector.address)
					expect(shares[0]).to.equal((totalFees * ethers.parseEther("0.4")) / ethers.parseEther("1"))
				})
			})

			describe("claimAllFees", function () {
				const feeAmount = ethers.parseEther("75")

				beforeEach(async function () {
					await depositFeesForAffiliate(affiliate, feeAmount, coreAddress)
				})

				it("withdraws the full balance and routes shares accordingly", async function () {
					const stakeholder = context.signers.feeCollector
					const stakeholderBefore = await context.collateral.balanceOf(stakeholder.address)
					const symmioBefore = await context.collateral.balanceOf(context.signers.symmioFeeReceiver.address)

					await expect(context.alAffiliateFacet.connect(stakeholder).claimAllFees(affiliate, coreAddress)).to.emit(
						context.alAffiliateFacet,
						"FeesClaimed",
					)

					const stakeholderAfter = await context.collateral.balanceOf(stakeholder.address)
					const symmioAfter = await context.collateral.balanceOf(context.signers.symmioFeeReceiver.address)

					expect(stakeholderAfter - stakeholderBefore).to.equal((feeAmount * ethers.parseEther("0.4")) / ethers.parseEther("1"))
					expect(symmioAfter - symmioBefore).to.equal((feeAmount * ethers.parseEther("0.3")) / ethers.parseEther("1"))
				})
			})
		})

		describe("Hooks", function () {
			let affiliate: string

			beforeEach(async function () {
				// ensure we have an active affiliate
				affiliate = (await activateAffiliate()).affiliate
			})

			describe("setHook", function () {
				it("allows the affiliate admin to register hooks", async function () {
					// deploy a simple hook target
					const mockHook = await (await ethers.getContractFactory("MockHook")).deploy()
					// admin wires the hook up
					await expect(context.alAffiliateFacet.connect(context.signers.user).setHook(affiliate, "0x12345678", await mockHook.getAddress())).to.emit(
						context.alAffiliateFacet,
						"HookSet",
					)
				})

				it("blocks non-admin callers and inactive affiliates", async function () {
					const mockHook = await (await ethers.getContractFactory("MockHook")).deploy()
					await expect(
						context.alAffiliateFacet.connect(context.signers.user2).setHook(affiliate, "0x12345678", await mockHook.getAddress()),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "NotAffiliateAdmin")

					await context.alAffiliateFacet.connect(context.signers.user).pauseAffiliate(affiliate)
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).setHook(affiliate, "0x12345678", await mockHook.getAddress()),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "AffiliateNotActive")
				})

				it("cannot be called while the contract is paused", async function () {
					const mockHook = await (await ethers.getContractFactory("MockHook")).deploy()
					await pauseAffiliateHub()
					await expect(
						context.alAffiliateFacet.connect(context.signers.user).setHook(affiliate, "0x12345678", await mockHook.getAddress()),
					).to.be.revertedWithCustomError(context.alAffiliateFacet, "EnforcedPause")
				})
			})

			describe("removeHook", function () {
				beforeEach(async function () {
					// add a hook before each removal test
					const mockHook = await (await ethers.getContractFactory("MockHook")).deploy()
					await context.alAffiliateFacet.connect(context.signers.user).setHook(affiliate, "0x12345678", await mockHook.getAddress())
				})

				it("allows the affiliate admin to remove hooks", async function () {
					await expect(context.alAffiliateFacet.connect(context.signers.user).removeHook(affiliate, "0x12345678")).to.emit(
						context.alAffiliateFacet,
						"HookRemoved",
					)
				})

				it("requires admin privileges and unpaused hub", async function () {
					await expect(context.alAffiliateFacet.connect(context.signers.user2).removeHook(affiliate, "0x12345678")).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"NotAffiliateAdmin",
					)
					await pauseAffiliateHub()
					await expect(context.alAffiliateFacet.connect(context.signers.user).removeHook(affiliate, "0x12345678")).to.be.revertedWithCustomError(
						context.alAffiliateFacet,
						"EnforcedPause",
					)
				})
			})
		})

		describe("Operators", function () {
			let affiliate: string

			beforeEach(async function () {
				affiliate = (await activateAffiliate()).affiliate
				const selector = context.controlFacet.interface.getFunction("setAffiliateFee").selector
				await context.alControlFacet.connect(context.signers.admin).setCallAllowedSelectors(affiliate, [selector], true)
			})

			it("lets affiliate admin manage operators per selector", async function () {
				const operator = context.signers.others[0]
				const selector = context.controlFacet.interface.getFunction("setAffiliateFee").selector

				await expect(context.alAffiliateFacet.connect(context.signers.user).setOperator(affiliate, selector, operator.address, true))
					.to.emit(context.alAffiliateFacet, "OperatorSet")
					.withArgs(affiliate, selector, operator.address, true)

				expect(await context.alViewFacet.isOperator(affiliate, selector, operator.address)).to.equal(true)

				await expect(context.alAffiliateFacet.connect(context.signers.user).setOperator(affiliate, selector, operator.address, false))
					.to.emit(context.alAffiliateFacet, "OperatorSet")
					.withArgs(affiliate, selector, operator.address, false)

				expect(await context.alViewFacet.isOperator(affiliate, selector, operator.address)).to.equal(false)
			})

			it("blocks non-admin operator management and inactive affiliates", async function () {
				const operator = context.signers.others[0]
				const selector = context.controlFacet.interface.getFunction("setAffiliateFee").selector

				await expect(
					context.alAffiliateFacet.connect(context.signers.user2).setOperator(affiliate, selector, operator.address, true),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "NotAffiliateAdmin")

				await context.alAffiliateFacet.connect(context.signers.user).pauseAffiliate(affiliate)
				await expect(
					context.alAffiliateFacet.connect(context.signers.user).setOperator(affiliate, selector, operator.address, true),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "AffiliateNotActive")
			})

			it("allows an approved operator to call core methods as the affiliate", async function () {
				const operator = context.signers.others[0]
				const selector = context.controlFacet.interface.getFunction("setAffiliateFee").selector
				await context.alAffiliateFacet.connect(context.signers.user).setOperator(affiliate, selector, operator.address, true)

				const openFee = ethers.parseEther("0.01")
				const closeFee = ethers.parseEther("0.02")
				const callData = context.controlFacet.interface.encodeFunctionData("setAffiliateFee", [affiliate, [0], [openFee], [closeFee]])

				await context.alAffiliateFacet.connect(operator).callAsAffiliate(affiliate, context.diamond, callData)

				const fee = await context.viewFacet.getAffiliateFee(affiliate, 0)
				expect(fee.openFee).to.equal(openFee)
				expect(fee.closeFee).to.equal(closeFee)
				expect(fee.isSet).to.equal(true)
			})

			it("blocks non-whitelisted admin selectors via callAsAffiliate with SelectorNotAllowed", async function () {
				const attacker = affiliate
				const victim = (await activateAffiliate({ name: "VictimAffiliate", admin: context.signers.user2.address })).affiliate
				const attackerCollector = context.signers.others[0].address

				expect(await context.viewFacet.isAffiliate(victim)).to.equal(true)
				const beforeCollector = await context.viewFacet.getFeeCollector(victim)

				const selector = context.controlFacet.interface.getFunction("setFeeCollector").selector
				const callData = context.controlFacet.interface.encodeFunctionData("setFeeCollector", [victim, attackerCollector])

				await expect(context.alAffiliateFacet.connect(context.signers.user).callAsAffiliate(attacker, context.diamond, callData))
					.to.be.revertedWithCustomError(context.alAffiliateFacet, "SelectorNotAllowed")
					.withArgs(selector)

				expect(await context.viewFacet.getFeeCollector(victim)).to.equal(beforeCollector)
			})

			it("blocks whitelisted admin selectors via Symmio core proxy protection", async function () {
				const attacker = affiliate
				const victim = (await activateAffiliate({ name: "VictimAffiliate2", admin: context.signers.user2.address })).affiliate
				const attackerCollector = context.signers.others[0].address

				expect(await context.viewFacet.isAffiliate(victim)).to.equal(true)
				const beforeCollector = await context.viewFacet.getFeeCollector(victim)

				// Even if admin accidentally whitelists an admin selector...
				const selector = context.controlFacet.interface.getFunction("setFeeCollector").selector
				await context.alControlFacet.connect(context.signers.admin).setCallAllowedSelectors(attacker, [selector], true)

				const callData = context.controlFacet.interface.encodeFunctionData("setFeeCollector", [victim, attackerCollector])

				// ...Symmio core's onlyRole modifier blocks it because signer is set (proxied call)
				await expect(context.alAffiliateFacet.connect(context.signers.user).callAsAffiliate(attacker, context.diamond, callData)).to.be.revertedWith(
					"Accessibility: Cannot call via proxy",
				)

				expect(await context.viewFacet.getFeeCollector(victim)).to.equal(beforeCollector)
			})

			it("rejects unauthorized calls and enforces ACTIVE affiliates", async function () {
				const operator = context.signers.others[0]
				const openFee = ethers.parseEther("0.01")
				const closeFee = ethers.parseEther("0.02")
				const callData = context.controlFacet.interface.encodeFunctionData("setAffiliateFee", [affiliate, [0], [openFee], [closeFee]])

				await expect(context.alAffiliateFacet.connect(operator).callAsAffiliate(affiliate, context.diamond, callData)).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"Unauthorized",
				)

				const selector = context.controlFacet.interface.getFunction("setAffiliateFee").selector
				await context.alAffiliateFacet.connect(context.signers.user).setOperator(affiliate, selector, operator.address, true)
				await context.alAffiliateFacet.connect(context.signers.user).pauseAffiliate(affiliate)

				await expect(context.alAffiliateFacet.connect(operator).callAsAffiliate(affiliate, context.diamond, callData)).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"AffiliateNotActive",
				)
			})

			it("rejects invalid call data", async function () {
				const operator = context.signers.others[0]
				const selector = context.controlFacet.interface.getFunction("setAffiliateFee").selector
				await context.alAffiliateFacet.connect(context.signers.user).setOperator(affiliate, selector, operator.address, true)

				await expect(context.alAffiliateFacet.connect(operator).callAsAffiliate(affiliate, context.diamond, "0x")).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"InvalidCallData",
				)
			})
		})

		describe("Express configuration", function () {
			let affiliate: string

			beforeEach(async function () {
				affiliate = (await activateAffiliate()).affiliate
			})

			it("lets affiliate admin set express rate", async function () {
				const rate = ethers.parseEther("0.25")
				await expect(context.alAffiliateFacet.connect(context.signers.user).setExpressRate(affiliate, rate))
					.to.emit(context.alAffiliateFacet, "ExpressRateSet")
					.withArgs(affiliate, rate)
			})

			it("rejects express rates above 100%", async function () {
				const rate = ethers.parseEther("1.1")
				await expect(context.alAffiliateFacet.connect(context.signers.user).setExpressRate(affiliate, rate)).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"InvalidShare",
				)
			})

			it("lets affiliate admin set virtual provider", async function () {
				const provider = context.signers.others[0].address
				await expect(context.alAffiliateFacet.connect(context.signers.user).setVirtualProvider(affiliate, provider))
					.to.emit(context.alAffiliateFacet, "VirtualProviderSet")
					.withArgs(affiliate, provider)
			})

			it("requires affiliate admin and active state", async function () {
				const rate = ethers.parseEther("0.1")
				const provider = context.signers.others[0].address

				await expect(context.alAffiliateFacet.connect(context.signers.user2).setExpressRate(affiliate, rate)).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"NotAffiliateAdmin",
				)
				await expect(context.alAffiliateFacet.connect(context.signers.user2).setVirtualProvider(affiliate, provider)).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"NotAffiliateAdmin",
				)

				await context.alAffiliateFacet.connect(context.signers.user).pauseAffiliate(affiliate)
				await expect(context.alAffiliateFacet.connect(context.signers.user).setExpressRate(affiliate, rate)).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"AffiliateNotActive",
				)
				await expect(context.alAffiliateFacet.connect(context.signers.user).setVirtualProvider(affiliate, provider)).to.be.revertedWithCustomError(
					context.alAffiliateFacet,
					"AffiliateNotActive",
				)
			})
		})

		describe("Configuration", function () {
			beforeEach(async function () {
				// give admin the setter role
				const setterRole = roleHash("SETTER_ROLE")
				await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, setterRole)
			})

			describe("setSymmioFeeReceiver", function () {
				it("updates the symmio fee receiver", async function () {
					// set a new receiver
					const newReceiver = context.signers.symmioFeeReceiver.address
					await expect(context.alControlFacet.connect(context.signers.admin).setSymmioFeeReceiver(newReceiver)).to.emit(
						context.alControlFacet,
						"SymmioFeeReceiverUpdated",
					)
					// ensure updated
					expect(await context.alViewFacet.symmioFeeReceiver()).to.equal(newReceiver)
				})

				it("requires the setter role", async function () {
					await expect(
						context.alControlFacet.connect(context.signers.user).setSymmioFeeReceiver(context.signers.symmioFeeReceiver.address),
					).to.be.revertedWithCustomError(context.alControlFacet, "MustHaveRole")
				})
			})

			describe("setWhitelistedSymmioCore", function () {
				it("toggles allowed core addresses", async function () {
					// whitelist a new core address
					const newCore = context.signers.others[0].address
					await expect(context.alControlFacet.connect(context.signers.admin).setWhitelistedSymmioCore(newCore, true)).to.emit(
						context.alControlFacet,
						"WhitelistedSymmioCoreSet",
					)
					expect(await context.alViewFacet.isWhitelistedSymmioCore(newCore)).to.equal(true)
				})

				it("requires setter role", async function () {
					await expect(
						context.alControlFacet.connect(context.signers.user).setWhitelistedSymmioCore(context.signers.others[0].address, true),
					).to.be.revertedWithCustomError(context.alControlFacet, "MustHaveRole")
				})
			})
		})
	})
}
