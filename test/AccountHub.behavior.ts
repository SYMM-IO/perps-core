import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers, upgrades } from "hardhat"
import { initializeFixture } from "./Initialize.fixture"

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

const ACCOUNT_MANAGER_CODE_HASH = ethers.keccak256(ethers.toUtf8Bytes("ACM_V1"))

function computeAffiliateAddress(hubAddress: string, implementation: string, name: string): string {
	const salt = ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [ACCOUNT_MANAGER_CODE_HASH, name]))
	const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [hubAddress])
	const initCodeHash = ethers.keccak256(ethers.concat([implementation, constructorArgs]))
	return ethers.getCreate2Address(hubAddress, salt, initCodeHash)
}

async function accountHubFixture() {
	const context = await initializeFixture()
	const accountManagerFactory = await ethers.getContractFactory("AccountManager")
	const accountManagerImplementation = accountManagerFactory.bytecode
	const affiliateHubFactory = await ethers.getContractFactory("AffiliateHub")

	const addresses = {
		admin: await context.signers.admin.getAddress(),
		affiliateAdmin: await context.signers.user.getAddress(),
		approver: await context.signers.user2.getAddress(),
		pauser: await context.signers.liquidator.getAddress(),
		unpauser: await context.signers.hedger.getAddress(),
		setter: await context.signers.admin.getAddress(),
		stakeholder1: await context.signers.feeCollector.getAddress(),
		stakeholder2: await context.signers.feeCollector2.getAddress(),
		unauthorized: await context.signers.others[0].getAddress(),
		other: await context.signers.others[1].getAddress(),
	}
	const hub = await upgrades.deployProxy(affiliateHubFactory, [addresses.admin, addresses.stakeholder1, accountManagerImplementation], {
		initializer: "initialize",
	})
	const hubAddress = await hub.getAddress()

	await hub.connect(context.signers.admin).grantRole(await hub.DEFAULT_ADMIN_ROLE(), addresses.approver)
	await hub.connect(context.signers.admin).grantRole(await hub.SETTER_ROLE(), addresses.admin)
	await hub.connect(context.signers.admin).grantRole(await hub.APPROVER_ROLE(), addresses.approver)
	await hub.connect(context.signers.admin).grantRole(await hub.PAUSER_ROLE(), addresses.pauser)
	await hub.connect(context.signers.admin).grantRole(await hub.UNPAUSER_ROLE(), addresses.unpauser)
	await hub.connect(context.signers.admin).setWhitelistedSymmioCore(context.diamond, true)

	const affiliateManagerRole = ethers.keccak256(ethers.toUtf8Bytes("AFFILIATE_MANAGER_ROLE"))
	await context.controlFacet.connect(context.signers.admin).grantRole(hubAddress, affiliateManagerRole)

	const defaultRegistration = (overrides: Partial<AffiliateRegistrationInput> = {}): AffiliateRegistrationInput => {
		const base: AffiliateRegistrationInput = {
			name: "TradingPro",
			brandColor: "#FF5733",
			admin: addresses.affiliateAdmin,
			stakeholders: [
				{ receiver: addresses.stakeholder1, share: ethers.parseEther("0.4") },
				{ receiver: addresses.stakeholder2, share: ethers.parseEther("0.3") },
			],
			symmioShare: ethers.parseEther("0.3"),
			metadata: ethers.toUtf8Bytes("metadata"),
			legacyMultiAccounts: [],
			symmioCores: [context.diamond],
		}

		return {
			...base,
			...overrides,
			stakeholders: overrides.stakeholders ? overrides.stakeholders.map((s) => ({ ...s })) : base.stakeholders.map((s) => ({ ...s })),
			legacyMultiAccounts: overrides.legacyMultiAccounts ? [...overrides.legacyMultiAccounts] : [...base.legacyMultiAccounts],
			symmioCores: overrides.symmioCores ? [...overrides.symmioCores] : [...base.symmioCores],
		}
	}

	return {
		context,
		hub,
		hubAddress,
		accountManagerImplementation,
		defaultRegistration,
		addresses,
	}
}

