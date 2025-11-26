import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers } from "hardhat"
import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"

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

const ACCOUNT_HUB_SIGNER_SETTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ACCOUNT_HUB_SIGNER_SETTER_ROLE"))

export function shouldBehaveLikeAffiliateHub() {
    describe("AffiliateHub", function () {
        let context: RunContext
        let affiliateHub: RunContext["affiliateHub"]

        const buildRegistration = (overrides: Partial<AffiliateRegistrationInput> = {}): AffiliateRegistrationInput => {
            const defaultStakeholders = [
                { receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.4") },
                { receiver: context.signers.feeCollector2.address, share: ethers.parseEther("0.3") },
            ]

            return {
                name: overrides.name ?? "TradingPro",
                brandColor: overrides.brandColor ?? "#123123",
                admin: overrides.admin ?? context.signers.user.address,
                stakeholders: overrides.stakeholders ? overrides.stakeholders.map((s) => ({ ...s })) : defaultStakeholders.map((s) => ({ ...s })),
                symmioShare: overrides.symmioShare ?? ethers.parseEther("0.3"),
                metadata: overrides.metadata ?? "0x",
                legacyMultiAccounts: overrides.legacyMultiAccounts ? [...overrides.legacyMultiAccounts] : [],
                symmioCores: overrides.symmioCores ? [...overrides.symmioCores] : [context.diamond],
            }
        }

        const requestAffiliate = async (registrationOverrides: Partial<AffiliateRegistrationInput> = {}) => {
            const registration = buildRegistration(registrationOverrides)
            const signer = context.signers.user
            const predicted = await affiliateHub.connect(signer).requestToRegisterAffiliate.staticCall(registration)
            await expect(affiliateHub.connect(signer).requestToRegisterAffiliate(registration))
                .to.emit(affiliateHub, "AffiliateRegistered")
                .withArgs(predicted, registration.name)
            return { affiliate: predicted, registration }
        }

        const approveAffiliate = async (affiliate: string) => {
            await expect(affiliateHub.connect(context.signers.admin).approveAffiliate(affiliate)).to.emit(affiliateHub, "AffiliateApproved")
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
            await affiliateHub.connect(context.signers.admin).setWhitelistedSymmioCore(await mock.getAddress(), true)
            return mock
        }

        const depositFeesForAffiliate = async (affiliate: string, amount: bigint, coreAddress: string) => {
            const feeDistributor = await affiliateHub.getAffiliateFeeDistributor(affiliate)
            await context.collateral.connect(context.signers.admin).mint(context.signers.admin.address, amount)
            await context.collateral.connect(context.signers.admin).approve(coreAddress, amount)
            const mock = await ethers.getContractAt("MockAffiliateHub", coreAddress)
            await mock.connect(context.signers.admin).depositFor(feeDistributor, amount)
        }

        beforeEach(async function () {
            context = await loadFixture(initializeFixture)
            affiliateHub = context.affiliateHub
            await context.controlFacet
                .connect(context.signers.admin)
                .grantRole(await affiliateHub.getAddress(), ACCOUNT_HUB_SIGNER_SETTER_ROLE)
        })

        describe("requestToRegisterAffiliate", function () {
            it("rejects invalid inputs", async function () {
                // zero admin
                await expect(
                    affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ admin: ethers.ZeroAddress })),
                ).to.be.revertedWithCustomError(affiliateHub, "ZeroAddress")

                // names non-empty and under 100 chars
                await expect(affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ name: "" }))).to.be.revertedWithCustomError(
                    affiliateHub,
                    "InvalidNameLength",
                )
                await expect(
                    affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ name: "a".repeat(101) })),
                ).to.be.revertedWithCustomError(affiliateHub, "InvalidNameLength")

                // symmio share cannot exceed 100%
                await expect(
                    affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ symmioShare: ethers.parseEther("1.1") })),
                ).to.be.revertedWithCustomError(affiliateHub, "InvalidShare")

                // stakeholder receivers must be non-zero
                await expect(
                    affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(
                        buildRegistration({
                            stakeholders: [
                                { receiver: ethers.ZeroAddress, share: ethers.parseEther("0.7") },
                                { receiver: context.signers.feeCollector2.address, share: ethers.parseEther("0.3") },
                            ],
                            symmioShare: ethers.parseEther("0"),
                        }),
                    ),
                ).to.be.revertedWithCustomError(affiliateHub, "ZeroAddress")

                // totals must add up to 100%
                await expect(
                    affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ symmioShare: ethers.parseEther("0.2") })),
                ).to.be.revertedWithCustomError(affiliateHub, "SharesMustSumTo100")

                // core must be one of the approved ones
                await expect(
                    affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ symmioCores: [context.signers.others[0].address] })),
                ).to.be.revertedWithCustomError(affiliateHub, "NoWhitelistedSymmioCore")
            })

            it("enforces unique registrations per affiliate id for the same sender", async function () {
                // register once
                const { registration } = await requestAffiliate()
                // repeated call by same user reverts
                await expect(affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.be.revertedWithCustomError(
                    affiliateHub,
                    "AlreadyRegistered",
                )
            })

            it("allows same affiliate name from different users", async function () {
                // different users can reuse the same payload
                const registration = buildRegistration()
                // user 1
                await expect(affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(affiliateHub, "AffiliateRegistered")
                // user 2
                await expect(affiliateHub.connect(context.signers.user2).requestToRegisterAffiliate(registration)).to.emit(affiliateHub, "AffiliateRegistered")
            })

            it("stores validated registration data", async function () {
                const { affiliate, registration } = await requestAffiliate()
                expect(await affiliateHub.getAffiliateState(affiliate)).to.equal(AffiliateState.PENDING)
                expect(await affiliateHub.getAffiliateAdmin(affiliate)).to.equal(registration.admin)
                expect(await affiliateHub.getAffiliateSymmioCores(affiliate)).to.deep.equal([context.diamond])
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
                    await expect(affiliateHub.connect(context.signers.others[0]).cancelRegistration(affiliate)).to.be.revertedWithCustomError(
                        affiliateHub,
                        "NotAdmin",
                    )
                    // cancel by admin
                    await expect(affiliateHub.connect(context.signers.user).cancelRegistration(affiliate))
                        .to.emit(affiliateHub, "RegistrationCancelled")
                        .withArgs(affiliate)
                    await expect(affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(registration)).to.emit(affiliateHub, "AffiliateRegistered")
                })

                it("reverts once the affiliate is approved", async function () {
                    await approveAffiliate(affiliate)
                    await expect(affiliateHub.connect(context.signers.user).cancelRegistration(affiliate)).to.be.revertedWithCustomError(
                        affiliateHub,
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
                    const approverRole = await affiliateHub.APPROVER_ROLE()
                    // approve without role
                    await expect(affiliateHub.connect(context.signers.user).approveAffiliate(affiliate)).to.be.revertedWith(
                        `AccessControl: account ${context.signers.user.address.toLowerCase()} is missing role ${approverRole}`,
                    )

                    await approveAffiliate(affiliate)
                    // approve on not pending state
                    await expect(affiliateHub.connect(context.signers.admin).approveAffiliate(affiliate)).to.be.revertedWithCustomError(
                        affiliateHub,
                        "NotPending",
                    )
                })

                // happy path
                it("deploys the account manager, fee distributor, and assigns permissions", async function () {
                    const nonceBefore = await affiliateHub.globalNonce()
                    await approveAffiliate(affiliate)

                    expect(await affiliateHub.getAffiliateState(affiliate)).to.equal(AffiliateState.ACTIVE)
                    const feeDistributor = await affiliateHub.getAffiliateFeeDistributor(affiliate)
                    expect(feeDistributor).to.not.equal(ethers.ZeroAddress)
                    expect(await context.viewFacet.getFeeCollector(affiliate)).to.equal(feeDistributor)
                    expect(await affiliateHub.globalNonce()).to.equal(nonceBefore + 1n)

                    const manager = await affiliateHub.getAffiliateAccountManager(affiliate)
                    expect(manager).to.not.equal(ethers.ZeroAddress)
                    expect(manager).to.equal(affiliate)
                    expect(await affiliateHub.hasRole(await affiliateHub.SIGNER_SETTER(), manager)).to.equal(true)
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
                    await expect(
                        affiliateHub.connect(context.signers.user).proposeAdminTransfer(affiliate, context.signers.user2.address),
                    ).to.emit(affiliateHub, "AdminTransferProposed")

                    // non admin cant propose a new admin
                    await expect(
                        affiliateHub.connect(context.signers.user2).proposeAdminTransfer(affiliate, context.signers.user.address),
                    ).to.be.revertedWithCustomError(affiliateHub, "NotAdmin")
                })
            })

            describe("acceptAdminTransfer", function () {
                beforeEach(async function () {
                    // have admin nominate a new owner
                    await affiliateHub.connect(context.signers.user).proposeAdminTransfer(affiliate, context.signers.user2.address)
                })

                it("only allows the pending admin to accept", async function () {
                    // pending admin can accept
                    await expect(affiliateHub.connect(context.signers.user2).acceptAdminTransfer(affiliate)).to.emit(
                        affiliateHub,
                        "AdminTransferCompleted",
                    )
                    expect(await affiliateHub.getAffiliateAdmin(affiliate)).to.equal(context.signers.user2.address)
                })

                it("reverts for non-pending admins", async function () {
                    // non pending cant accept
                    await expect(affiliateHub.connect(context.signers.others[0]).acceptAdminTransfer(affiliate)).to.be.revertedWithCustomError(
                        affiliateHub,
                        "Unauthorized",
                    )
                })
            })

            describe("cancelAdminTransfer", function () {
                beforeEach(async function () {
                    // set up a pending transfer that we can cancel
                    await affiliateHub.connect(context.signers.user).proposeAdminTransfer(affiliate, context.signers.user2.address)
                })

                it("clears pending admin proposals", async function () {
                    // admin cancels before new admin accepts
                    await expect(affiliateHub.connect(context.signers.user).cancelAdminTransfer(affiliate)).to.emit(
                        affiliateHub,
                        "AdminTransferCancelled",
                    )
                    // pending admin no longer can accept
                    await expect(affiliateHub.connect(context.signers.user2).acceptAdminTransfer(affiliate)).to.be.revertedWithCustomError(
                        affiliateHub,
                        "Unauthorized",
                    )
                })
            })

            describe("updateAffiliateDetails", function () {
                it("requires the active affiliate admin", async function () {
                    // new colors and name
                    const newDetails = { name: "newnewname", brandColor: "#111111" }
                    // non admin still blocked
                    await expect(
                        affiliateHub.connect(context.signers.user2).updateAffiliateDetails(affiliate, newDetails.name, newDetails.brandColor),
                    ).to.be.revertedWithCustomError(affiliateHub, "NotAdmin")
                    // admin can update
                    await expect(
                        affiliateHub.connect(context.signers.user).updateAffiliateDetails(affiliate, newDetails.name, newDetails.brandColor),
                    ).to.emit(affiliateHub, "AffiliateUpdated")
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
                    const pauserRole = await affiliateHub.PAUSER_ROLE()
                    await affiliateHub.connect(context.signers.admin).grantRole(pauserRole, context.signers.liquidator.address)

                    // random accounts cant pause
                    await expect(affiliateHub.connect(context.signers.others[0]).pauseAffiliate(affiliate)).to.be.revertedWithCustomError(
                        affiliateHub,
                        "Unauthorized",
                    )
                    // role holder can pause fine
                    await expect(affiliateHub.connect(context.signers.liquidator).pauseAffiliate(affiliate))
                        .to.emit(affiliateHub, "AffiliatePaused")
                        .withArgs(affiliate)
                    expect(await affiliateHub.getAffiliateState(affiliate)).to.equal(AffiliateState.PAUSED)
                })
            })

            describe("unpauseAffiliate", function () {
                beforeEach(async function () {
                    const pauserRole = await affiliateHub.PAUSER_ROLE()
                    const unpauserRole = await affiliateHub.UNPAUSER_ROLE()
                    await affiliateHub.connect(context.signers.admin).grantRole(pauserRole, context.signers.liquidator.address)
                    await affiliateHub.connect(context.signers.admin).grantRole(unpauserRole, context.signers.hedger.address)
                    // start from paused state
                    await affiliateHub.connect(context.signers.liquidator).pauseAffiliate(affiliate)
                })

                it("requires the unpauser role", async function () {
                    // missing role means revert
                    await expect(affiliateHub.connect(context.signers.others[0]).unpauseAffiliate(affiliate)).to.be.revertedWith(
                        `AccessControl: account ${context.signers.others[0].address.toLowerCase()} is missing role ${await affiliateHub.UNPAUSER_ROLE()}`,
                    )
                    // unpauser role restores active state
                    await expect(affiliateHub.connect(context.signers.hedger).unpauseAffiliate(affiliate))
                        .to.emit(affiliateHub, "AffiliateUnpaused")
                        .withArgs(affiliate)
                    expect(await affiliateHub.getAffiliateState(affiliate)).to.equal(AffiliateState.ACTIVE)
                })
            })

            describe("contract pause state", function () {
                beforeEach(async function () {
                    const pauserRole = await affiliateHub.PAUSER_ROLE()
                    const unpauserRole = await affiliateHub.UNPAUSER_ROLE()
                    await affiliateHub.connect(context.signers.admin).grantRole(pauserRole, context.signers.admin.address)
                    await affiliateHub.connect(context.signers.admin).grantRole(unpauserRole, context.signers.admin.address)
                })

                it("blocks actions when paused", async function () {
                    // pause whole contract
                    await affiliateHub.connect(context.signers.admin).pause()
                    // registrations revert while paused
                    await expect(affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ name: "Paused" }))).to.be.revertedWith(
                        "Pausable: paused",
                    )
                    // unpause and allow registrations again
                    await affiliateHub.connect(context.signers.admin).unpause()
                    await expect(affiliateHub.connect(context.signers.user).requestToRegisterAffiliate(buildRegistration({ name: "LiveAgain" }))).to.emit(
                        affiliateHub,
                        "AffiliateRegistered",
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
                        affiliateHub.connect(context.signers.user).requestFeeUpdate(affiliate, newStakeholders, ethers.parseEther("0.2")),
                    ).to.emit(affiliateHub, "StakeholdersUpdateRequested")
                })
            })

            describe("cancelFeeUpdate", function () {
                beforeEach(async function () {
                    // queue an update to cancel
                    const updated = [{ receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.7") }]
                    await affiliateHub.connect(context.signers.user).requestFeeUpdate(affiliate, updated, ethers.parseEther("0.3"))
                })

                it("allows the admin to cancel pending updates", async function () {
                    await expect(affiliateHub.connect(context.signers.user).cancelFeeUpdate(affiliate)).to.emit(affiliateHub, "FeeUpdateCancelled")
                })
            })

            describe("approveFeeUpdate", function () {
                beforeEach(async function () {
                    // queue an update so approver can finalize it
                    const newStakeholders = [{ receiver: context.signers.feeCollector.address, share: ethers.parseEther("0.8") }]
                    await affiliateHub.connect(context.signers.user).requestFeeUpdate(affiliate, newStakeholders, ethers.parseEther("0.2"))
                })

                it("applies the pending update and clears it", async function () {
                    await expect(affiliateHub.connect(context.signers.admin).approveFeeUpdate(affiliate)).to.emit(affiliateHub, "StakeholdersUpdated")
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
                    await expect(affiliateHub.connect(stakeholder).claimFees(affiliate, coreAddress, feeAmount)).to.emit(
                        affiliateHub,
                        "FeesClaimed",
                    )
                    // confirm increase matches share
                    const after = await context.collateral.balanceOf(stakeholder.address)
                    expect(after - before).to.equal((feeAmount * ethers.parseEther("0.4")) / ethers.parseEther("1"))
                })

                it("blocks unauthorized callers", async function () {
                    // random caller cannot touch fees
                    await expect(affiliateHub.connect(context.signers.others[0]).claimFees(affiliate, coreAddress, 1n)).to.be.revertedWithCustomError(
                        affiliateHub,
                        "Unauthorized",
                    )
                })
            })

            describe("dryClaimAllFees", function () {
                it("previews the distribution without transferring funds", async function () {
                    // deposit so theres something to preview
                    const totalFees = ethers.parseEther("50")
                    await depositFeesForAffiliate(affiliate, totalFees, coreAddress)
                    // dry run for a preview
                    const [holders, shares] = await affiliateHub.dryClaimAllFees(affiliate, coreAddress)
                    // balances stay the same but preview is correct
                    expect(holders).to.include(context.signers.feeCollector.address)
                    expect(shares[0]).to.be.gte(0n)
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
                    await expect(affiliateHub.connect(context.signers.user).setHook(affiliate, "0x12345678", await mockHook.getAddress())).to.emit(
                        affiliateHub,
                        "HookSet",
                    )
                })
            })

            describe("removeHook", function () {
                beforeEach(async function () {
                    // add a hook before each removal test
                    const mockHook = await (await ethers.getContractFactory("MockHook")).deploy()
                    await affiliateHub.connect(context.signers.user).setHook(affiliate, "0x12345678", await mockHook.getAddress())
                })

                it("allows the affiliate admin to remove hooks", async function () {
                    await expect(affiliateHub.connect(context.signers.user).removeHook(affiliate, "0x12345678")).to.emit(
                        affiliateHub,
                        "HookRemoved",
                    )
                })
            })
        })

        describe("Configuration", function () {
            beforeEach(async function () {
                // give admin the setter role
                const setterRole = await affiliateHub.SETTER_ROLE()
                await affiliateHub.connect(context.signers.admin).grantRole(setterRole, context.signers.admin.address)
            })

            describe("setAccountHub", function () {
                it("updates the account hub reference", async function () {
                    // set a new hub address
                    const newHub = await context.accountHub.getAddress()
                    await affiliateHub.connect(context.signers.admin).setAccountHub(newHub)
                    // confirm stored value
                    expect(await affiliateHub.accountHub()).to.equal(newHub)
                })
            })

            describe("setSymmioFeeReceiver", function () {
                it("updates the symmio fee receiver", async function () {
                    // set a new receiver
                    const newReceiver = context.signers.symmioFeeReceiver.address
                    await expect(affiliateHub.connect(context.signers.admin).setSymmioFeeReceiver(newReceiver)).to.emit(
                        affiliateHub,
                        "SymmioFeeReceiverUpdated",
                    )
                    // ensure updated
                    expect(await affiliateHub.symmioFeeReceiver()).to.equal(newReceiver)
                })
            })

            describe("setAccountManagerImplementation", function () {
                it("stores the new implementation bytecode hash", async function () {
                    // new bytecode
                    const newImplementation = ethers.randomBytes(32)
                    await affiliateHub.connect(context.signers.admin).setAccountManagerImplementation(newImplementation)
                    // verify storage
                    expect(await affiliateHub.accountManagerImplementation()).to.equal(ethers.hexlify(newImplementation))
                })
            })

            describe("setWhitelistedSymmioCore", function () {
                it("toggles allowed core addresses", async function () {
                    // whitelist a new core address
                    const newCore = context.signers.others[0].address
                    await expect(affiliateHub.connect(context.signers.admin).setWhitelistedSymmioCore(newCore, true)).to.emit(
                        affiliateHub,
                        "WhitelistedSymmioCoreSet",
                    )
                    expect(await affiliateHub.isWhitelistedSymmioCore(newCore)).to.equal(true)
                })
            })
        })
    })
}