type AccountHubFixture = Awaited<ReturnType<typeof accountHubFixture>>

async function registerAffiliateOnSymmio(fixture: AccountHubFixture, affiliate: string) {
	const controlFacet = fixture.context.controlFacet.connect(fixture.context.signers.admin)
	try {
		await controlFacet.registerAffiliate(affiliate)
	} catch (error: any) {
		if (!error.message.includes("Address is already registered")) {
			throw error
		}
	}
}

export function shouldBehaveLikeAccountHub() {
	describe("AccountHub", function () {
		describe("AffiliateRegistration", function () {
			let fixture: AccountHubFixture

			beforeEach(async function () {
				fixture = await loadFixture(accountHubFixture)
			})

			// Validates registration metadata, shareholders, and pending state storage
			it("registers an affiliate with validated data", async function () {
				const { hub, defaultRegistration, context } = fixture
				const registration = defaultRegistration()
				const expectedAffiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

				// request register with valid data
				await expect(hub.connect(context.signers.user).requestToRegisterAffiliate(registration))
					.to.emit(hub, "AffiliateRegistered")
					.withArgs(expectedAffiliate, registration.name)

				// check stored state via public getters
				expect(await hub.getAffiliateState(expectedAffiliate)).to.equal(AffiliateState.PENDING)
				expect(await hub.getAffiliateAdmin(expectedAffiliate)).to.equal(registration.admin)
				expect(await hub.getAffiliateSymmioCores(expectedAffiliate)).to.deep.equal([context.diamond])
			})

			// Prevents double submissions with same name
			it("enforces unique registrations per affiliate id", async function () {
				const { hub, context, defaultRegistration } = fixture
				const registration = defaultRegistration()
				// first register
				await hub.connect(context.signers.user).requestToRegisterAffiliate(registration)
				// second register
				await expect(
					hub.connect(context.signers.user).requestToRegisterAffiliate(registration)
				).to.be.revertedWithCustomError(hub, "AlreadyRegistered")
			})

			// Ensures each validation branch (admin, name, shares, stakeholders, cores) reverts
			it("rejects invalid inputs", async function () {
				const { hub, context, defaultRegistration, addresses } = fixture

				// admin is zero address
				await expect(
					hub.connect(context.signers.user).requestToRegisterAffiliate(defaultRegistration({ admin: ethers.ZeroAddress })),
				).to.be.revertedWithCustomError(hub, "ZeroAddress")

				// name with bad length
				await expect(
					hub.connect(context.signers.user).requestToRegisterAffiliate(defaultRegistration({ name: "" })),
				).to.be.revertedWithCustomError(hub, "InvalidNameLength")
				await expect(
					hub.connect(context.signers.user).requestToRegisterAffiliate(defaultRegistration({ name: "a".repeat(101) })),
				).to.be.revertedWithCustomError(hub, "InvalidNameLength")

				// symmio share more than 100%
				await expect(
					hub.connect(context.signers.user).requestToRegisterAffiliate(defaultRegistration({ symmioShare: ethers.parseEther("1.1") })),
				).to.be.revertedWithCustomError(hub, "InvalidShare")

				// receiver is zero address
				await expect(
					hub.connect(context.signers.user).requestToRegisterAffiliate(
						defaultRegistration({
							stakeholders: [
								{ receiver: ethers.ZeroAddress, share: ethers.parseEther("0.7") },
								{ receiver: addresses.stakeholder2, share: ethers.parseEther("0.3") },
							],
							symmioShare: ethers.parseEther("0"),
						}),
					),
				).to.be.revertedWithCustomError(hub, "ZeroAddress")

				// total share not equal to 100%
				await expect(
					hub.connect(context.signers.user).requestToRegisterAffiliate(defaultRegistration({ symmioShare: ethers.parseEther("0.2") })),
				).to.be.revertedWithCustomError(hub, "SharesMustSumTo100")

				// invalid core should throw NoWhitelistedSymmioCore
				await expect(
					hub.connect(context.signers.user).requestToRegisterAffiliate(
						defaultRegistration({
							symmioCores: [addresses.unauthorized],
						}),
					),
				).to.be.revertedWithCustomError(hub, "NoWhitelistedSymmioCore")
			})

			// Confirms only the registered admin can cancel while pending and frees up the slot
			it("allows only the affiliate admin to cancel a pending registration", async function () {
				const { hub, context, defaultRegistration } = fixture
				const registration = defaultRegistration()
				const affiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

				// request register
				await expect(hub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(hub, "AffiliateRegistered")

				// not admin cancel
				await expect(hub.connect(context.signers.others[0]).cancelRegistration(affiliate)).to.be.revertedWithCustomError(hub, "NotAdmin")
				
				// admin cancel
				await expect(hub.connect(context.signers.user).cancelRegistration(affiliate)).to.emit(hub, "RegistrationCancelled").withArgs(affiliate)

				// second time request register with same name
				await expect(hub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(hub, "AffiliateRegistered")
			})

			// After approval, cancellation should be denied because state is no longer PENDING
			it("reverts cancellation once an affiliate is approved", async function () {
				const { hub, context, defaultRegistration } = fixture
				const registration = defaultRegistration()
				const affiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

				// request register
				await expect(hub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(hub, "AffiliateRegistered")
				await registerAffiliateOnSymmio(fixture, affiliate)

				await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.emit(hub, "AffiliateApproved")

				// cancel registration should revert
				await expect(hub.connect(context.signers.user).cancelRegistration(affiliate)).to.be.revertedWithCustomError(hub, "NotPending")
			})

			// Approval must be performed by an approver while the affiliate remains pending
			it("requires approver role and pending state", async function () {
				const { hub, context, defaultRegistration } = fixture
				const registration = defaultRegistration()
				const affiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

				// request register
				await expect(hub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(hub, "AffiliateRegistered")
				await registerAffiliateOnSymmio(fixture, affiliate)

				// approve affiliate without role
				const approverRole = await hub.APPROVER_ROLE()
				await expect(hub.connect(context.signers.user).approveAffiliate(affiliate)).to.be.revertedWith(
					`AccessControl: account ${(await context.signers.user.getAddress()).toLowerCase()} is missing role ${approverRole}`,
				)

				// successful approve affiliate
				await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.emit(hub, "AffiliateApproved")

				// approve affiliate for second time to revert
				await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.be.revertedWithCustomError(hub, "NotPending")
				// approve unknown affiliate for second time to revert
				await expect(hub.connect(context.signers.user2).approveAffiliate(context.signers.others[0].address)).to.be.revertedWithCustomError(
					hub,
					"NotPending",
				)
			})

			// Checks CREATE2 deployment, fee distributor setup, signer granting, and nonce bump
			it("deploys the account manager, fee distributor, and assigns permissions on approval", async function () {
				const { hub, context, defaultRegistration } = fixture
				const registration = defaultRegistration()
				const affiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

				// request register
				await expect(hub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(hub, "AffiliateRegistered")
				await registerAffiliateOnSymmio(fixture, affiliate)

				// approve
				const nonceBefore = await hub.globalNonce()
				await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.emit(hub, "AffiliateApproved")

				expect(await hub.getAffiliateState(affiliate)).to.equal(AffiliateState.ACTIVE)
				const feeDistributor = await hub.getAffiliateFeeDistributor(affiliate)
				expect(feeDistributor).to.not.equal(ethers.ZeroAddress)
				expect(await context.viewFacet.getFeeCollector(affiliate)).to.equal(feeDistributor)
				expect(await hub.globalNonce()).to.equal(nonceBefore + 1n)
				expect(await hub.hasRole(await hub.SIGNER_SETTER(), affiliate)).to.equal(true)
			})

			// Authorized roles must be able to pause/unpause
			it("supports pausing and unpausing affiliates with authorized callers", async function () {
				const { hub, context, defaultRegistration } = fixture
				const registration = defaultRegistration()
				const affiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

				// request register and approve affiliate
				await expect(hub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(hub, "AffiliateRegistered")
				await registerAffiliateOnSymmio(fixture, affiliate)
				await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.emit(hub, "AffiliateApproved")

				// pause without role
				await expect(hub.connect(context.signers.others[0]).pauseAffiliate(affiliate)).to.be.revertedWithCustomError(hub, "Unauthorized")

				// pause
				await expect(hub.connect(context.signers.liquidator).pauseAffiliate(affiliate)).to.emit(hub, "AffiliatePaused").withArgs(affiliate)
				expect(await hub.getAffiliateState(affiliate)).to.equal(AffiliateState.PAUSED)

				// unpause without role
				await expect(hub.connect(context.signers.others[0]).unpauseAffiliate(affiliate)).to.be.revertedWithCustomError(hub, "Unauthorized")
				
				// unpause
				await expect(hub.connect(context.signers.hedger).unpauseAffiliate(affiliate)).to.emit(hub, "AffiliateUnpaused").withArgs(affiliate)
				expect(await hub.getAffiliateState(affiliate)).to.equal(AffiliateState.ACTIVE)
			})

			describe("Scenarios", function () {
				/* 
				1. register
				2. approve through Symmio/approver
				3. verify manager/collector/roles
				*/ 
				it("runs the end-to-end happy path", async function () {
					const { hub, context, defaultRegistration } = fixture
					const registration = defaultRegistration({ name: "TradingPro", brandColor: "#FF5733" })
					const affiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

					await hub.connect(context.signers.user).requestToRegisterAffiliate(registration)
					await registerAffiliateOnSymmio(fixture, affiliate)
					expect(await hub.getAffiliateState(affiliate)).to.equal(AffiliateState.PENDING)

					await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.emit(hub, "AffiliateApproved")

					expect(await hub.getAffiliateState(affiliate)).to.equal(AffiliateState.ACTIVE)
					const feeDistributor = await hub.getAffiliateFeeDistributor(affiliate)
					expect(await context.viewFacet.getFeeCollector(affiliate)).to.equal(feeDistributor)

					expect(await hub.hasRole(await hub.SIGNER_SETTER(), affiliate)).to.equal(true)
				})

				/* 
				1. register
				2. cancel before approval
				3. re-register and approve
				*/
				it("allows cancellation while pending and reapplying later", async function () {
					const { hub, context, defaultRegistration } = fixture
					const registration = defaultRegistration({ name: "CancelMe" })
					const affiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

					await hub.connect(context.signers.user).requestToRegisterAffiliate(registration)
					await hub.connect(context.signers.user).cancelRegistration(affiliate)
					await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.be.revertedWithCustomError(hub, "NotPending")

					await hub.connect(context.signers.user).requestToRegisterAffiliate(registration)
					await registerAffiliateOnSymmio(fixture, affiliate)
					await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.emit(hub, "AffiliateApproved")
				})

				/* 
				1. approve affiliate
				2. pause via Symmio roles
				3. ensure admin updates are blocked
				4. unpause and allow edits
				*/
				it("lets Symmio pause and resume while blocking admin updates when paused", async function () {
					const { hub, context, defaultRegistration } = fixture
					const registration = defaultRegistration({ name: "PauserFlow" })
					const affiliate = computeAffiliateAddress(fixture.hubAddress, fixture.accountManagerImplementation, registration.name)

					await hub.connect(context.signers.user).requestToRegisterAffiliate(registration)
					await registerAffiliateOnSymmio(fixture, affiliate)
					await expect(hub.connect(context.signers.user2).approveAffiliate(affiliate)).to.emit(hub, "AffiliateApproved")

					await expect(hub.connect(context.signers.liquidator).pauseAffiliate(affiliate)).to.emit(hub, "AffiliatePaused").withArgs(affiliate)
					await expect(hub.connect(context.signers.user).updateAffiliateDetails(affiliate, "NewName", "#000000")).to.be.revertedWithCustomError(
						hub,
						"AffiliateNotActive",
					)

					await expect(hub.connect(context.signers.hedger).unpauseAffiliate(affiliate)).to.emit(hub, "AffiliateUnpaused").withArgs(affiliate)
					await expect(hub.connect(context.signers.user).updateAffiliateDetails(affiliate, "NewName", "#000000")).to.emit(hub, "AffiliateUpdated")
				})
			})
		})
	})
}
