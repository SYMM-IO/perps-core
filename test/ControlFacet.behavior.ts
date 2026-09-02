import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"
import { parseEther, ZeroAddress } from "ethers"
import { toUtf8Bytes } from "ethers"
import sha3 from "js-sha3"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { RunContext } from "./models/RunContext.js"

const { keccak256 } = sha3

const DISPUTE_ROLE = `0x${keccak256("DISPUTE_ROLE")}`
const PARTY_B_MANAGER_ROLE = `0x${keccak256("PARTY_B_MANAGER_ROLE")}`
const AFFILIATE_MANAGER_ROLE = `0x${keccak256("AFFILIATE_MANAGER_ROLE")}`
const ENTITY_METADATA_MANAGER_ROLE = `0x${keccak256("ENTITY_METADATA_MANAGER_ROLE")}`
const SYMBOL_MANAGER_ROLE = `0x${keccak256("SYMBOL_MANAGER_ROLE")}`
const SUSPENDER_ROLE = `0x${keccak256("SUSPENDER_ROLE")}`
const PAUSER_ROLE = `0x${keccak256("PAUSER_ROLE")}`
const UNPAUSER_ROLE = `0x${keccak256("UNPAUSER_ROLE")}`
// New V2 roles
const FEE_ADMIN_ROLE = `0x${keccak256("FEE_ADMIN_ROLE")}`
const COOLDOWN_ADMIN_ROLE = `0x${keccak256("COOLDOWN_ADMIN_ROLE")}`
const EMERGENCY_ADMIN_ROLE = `0x${keccak256("EMERGENCY_ADMIN_ROLE")}`
const UNSUSPENDER_ROLE = `0x${keccak256("UNSUSPENDER_ROLE")}`
const INTEGRATION_ADMIN_ROLE = `0x${keccak256("INTEGRATION_ADMIN_ROLE")}`
const MIGRATION_ROLE = `0x${keccak256("MIGRATION_ROLE")}`

export function shouldBehaveLikeControlFacet(): void {
	let context: RunContext
	let owner: HardhatEthersSigner
	let user2: HardhatEthersSigner
	let hedger: HardhatEthersSigner
	let hedger2: HardhatEthersSigner
	let hedger3: HardhatEthersSigner

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		owner = context.signers.admin
		user2 = context.signers.user2
		hedger = context.signers.hedger
		hedger2 = context.signers.hedger2
		hedger3 = context.signers.others[0]

		await context.controlFacet.connect(context.signers.admin).transferOwnership(await owner.getAddress())
		await context.controlFacet.connect(owner).setAdmin(await owner.getAddress())
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), PARTY_B_MANAGER_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), SYMBOL_MANAGER_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), PAUSER_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), SUSPENDER_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), UNPAUSER_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), AFFILIATE_MANAGER_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), ENTITY_METADATA_MANAGER_ROLE)
		// New V2 roles
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), FEE_ADMIN_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), COOLDOWN_ADMIN_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), EMERGENCY_ADMIN_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), UNSUSPENDER_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), INTEGRATION_ADMIN_ROLE)
		await context.controlFacet.connect(owner).grantRole(await owner.getAddress(), MIGRATION_ROLE)
	})

	describe("transferOwnership", () => {
		it("Should transferOwnership successfully", async function () {
			await expect(context.controlFacet.connect(owner).transferOwnership(await user2.getAddress())).to.not.reverted
			expect(await context.viewFacet.pendingOwner()).to.equal(await user2.getAddress())
		})

		it("Should revert when passing zero address", async function () {
			await expect(context.controlFacet.connect(owner).transferOwnership(ZeroAddress)).to.be.revertedWith("ControlFacet: Zero address")
		})

		it("Should revert when caller is not current owner", async function () {
			await expect(context.controlFacet.connect(user2).transferOwnership(await user2.getAddress())).to.be.revertedWith(
				"LibDiamond: Must be contract owner",
			)
		})
	})

	describe("cancelOwnershipTransfer", () => {
		it("Should allow owner to cancel the pending owner", async function () {
			await context.controlFacet.connect(owner).transferOwnership(await user2.getAddress())
			expect(await context.viewFacet.pendingOwner()).to.equal(await user2.getAddress())
			await expect(context.controlFacet.connect(owner).cancelOwnershipTransfer()).to.not.reverted
			expect(await context.viewFacet.pendingOwner()).to.equal(ZeroAddress)
		})

		it("Should revert when there is no pending owner", async function () {
			// cancel current pending owner because we have transfered owner in 'before'
			await context.controlFacet.connect(owner).cancelOwnershipTransfer()
			// cancel pending owner which is zero address
			await expect(context.controlFacet.connect(owner).cancelOwnershipTransfer()).to.be.revertedWith("LibDiamond: Pending owner is zero")
			expect(await context.viewFacet.pendingOwner()).to.equal(ZeroAddress)
		})

		it("Should revert when caller is not current owner", async function () {
			await context.controlFacet.connect(owner).transferOwnership(await user2.getAddress())
			await expect(context.controlFacet.connect(user2).cancelOwnershipTransfer()).to.be.revertedWith("LibDiamond: Must be contract owner")
		})
	})

	describe("acceptOwnership", () => {
		it("Should revert when no pending owner is set", async function () {
			await context.controlFacet.connect(owner).cancelOwnershipTransfer()
			await expect(context.controlFacet.connect(user2).acceptOwnership()).to.be.revertedWith("LibDiamond: Sender should be the pendingOwner")
		})

		it("Should revert when caller is not the pending owner", async function () {
			await context.controlFacet.connect(owner).transferOwnership(await user2.getAddress())
			await expect(context.controlFacet.connect(owner).acceptOwnership()).to.be.revertedWith("LibDiamond: Sender should be the pendingOwner")
		})

		it("Should allow pending owner to accept ownership", async function () {
			await context.controlFacet.connect(owner).transferOwnership(await user2.getAddress())
			await expect(context.controlFacet.connect(user2).acceptOwnership()).to.not.reverted
			expect(await context.viewFacet.getOwner()).to.equal(await user2.getAddress())
			expect(await context.viewFacet.pendingOwner()).to.equal(ZeroAddress)
		})

		it("Should not allow previous pending owner to accept after reset", async function () {
			await context.controlFacet.connect(owner).transferOwnership(await user2.getAddress())
			await context.controlFacet.connect(owner).cancelOwnershipTransfer()
			await expect(context.controlFacet.connect(user2).acceptOwnership()).to.be.revertedWith("LibDiamond: Sender should be the pendingOwner")
		})

		it("Should update contract owner after acceptance", async function () {
			await context.controlFacet.connect(owner).transferOwnership(await user2.getAddress())
			await context.controlFacet.connect(user2).acceptOwnership()
			await expect(context.controlFacet.connect(owner).transferOwnership(await hedger.getAddress())).to.be.revertedWith(
				"LibDiamond: Must be contract owner",
			)
			await expect(context.controlFacet.connect(user2).transferOwnership(await hedger.getAddress())).to.not.reverted
			expect(await context.viewFacet.pendingOwner()).to.equal(await hedger.getAddress())
		})
	})

	describe("grantRole", () => {
		it("Should grantRole successfully", async function () {
			await expect(context.controlFacet.connect(owner).grantRole(await user2.getAddress(), DISPUTE_ROLE)).to.not.reverted
			expect(await context.viewFacet.hasRole(await user2.getAddress(), DISPUTE_ROLE)).to.be.equal(true)
		})

		it("Should not grantRole to Address zero", async function () {
			await expect(context.controlFacet.connect(owner).grantRole(ethers.ZeroAddress, DISPUTE_ROLE)).to.be.revertedWith("ControlFacet: Zero address")
		})
	})

	describe("revokeRole", () => {
		it("Should revokeRole successfully", async function () {
			await context.controlFacet.connect(owner).grantRole(await user2.getAddress(), DISPUTE_ROLE)
			await expect(context.controlFacet.connect(owner).revokeRole(await user2.getAddress(), DISPUTE_ROLE)).to.not.reverted
			expect(await context.viewFacet.hasRole(await user2.getAddress(), DISPUTE_ROLE)).to.be.equal(false)
		})
	})

	describe("registerPartyB", () => {
		it("Should registerPartyB successfully", async function () {
			await expect(context.controlFacet.connect(owner).registerPartyB(await hedger3.getAddress())).to.not.reverted
			expect(await context.viewFacet.isPartyB(await hedger3.getAddress())).to.be.equal(true)
		})

		it("Should not registerPartyB if partyB exist", async function () {
			await expect(context.controlFacet.connect(owner).registerPartyB(await hedger.getAddress())).to.revertedWith(
				"ControlFacet: Address is already registered",
			)
		})
	})

	describe("deregisterPartyB", () => {
		it("Should deregisterPartyB successfully", async function () {
			await expect(context.controlFacet.connect(owner).deregisterPartyB(await hedger.getAddress(), 0)).to.not.reverted
			expect(await context.viewFacet.isPartyB(await hedger.getAddress())).to.be.equal(false)
		})

		it("Should not deregisterPartyB if Collateral is zero address", async function () {
			await expect(context.controlFacet.connect(owner).deregisterPartyB(ethers.ZeroAddress, 0)).to.be.revertedWith("ControlFacet: Zero address")
		})

		it("Should not deregisterPartyB if address is not register", async function () {
			await expect(context.controlFacet.connect(owner).deregisterPartyB(await hedger3.getAddress(), 0)).to.be.revertedWith(
				"ControlFacet: Address is not registered",
			)
		})

		it("Should not deregisterPartyB if address is not register", async function () {
			await expect(context.controlFacet.connect(owner).deregisterPartyB(await hedger.getAddress(), 1)).to.be.revertedWith(
				"ControlFacet: Invalid index",
			)
		})
	})

	describe("setEntityMetadata", () => {
		const metadata = {
			name: "Symmio entity",
			brandColor: "#00ffcc",
			metadata: "ipfs://entity-metadata",
		}

		it("allows an entity metadata manager to set metadata for any entity type", async function () {
			await context.controlFacet.connect(owner).grantRole(await user2.getAddress(), ENTITY_METADATA_MANAGER_ROLE)
			await context.controlFacet.connect(owner).registerOperationalFeeCharger(await hedger3.getAddress())

			await expect(context.controlFacet.connect(user2).setEntityMetadata(await context.signers.liquidator.getAddress(), metadata))
				.to.emit(context.controlFacet, "SetEntityMetadata")
				.withArgs(await context.signers.liquidator.getAddress(), Object.values(metadata))
			await expect(context.controlFacet.connect(user2).setEntityMetadata(await hedger3.getAddress(), metadata)).to.not.be.reverted

			expect(await context.viewFacet.getEntityMetadata(await context.signers.liquidator.getAddress())).to.deep.equal(Object.values(metadata))
			expect(await context.viewFacet.getEntityMetadata(await hedger3.getAddress())).to.deep.equal(Object.values(metadata))
		})

		it("does not infer generic metadata authority from entity-specific manager roles", async function () {
			await context.controlFacet.connect(owner).grantRole(await user2.getAddress(), AFFILIATE_MANAGER_ROLE)
			await context.controlFacet.connect(owner).grantRole(await hedger3.getAddress(), PARTY_B_MANAGER_ROLE)

			await expect(context.controlFacet.connect(user2).setEntityMetadata(await hedger.getAddress(), metadata)).to.be.revertedWith(
				"Accessibility: Must have role",
			)
			await expect(context.controlFacet.connect(hedger3).setEntityMetadata(await hedger.getAddress(), metadata)).to.be.revertedWith(
				"Accessibility: Must have role",
			)
		})

		it("keeps the legacy setters with their original role checks", async function () {
			await context.controlFacet.connect(owner).grantRole(await user2.getAddress(), PARTY_B_MANAGER_ROLE)
			await context.controlFacet.connect(owner).grantRole(await hedger3.getAddress(), AFFILIATE_MANAGER_ROLE)

			await expect(context.controlFacet.connect(user2).setPartyBMetadata(await hedger.getAddress(), metadata)).to.not.be.reverted
			await expect(context.controlFacet.connect(user2).setAffiliateMetadata(await hedger.getAddress(), metadata)).to.be.revertedWith(
				"Accessibility: Must have role",
			)

			await expect(context.controlFacet.connect(hedger3).setAffiliateMetadata(await user2.getAddress(), metadata)).to.not.be.reverted
			await expect(context.controlFacet.connect(hedger3).setPartyBMetadata(await user2.getAddress(), metadata)).to.be.revertedWith(
				"Accessibility: Must have role",
			)

			expect(await context.viewFacet.getEntityMetadata(await hedger.getAddress())).to.deep.equal(Object.values(metadata))
			expect(await context.viewFacet.getEntityMetadata(await user2.getAddress())).to.deep.equal(Object.values(metadata))
		})
	})

	describe("setCollateral", () => {
		it("Should setCollateral successfully", async function () {
			await expect(context.controlFacet.connect(owner).setCollateral(await context.collateral.getAddress())).to.not.reverted
			expect(await context.viewFacet.getCollateral()).to.be.equal(await context.collateral.getAddress())
		})

		it("Should not setCollateral if Collateral is zero address", async function () {
			await expect(context.controlFacet.connect(owner).setCollateral(ethers.ZeroAddress)).to.be.revertedWith("ControlFacet: Zero address")
		})
	})

	describe("addSymbol", () => {
		it("Should addSymbol successfully", async function () {
			const windowTime = BigInt(28800)
			const period = BigInt(900)
			const baseUnit = BigInt(4000000000000000)
			const quoteUnit = BigInt(1000000000000000)
			const minQty = BigInt("100000000000000000000")
			const maxQty = BigInt("60000000000000000000")

			await expect(context.symbolControlFacet.connect(owner).addSymbol("ETHUSDT", maxQty, baseUnit, quoteUnit, minQty, windowTime, period)).to.not.be
				.reverted
			expect((await context.viewFacetSymbol.getSymbol(2)).name).to.be.equal("ETHUSDT")
		})

		it("Should not addSymbol if windowTime be high", async function () {
			const windowTime = BigInt(800)
			const period = BigInt(900)
			const baseUnit = BigInt(4000000000000000)
			const quoteUnit = BigInt(1000000000000000)
			const minQty = BigInt("100000000000000000000")
			const maxQty = BigInt("60000000000000000000")

			await expect(
				context.symbolControlFacet.connect(owner).addSymbol("ETHUSDT", maxQty, baseUnit, quoteUnit, minQty, windowTime, period),
			).to.be.revertedWith("SymbolControlFacet: High window time")
		})

		it("Should not addSymbol if tradingFee be high", async function () {
			const windowTime = BigInt(28800)
			const period = BigInt(900)
			const baseUnit = BigInt(4000000000000000)
			const quoteUnit = BigInt("100000000000000000000")
			const minQty = BigInt("100000000000000000000")
			const maxQty = BigInt("60000000000000000000")

			await expect(
				context.symbolControlFacet.connect(owner).addSymbol("ETHUSDT", maxQty, baseUnit, quoteUnit, minQty, windowTime, period),
			).to.be.revertedWith("SymbolControlFacet: High default fee")
		})
	})

	describe("setSymbolFundingState", () => {
		it("Should setSymbolFundingState successfully", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolFundingState(1, 28900, 910)).to.not.reverted
			expect((await context.viewFacetSymbol.getSymbol(1)).fundingRateEpochDuration).to.be.equal(28900)
			expect((await context.viewFacetSymbol.getSymbol(1)).fundingRateWindowTime).to.be.equal(910)
		})

		it("Should not setSymbolFundingState if windowTime be high", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolFundingState(1, 910, 28900)).to.revertedWith(
				"SymbolControlFacet: High window time",
			)
		})

		it("Should not setSymbolFundingState if invalid symbol id", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolFundingState(0, 910, 28900)).to.revertedWith("SymbolControlFacet: Invalid id")
			await expect(context.symbolControlFacet.connect(owner).setSymbolFundingState(3, 910, 28900)).to.revertedWith("SymbolControlFacet: Invalid id")
		})
	})

	describe("setSymbolValidationState", () => {
		it("Should setSymbolValidationState successfully", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolValidationState(1, false)).to.not.reverted
			expect((await context.viewFacetSymbol.getSymbol(1)).isValid).to.be.equal(false)
			await expect(context.symbolControlFacet.connect(owner).setSymbolValidationState(1, true)).to.not.reverted
			expect((await context.viewFacetSymbol.getSymbol(1)).isValid).to.be.equal(true)
		})

		it("Should not setSymbolFundingState if invalid symbol id", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolValidationState(0, false)).to.revertedWith("SymbolControlFacet: Invalid id")
			await expect(context.symbolControlFacet.connect(owner).setSymbolValidationState(3, false)).to.revertedWith("SymbolControlFacet: Invalid id")
		})
	})

	describe("setSymbolMaxLeverage", () => {
		it("Should setSymbolMaxLeverage successfully", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolMaxLeverage(1, BigInt("3000000000000000"))).to.not.be.reverted
			expect((await context.viewFacetSymbol.getSymbol(1)).maxLeverage).to.equal(BigInt("3000000000000000"))
		})

		it("Should not setSymbolFundingState if invalid symbol id", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolMaxLeverage(0, BigInt("1000000000000000"))).to.be.revertedWith(
				"SymbolControlFacet: Invalid id",
			)
			await expect(context.symbolControlFacet.connect(owner).setSymbolMaxLeverage(3, BigInt("1000000000000000"))).to.be.revertedWith(
				"SymbolControlFacet: Invalid id",
			)
		})
	})

	describe("setSymbolAcceptableValues", () => {
		it("Should setSymbolAcceptableValues successfully", async function () {
			await expect(
				context.symbolControlFacet.connect(owner).setSymbolAcceptableValues(1, BigInt("200000000000000000000"), BigInt("300000000000000000000")),
			).to.not.be.reverted
			expect((await context.viewFacetSymbol.getSymbol(1)).minAcceptablePortionLF).to.equal(BigInt("300000000000000000000"))
			expect((await context.viewFacetSymbol.getSymbol(1)).minAcceptableQuoteValue).to.equal(BigInt("200000000000000000000"))
		})

		it("Should not setSymbolFundingState if invalid symbol id", async function () {
			await expect(
				context.symbolControlFacet.connect(owner).setSymbolAcceptableValues(0, BigInt("200000000000000000000"), BigInt("300000000000000000000")),
			).to.be.revertedWith("SymbolControlFacet: Invalid id")
			await expect(
				context.symbolControlFacet.connect(owner).setSymbolAcceptableValues(4, BigInt("200000000000000000000"), BigInt("300000000000000000000")),
			).to.be.revertedWith("SymbolControlFacet: Invalid id")
		})
	})

	describe("setSymbolMinAcceptableNotionalLFRate", () => {
		it("Should use symbol 0 as the default and allow explicit per-symbol overrides", async function () {
			const defaultRate = parseEther("0.0002")
			const overrideRate = parseEther("0.0003")

			expect(await context.viewFacetSymbol.getSymbolMinAcceptableNotionalLFRate(0)).to.deep.equal([0n, false])
			expect(await context.viewFacetSymbol.getSymbolMinAcceptableNotionalLFRate(1)).to.deep.equal([0n, false])

			await expect(context.symbolControlFacet.connect(owner).setSymbolMinAcceptableNotionalLFRate(0, defaultRate))
				.to.emit(context.symbolControlFacet, "SetSymbolMinAcceptableNotionalLFRate")
				.withArgs(0, 0, defaultRate, false)
			expect(await context.viewFacetSymbol.getSymbolMinAcceptableNotionalLFRate(1)).to.deep.equal([defaultRate, false])

			await expect(context.symbolControlFacet.connect(owner).setSymbolMinAcceptableNotionalLFRate(1, overrideRate))
				.to.emit(context.symbolControlFacet, "SetSymbolMinAcceptableNotionalLFRate")
				.withArgs(1, defaultRate, overrideRate, true)
			expect(await context.viewFacetSymbol.getSymbolMinAcceptableNotionalLFRate(1)).to.deep.equal([overrideRate, true])

			const updatedDefaultRate = parseEther("0.0004")
			await context.symbolControlFacet.connect(owner).setSymbolMinAcceptableNotionalLFRate(0, updatedDefaultRate)
			expect(await context.viewFacetSymbol.getSymbolMinAcceptableNotionalLFRate(1)).to.deep.equal([overrideRate, true])

			await context.symbolControlFacet.connect(owner).setSymbolMinAcceptableNotionalLFRate(1, 0)
			expect(await context.viewFacetSymbol.getSymbolMinAcceptableNotionalLFRate(1)).to.deep.equal([0n, true])

			await expect(context.symbolControlFacet.connect(owner).clearSymbolMinAcceptableNotionalLFRateOverride(1))
				.to.emit(context.symbolControlFacet, "SetSymbolMinAcceptableNotionalLFRate")
				.withArgs(1, 0, updatedDefaultRate, false)
			expect(await context.viewFacetSymbol.getSymbolMinAcceptableNotionalLFRate(1)).to.deep.equal([updatedDefaultRate, false])
		})

		it("Should reject invalid symbols and callers without the symbol manager role", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolMinAcceptableNotionalLFRate(2, 1)).to.be.revertedWith(
				"SymbolControlFacet: Invalid id",
			)
			await expect(context.symbolControlFacet.connect(owner).clearSymbolMinAcceptableNotionalLFRateOverride(0)).to.be.revertedWith(
				"SymbolControlFacet: Invalid id",
			)
			await expect(context.symbolControlFacet.connect(owner).clearSymbolMinAcceptableNotionalLFRateOverride(2)).to.be.revertedWith(
				"SymbolControlFacet: Invalid id",
			)
			await expect(context.symbolControlFacet.connect(user2).setSymbolMinAcceptableNotionalLFRate(0, 1)).to.be.revertedWith(
				"Accessibility: Must have role",
			)
		})
	})

	describe("setSymbolTradingFee", () => {
		it("Should setSymbolTradingFee successfully", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolTradingFee(1, BigInt("200000000000000000000"))).to.not.be.reverted
			expect((await context.viewFacetSymbol.getSymbol(1)).tradingFee).to.equal(BigInt("200000000000000000000"))
		})

		it("Should not setSymbolTradingFee if invalid symbol id", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolTradingFee(0, BigInt("200000000000000000000"))).to.be.revertedWith(
				"SymbolControlFacet: Invalid id",
			)
			await expect(context.symbolControlFacet.connect(owner).setSymbolTradingFee(6, BigInt("200000000000000000000"))).to.be.revertedWith(
				"SymbolControlFacet: Invalid id",
			)
		})
	})

	describe("setSignatureVerifierAddress", () => {
		it("should require explicit RemoveMargin support", async function () {
			const currentVerifier = await context.viewFacet.getSignatureVerifier()
			const legacyVerifier = await ethers.deployContract("LegacyMuonSignatureVerifier")

			await expect(context.controlFacet.connect(owner).setSignatureVerifierAddress(await legacyVerifier.getAddress())).to.be.revertedWithCustomError(
				context.controlFacet,
				"IncompatibleSignatureVerifier",
			)
			expect(await context.viewFacet.getSignatureVerifier()).to.equal(currentVerifier)
		})

		it("should accept a forward-compatible verifier and allow zero to disable it", async function () {
			const verifier = await ethers.deployContract("MockMuonSignatureVerifier")
			await expect(context.controlFacet.connect(owner).setSignatureVerifierAddress(await verifier.getAddress())).to.not.be.reverted
			expect(await context.viewFacet.getSignatureVerifier()).to.equal(await verifier.getAddress())

			await expect(context.controlFacet.connect(owner).setSignatureVerifierAddress(ZeroAddress)).to.not.be.reverted
			expect(await context.viewFacet.getSignatureVerifier()).to.equal(ZeroAddress)
		})
	})

	describe("setForceCancelCooldown", () => {
		it("Should setForceCancelCooldown successfully", async function () {
			await expect(context.controlFacet.connect(owner).setForceCancelCooldown(BigInt("1708784117"))).to.not.be.reverted
			expect((await context.viewFacet.coolDownsOfMA())[1]).to.equal(BigInt("1708784117"))
		})
	})

	describe("setDeallocateCooldown", () => {
		it("Should setDeallocateCooldown successfully", async function () {
			await expect(context.controlFacet.connect(owner).setDeallocateCooldown(BigInt("1708784117"))).to.not.be.reverted
			expect((await context.viewFacet.coolDownsOfMA())[0]).to.equal(BigInt("1708784117"))
		})
	})

	describe("setWithdrawCooldownPeriod", () => {
		it("Should setWithdrawCooldownPeriod successfully", async function () {
			await expect(context.controlFacet.connect(owner).setWithdrawCooldownPeriod(BigInt("300"))).to.not.be.reverted
			expect((await context.viewFacet.coolDownsOfMA())[0]).to.equal(BigInt("300"))
		})
	})

	describe("setDeallocateCooldown and setWithdrawCooldownPeriod equivalence", () => {
		it("Should both set the same underlying value", async function () {
			await context.controlFacet.connect(owner).setDeallocateCooldown(BigInt("500"))
			expect((await context.viewFacet.coolDownsOfMA())[0]).to.equal(BigInt("500"))
			expect(await context.viewFacet.deallocateCooldown()).to.equal(BigInt("500"))

			await context.controlFacet.connect(owner).setWithdrawCooldownPeriod(BigInt("700"))
			expect((await context.viewFacet.coolDownsOfMA())[0]).to.equal(BigInt("700"))
			expect(await context.viewFacet.deallocateCooldown()).to.equal(BigInt("700"))
		})

		it("Should emit both SetWithdrawCooldownPeriod and SetDeallocateCooldown events", async function () {
			await expect(context.controlFacet.connect(owner).setDeallocateCooldown(BigInt("400")))
				.to.emit(context.controlFacet, "SetWithdrawCooldownPeriod")
				.and.to.emit(context.controlFacet, "SetDeallocateCooldown")
		})
	})

	describe("setForceCloseCooldowns", () => {
		it("Should setForceCloseCooldowns successfully", async function () {
			await expect(context.controlFacet.connect(owner).setForceCloseCooldowns(BigInt("1708784117"), BigInt("1708794117"))).to.not.be.reverted
			expect((await context.viewFacet.forceCloseCooldowns())[0]).to.equal(BigInt("1708784117"))
			expect((await context.viewFacet.forceCloseCooldowns())[1]).to.equal(BigInt("1708794117"))
		})
	})

	describe("setForceClosePricePenalty", () => {
		it("Should setForceClosePricePenalty successfully", async function () {
			await expect(context.controlFacet.connect(owner).setForceClosePricePenalty(BigInt("200"))).to.not.be.reverted
			expect(await context.viewFacet.forceClosePricePenalty()).to.equal(BigInt("200"))
		})
	})

	describe("setForceCancelCloseCooldown", () => {
		it("Should setForceCancelCloseCooldown successfully", async function () {
			await expect(context.controlFacet.connect(owner).setForceCancelCloseCooldown(BigInt("1708784117"))).to.not.be.reverted
			expect((await context.viewFacet.coolDownsOfMA())[2]).to.equal(BigInt("1708784117"))
		})
	})

	describe("setForceCloseGapRatio", () => {
		it("Should setForceCloseGapRatio successfully", async function () {
			await expect(context.controlFacet.connect(owner).setForceCloseGapRatio(1, BigInt("200"))).to.not.be.reverted
			expect(await context.viewFacetSymbol.forceCloseGapRatio(1)).to.equal(BigInt("200"))
		})
	})

	describe("setFeeCollector", () => {
		it("Should setFeeCollector successfully", async function () {
			await expect(context.controlFacet.connect(owner).setFeeCollector(context.accountManager2!, user2.address)).to.not.be.reverted
			expect(await context.viewFacet.getFeeCollector(context.accountManager2!)).to.equal(user2.address)
		})

		it("Should not setFeeCollector when address is zero", async function () {
			await expect(context.controlFacet.connect(owner).setFeeCollector(context.accountManager2!, ethers.ZeroAddress)).to.be.revertedWith(
				"ControlFacet: Zero address",
			)
		})
	})

	describe("pauseGlobal", () => {
		it("Should pauseGlobal successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).pauseGlobal()).to.not.reverted
			expect((await context.viewFacet.pauseState()).globalPaused).to.be.equal(true)
		})
	})

	describe("pauseLiquidation", () => {
		it("Should pauseLiquidation successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).pauseLiquidation()).to.not.reverted
			expect((await context.viewFacet.pauseState()).liquidationPaused).to.be.equal(true)
		})
	})

	describe("pausePartyBOpenPositions", () => {
		it("Should pausePartyBOpenPositions successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).pausePartyBOpenPositions()).to.not.reverted
			expect((await context.viewFacet.pauseState()).partyBOpenPositionsPaused).to.be.equal(true)
		})
	})

	describe("activeEmergencyMode", () => {
		it("Should activeEmergencyMode successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).activeEmergencyMode()).to.not.reverted
			expect((await context.viewFacet.pauseState()).emergencyMode).to.be.equal(true)
		})
	})

	describe("unpauseGlobal", () => {
		it("Should unpauseGlobal successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).unpauseGlobal()).to.not.reverted
			expect((await context.viewFacet.pauseState()).globalPaused).to.be.equal(false)
		})
	})

	describe("unpauseLiquidation", () => {
		it("Should unpauseLiquidation successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).unpauseLiquidation()).to.not.reverted
			expect((await context.viewFacet.pauseState()).liquidationPaused).to.be.equal(false)
		})
	})

	describe("unpauseAccounting", () => {
		it("Should unpauseAccounting successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).unpauseAccounting()).to.not.reverted
			expect((await context.viewFacet.pauseState()).accountingPaused).to.be.equal(false)
		})
	})

	describe("unpausePartyAActions", () => {
		it("Should unpausePartyAActions successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).unpausePartyAActions()).to.not.reverted
			expect((await context.viewFacet.pauseState()).partyAActionsPaused).to.be.equal(false)
		})
	})

	describe("unpausePartyBActions", () => {
		it("Should unpausePartyBActions successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).unpausePartyBActions()).to.not.reverted
			expect((await context.viewFacet.pauseState()).partyBActionsPaused).to.be.equal(false)
		})
	})

	describe("unpausePartyBOpenPositions", () => {
		it("Should unpausePartyBOpenPositions successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).unpausePartyBOpenPositions()).to.not.reverted
			expect((await context.viewFacet.pauseState()).partyBOpenPositionsPaused).to.be.equal(false)
		})
	})

	describe("suspendedAddress", () => {
		it("Should suspendedAddress successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).suspendedAddress(user2.address)).to.not.reverted
			expect(await context.viewFacet.isSuspended(user2.address)).to.be.equal(true)
		})
	})

	describe("unsuspendedAddress", () => {
		it("Should unsuspendedAddress successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).suspendedAddress(user2.address)).to.not.reverted
			await expect(context.pauseControlFacet.connect(owner).unsuspendedAddress(user2.address)).to.not.reverted
			expect(await context.viewFacet.isSuspended(user2.address)).to.be.equal(false)
		})
	})

	describe("deactiveEmergencyMode", () => {
		it("Should deactiveEmergencyMode successfully", async function () {
			await expect(context.pauseControlFacet.connect(owner).deactiveEmergencyMode()).to.not.reverted
			expect((await context.viewFacet.pauseState()).emergencyMode).to.be.equal(false)
		})
	})

	describe("setPartyBOpenPositionsPaused", () => {
		it("Should set and unset per-PartyB open positions pause", async function () {
			const hedgerAddress = context.signers.hedger.address
			expect(await context.viewFacet.isPartyBOpenPositionsPaused(hedgerAddress)).to.be.equal(false)

			await expect(context.pauseControlFacet.connect(owner).setPartyBOpenPositionsPaused(hedgerAddress, true)).to.not.reverted
			expect(await context.viewFacet.isPartyBOpenPositionsPaused(hedgerAddress)).to.be.equal(true)

			await expect(context.pauseControlFacet.connect(owner).setPartyBOpenPositionsPaused(hedgerAddress, false)).to.not.reverted
			expect(await context.viewFacet.isPartyBOpenPositionsPaused(hedgerAddress)).to.be.equal(false)
		})

		it("Should revert on zero address", async function () {
			await expect(context.pauseControlFacet.connect(owner).setPartyBOpenPositionsPaused(ZeroAddress, true)).to.be.revertedWith(
				"PauseControlFacet: Zero address",
			)
		})
	})

	describe("scheduleAffiliateShutdown", () => {
		it("Should schedule and cancel an affiliate shutdown by affiliate manager", async function () {
			const affiliate = await context.accountManager.getAddress()
			const shutdownAt = BigInt(await time.latest()) + 10n
			expect(await context.viewFacet.getAffiliateShutdownTime(affiliate)).to.be.equal(0)

			await expect(context.controlFacet.connect(owner).scheduleAffiliateShutdown(affiliate, shutdownAt))
				.to.emit(context.controlFacet, "ScheduleAffiliateShutdown")
				.withArgs(affiliate, shutdownAt)
			expect(await context.viewFacet.isAffiliateShutdownScheduled(affiliate)).to.be.equal(true)
			expect(await context.viewFacet.getAffiliateShutdownTime(affiliate)).to.be.equal(shutdownAt)

			await expect(context.controlFacet.connect(owner).cancelAffiliateShutdown(affiliate))
				.to.emit(context.controlFacet, "CancelAffiliateShutdown")
				.withArgs(affiliate)
			expect(await context.viewFacet.isAffiliateShutdownScheduled(affiliate)).to.be.equal(false)
			expect(await context.viewFacet.getAffiliateShutdownTime(affiliate)).to.be.equal(0)
		})

		it("Should allow an affiliate address to schedule and cancel its own shutdown", async function () {
			const affiliate = await user2.getAddress()
			await context.controlFacet.connect(owner).registerAffiliate(affiliate)
			const shutdownAt = BigInt(await time.latest()) + 10n

			await expect(context.controlFacet.connect(user2).scheduleAffiliateShutdown(affiliate, shutdownAt))
				.to.emit(context.controlFacet, "ScheduleAffiliateShutdown")
				.withArgs(affiliate, shutdownAt)

			await expect(context.controlFacet.connect(user2).cancelAffiliateShutdown(affiliate))
				.to.emit(context.controlFacet, "CancelAffiliateShutdown")
				.withArgs(affiliate)
		})

		it("Should allow any nonzero shutdown date and reject duplicate schedules", async function () {
			const affiliate = await context.accountManager.getAddress()
			const now = BigInt(await time.latest())
			const soonShutdownAt = now + 10n
			const farShutdownAt = now + 3650n * 24n * 60n * 60n

			await context.controlFacet.connect(owner).scheduleAffiliateShutdown(affiliate, soonShutdownAt)
			expect(await context.viewFacet.getAffiliateShutdownTime(affiliate)).to.be.equal(soonShutdownAt)
			await context.controlFacet.connect(owner).cancelAffiliateShutdown(affiliate)

			await context.controlFacet.connect(owner).scheduleAffiliateShutdown(affiliate, farShutdownAt)
			expect(await context.viewFacet.getAffiliateShutdownTime(affiliate)).to.be.equal(farShutdownAt)
			await expect(context.controlFacet.connect(owner).scheduleAffiliateShutdown(affiliate, farShutdownAt + 10n)).to.be.revertedWith(
				"ControlFacet: Affiliate shutdown already scheduled",
			)
		})

		it("Should reject zero shutdown time", async function () {
			const affiliate = await context.accountManager.getAddress()

			await expect(context.controlFacet.connect(owner).scheduleAffiliateShutdown(affiliate, 0)).to.be.revertedWith(
				"ControlFacet: Invalid shutdown time",
			)
		})

		it("Should reject unauthorized shutdown scheduling and cancellation", async function () {
			const affiliate = await context.accountManager.getAddress()
			const shutdownAt = BigInt(await time.latest()) + 10n

			await expect(context.controlFacet.connect(user2).scheduleAffiliateShutdown(affiliate, shutdownAt)).to.be.revertedWith(
				"ControlFacet: Not authorized",
			)
			await expect(context.controlFacet.connect(user2).cancelAffiliateShutdown(affiliate)).to.be.revertedWith("ControlFacet: Not authorized")
		})

		it("Should reject zero address and missing schedule cancellation", async function () {
			const affiliate = await context.accountManager.getAddress()
			const shutdownAt = BigInt(await time.latest()) + 10n

			await expect(context.controlFacet.connect(owner).scheduleAffiliateShutdown(ZeroAddress, shutdownAt)).to.be.revertedWith(
				"ControlFacet: Zero address",
			)
			await expect(context.controlFacet.connect(owner).cancelAffiliateShutdown(ZeroAddress)).to.be.revertedWith("ControlFacet: Zero address")
			await expect(context.controlFacet.connect(owner).cancelAffiliateShutdown(affiliate)).to.be.revertedWith(
				"ControlFacet: Affiliate shutdown not scheduled",
			)
		})
	})

	describe("ExternalTransfer methods", function () {
		it("Should allow admin to add external transfer targets", async function () {
			await expect(
				context.controlFacet
					.connect(context.signers.admin)
					.addRelayerForExternalTransferTarget(context.signers.others[0].address, context.signers.others[1].address),
			)
				.to.emit(context.controlFacet, "AddRelayerForExternalTransferTarget")
				.withArgs(context.signers.others[0].address, context.signers.others[1].address)
		})

		it("Should allow admin to remove external transfer targets", async function () {
			await context.controlFacet
				.connect(context.signers.admin)
				.addRelayerForExternalTransferTarget(context.signers.others[0].address, context.signers.others[1].address)

			await expect(context.controlFacet.connect(context.signers.admin).removeRelayerForExternalTransferTarget(context.signers.others[0].address))
				.to.emit(context.controlFacet, "RemoveRelayerForExternalTransferTarget")
				.withArgs(context.signers.others[0].address)
		})

		it("Should fail when non-admin tries to add external transfer target", async function () {
			await expect(
				context.controlFacet
					.connect(context.signers.user)
					.addRelayerForExternalTransferTarget(context.signers.others[0].address, context.signers.others[1].address),
			).to.be.revertedWith("Accessibility: Must have role")
		})

		it("Should fail when non-admin tries to remove external transfer target", async function () {
			await context.controlFacet
				.connect(context.signers.admin)
				.addRelayerForExternalTransferTarget(context.signers.others[0].address, context.signers.others[1].address)

			await expect(
				context.controlFacet.connect(context.signers.user).removeRelayerForExternalTransferTarget(context.signers.others[0].address),
			).to.be.revertedWith("Accessibility: Must have role")
		})

		it("Should fail to add zero address as external transfer target", async function () {
			await expect(
				context.controlFacet.connect(context.signers.admin).addRelayerForExternalTransferTarget(ZeroAddress, context.signers.others[1].address),
			).to.be.revertedWith("ControlFacet: Zero address")
		})
	})

	describe("setSymbolTypes", () => {
		it("Should setSymbolTypes successfully", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolTypes([1], [2])).to.not.be.reverted
			expect((await context.viewFacetSymbol.getSymbolWithType(1)).symbolType).to.be.equal(2)
		})

		it("Should not setSymbolTypes if invalid symbol id", async function () {
			await expect(context.symbolControlFacet.connect(owner).setSymbolTypes([0], [1])).to.be.revertedWith("SymbolControlFacet: Invalid id")
			await expect(context.symbolControlFacet.connect(owner).setSymbolTypes([3], [1])).to.be.revertedWith("SymbolControlFacet: Invalid id")
		})
	})

	describe("PartyB liquidation overshoot rates", () => {
		const FIVE_BPS = 5n * 10n ** 14n

		it("inherits the PartyB default, supports an explicit zero override, and clears back to inheritance", async function () {
			const partyB = await hedger.getAddress()

			await expect(context.symbolControlFacet.connect(owner).setPartyBLiquidationOvershootRate(partyB, 0n, FIVE_BPS))
				.to.emit(context.symbolControlFacet, "SetPartyBLiquidationOvershootRate")
				.withArgs(partyB, 0n, 0n, FIVE_BPS, false)
			expect(await context.viewFacetSymbol.getPartyBLiquidationOvershootRate(partyB, 0n)).to.deep.equal([FIVE_BPS, false])
			expect(await context.viewFacetSymbol.getPartyBLiquidationOvershootRate(partyB, 1n)).to.deep.equal([FIVE_BPS, false])

			await expect(context.symbolControlFacet.connect(owner).setPartyBLiquidationOvershootRate(partyB, 1n, 0n))
				.to.emit(context.symbolControlFacet, "SetPartyBLiquidationOvershootRate")
				.withArgs(partyB, 1n, FIVE_BPS, 0n, true)
			expect(await context.viewFacetSymbol.getPartyBLiquidationOvershootRate(partyB, 1n)).to.deep.equal([0n, true])

			await expect(context.symbolControlFacet.connect(owner).clearPartyBLiquidationOvershootRateOverride(partyB, 1n))
				.to.emit(context.symbolControlFacet, "SetPartyBLiquidationOvershootRate")
				.withArgs(partyB, 1n, 0n, FIVE_BPS, false)
			expect(await context.viewFacetSymbol.getPartyBLiquidationOvershootRate(partyB, 1n)).to.deep.equal([FIVE_BPS, false])
		})

		it("defaults unconfigured PartyBs to zero and caps manager-selected rates at 1e18", async function () {
			expect(await context.viewFacetSymbol.getPartyBLiquidationOvershootRate(await hedger2.getAddress(), 1n)).to.deep.equal([0n, false])

			await expect(
				context.symbolControlFacet.connect(owner).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 1n, 10n ** 18n + 1n),
			).to.be.revertedWith("SymbolControlFacet: High overshoot rate")
			await context.symbolControlFacet.connect(owner).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 1n, 10n ** 18n)
			expect(await context.viewFacetSymbol.getPartyBLiquidationOvershootRate(await hedger.getAddress(), 1n)).to.deep.equal([10n ** 18n, true])
		})

		it("requires PartyB manager authority, a registered PartyB, and symbol zero or an existing symbol", async function () {
			await expect(
				context.symbolControlFacet.connect(user2).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 0n, FIVE_BPS),
			).to.be.revertedWith("Accessibility: Must have role")
			await expect(
				context.symbolControlFacet.connect(owner).setPartyBLiquidationOvershootRate(await user2.getAddress(), 0n, FIVE_BPS),
			).to.be.revertedWith("SymbolControlFacet: Address is not PartyB")
			await expect(
				context.symbolControlFacet.connect(owner).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 2n, FIVE_BPS),
			).to.be.revertedWith("SymbolControlFacet: Invalid id")
			await expect(
				context.symbolControlFacet.connect(owner).clearPartyBLiquidationOvershootRateOverride(await hedger.getAddress(), 0n),
			).to.be.revertedWith("SymbolControlFacet: Invalid id")
		})
	})

	describe("addSymbolsWithType", () => {
		it("Should addSymbolsWithType successfully", async function () {
			const symbolsWithType = [
				{
					symbolId: 0,
					name: "ETHUSDT",
					isValid: true,
					minAcceptableQuoteValue: BigInt("100000000000000000000"),
					minAcceptablePortionLF: BigInt(4000000000000000),
					tradingFee: BigInt(1000000000000000),
					maxLeverage: BigInt("60000000000000000000"),
					fundingRateEpochDuration: BigInt(28800),
					fundingRateWindowTime: BigInt(900),
					symbolType: 2,
					// tradingFee: BigInt(800000000000000),
				},
				{
					symbolId: 0,
					name: "ADAUSDT",
					isValid: true,
					minAcceptableQuoteValue: BigInt("50000000000000000000"),
					minAcceptablePortionLF: BigInt(3000000000000000),
					tradingFee: BigInt(800000000000000),
					maxLeverage: BigInt("50000000000000000000"),
					fundingRateEpochDuration: BigInt(28800),
					fundingRateWindowTime: BigInt(900),
					symbolType: 3,
					// defaultFee: BigInt(800000000000000),
				},
			]

			await expect(context.symbolControlFacet.connect(owner).addSymbolsWithType(symbolsWithType)).to.not.be.reverted
			expect((await context.viewFacetSymbol.getSymbol(2)).name).to.be.equal("ETHUSDT")
			expect((await context.viewFacetSymbol.getSymbolWithType(2)).symbolType).to.be.equal(2)
			expect((await context.viewFacetSymbol.getSymbol(3)).name).to.be.equal("ADAUSDT")
			expect((await context.viewFacetSymbol.getSymbolWithType(3)).symbolType).to.be.equal(3)
		})

		it("Should not addSymbolsWithType if windowTime be high", async function () {
			const symbolsWithType = [
				{
					symbolId: 0,
					name: "ETHUSDT",
					isValid: true,
					minAcceptableQuoteValue: BigInt("100000000000000000000"),
					minAcceptablePortionLF: BigInt(4000000000000000),
					tradingFee: BigInt(1000000000000000),
					maxLeverage: BigInt("60000000000000000000"),
					fundingRateEpochDuration: BigInt(900),
					fundingRateWindowTime: BigInt(800),
					symbolType: 1,
					// defaultFee: BigInt(800000000000000),
				},
			]

			await expect(context.symbolControlFacet.connect(owner).addSymbolsWithType(symbolsWithType)).to.be.revertedWith(
				"SymbolControlFacet: High window time",
			)
		})

		it("Should not addSymbolsWithType if tradingFee be high", async function () {
			const symbolsWithType = [
				{
					symbolId: 0,
					name: "ETHUSDT",
					isValid: true,
					minAcceptableQuoteValue: BigInt("100000000000000000000"),
					minAcceptablePortionLF: BigInt(4000000000000000),
					tradingFee: BigInt(2e18),
					maxLeverage: BigInt("60000000000000000000"),
					fundingRateEpochDuration: BigInt(28800),
					fundingRateWindowTime: BigInt(900),
					symbolType: 1,
				},
			]

			await expect(context.symbolControlFacet.connect(owner).addSymbolsWithType(symbolsWithType)).to.be.revertedWith(
				"SymbolControlFacet: High default fee",
			)
		})
	})

	describe("setAffiliateFee", () => {
		it("should failed when the provided address as affiliate is not affiliate", async () => {
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [BigInt(1e18)], [BigInt(1e18)])).to.revertedWith(
				"ControlFacet: Invalid affiliate",
			)
		})

		it("should set fee for affiliate successfully", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [BigInt(1e18)], [BigInt(1e18)])).to.not.reverted

			const fee = await context.viewFacet.getAffiliateFee(context.signers.hedger, 1)

			expect(fee.openFee).to.equal(BigInt(1e18))
			expect(fee.closeFee).to.equal(BigInt(1e18))
		})

		it("should set fees for multiple affiliates successfully", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await context.controlFacet.registerAffiliate(context.signers.hedger2)
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [BigInt(1e18)], [BigInt(1e18)])).to.not.reverted
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger2.address, [2], [BigInt(5e17)], [BigInt(5e17)])).to.not.reverted

			const fee1 = await context.viewFacet.getAffiliateFee(context.signers.hedger, 1)
			const fee2 = await context.viewFacet.getAffiliateFee(context.signers.hedger2, 2)

			expect(fee1.openFee).to.equal(BigInt(1e18))
			expect(fee1.closeFee).to.equal(BigInt(1e18))
			expect(fee2.openFee).to.equal(BigInt(5e17))
			expect(fee2.closeFee).to.equal(BigInt(5e17))
		})

		it("should fail if array lengths mismatch", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1, 2], [BigInt(1e18)], [BigInt(1e18)])).to.revertedWith(
				"ControlFacet: Invalid array length",
			)
		})

		it("should fail if empty array", async () => {
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [], [], [])).to.revertedWith(
				"ControlFacet: Invalid array length",
			)
		})

		it("should failed if fee is high", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [BigInt(2e18)], [BigInt(1e18)])).to.revertedWith(
				"ControlFacet: High fee",
			)
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [BigInt(1e18)], [BigInt(2e18)])).to.revertedWith(
				"ControlFacet: High fee",
			)
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [BigInt(2e18)], [BigInt(2e18)])).to.revertedWith(
				"ControlFacet: High fee",
			)
		})
		it("should fail if fee is less than threshold", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await context.controlFacet.setMinAffiliateFee(BigInt(5e17))
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [BigInt(1e17)], [BigInt(9e17)])).to.revertedWith(
				"ControlFacet: Not allowed to set fee less than threshold",
			)
			await expect(context.controlFacet.setAffiliateFee(context.signers.hedger.address, [1], [BigInt(9e17)], [BigInt(1e17)])).to.revertedWith(
				"ControlFacet: Not allowed to set fee less than threshold",
			)
		})
	})

	describe("setCrossPartyBModeActivated", () => {
		it("should allow admin to toggle cross partyB activation", async function () {
			expect(await context.viewFacet.isCrossPartyBModeActivated()).to.equal(false)

			// set true
			await expect(context.controlFacet.connect(owner).setCrossPartyBModeActivated(true))
				.to.emit(context.controlFacet, "SetCrossPartyBModeActivated")
				.withArgs(false, true)
			expect(await context.viewFacet.isCrossPartyBModeActivated()).to.equal(true)

			// set false
			await expect(context.controlFacet.connect(owner).setCrossPartyBModeActivated(false))
				.to.emit(context.controlFacet, "SetCrossPartyBModeActivated")
				.withArgs(true, false)
			expect(await context.viewFacet.isCrossPartyBModeActivated()).to.equal(false)
		})

		it("should revert when caller dont have admin role for cross partyB activation set", async function () {
			await expect(context.controlFacet.connect(user2).setCrossPartyBModeActivated(true)).to.be.revertedWith("Accessibility: Must have role")
		})
	})

	describe("setAffiliateFeeForUser", () => {
		it("should fail when the provided address as affiliate is not affiliate", async () => {
			await expect(
				context.controlFacet.setAffiliateFeeForUser(
					context.signers.hedger.address,
					[context.signers.user.address],
					[1],
					[BigInt(1e18)],
					[BigInt(1e18)],
				),
			).to.revertedWith("ControlFacet: Invalid affiliate")
		})

		it("should set fee for affiliate and user successfully", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await expect(
				context.controlFacet.setAffiliateFeeForUser(
					context.signers.hedger.address,
					[context.signers.user.address],
					[1],
					[BigInt(1e18)],
					[BigInt(1e18)],
				),
			).to.not.reverted

			const fee = await context.viewFacet.getAffiliateFeeForUser(context.signers.hedger, context.signers.user, 1)

			expect(fee.openFee).to.equal(BigInt(1e18))
			expect(fee.closeFee).to.equal(BigInt(1e18))
		})

		it("should fail if array lengths mismatch", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await expect(
				context.controlFacet.setAffiliateFeeForUser(
					context.signers.hedger.address,
					[context.signers.user.address, context.signers.user2.address],
					[1],
					[BigInt(1e18)],
					[BigInt(1e18)],
				),
			).to.revertedWith("ControlFacet: Invalid array length")
		})

		it("should fail if empty array", async () => {
			await expect(context.controlFacet.setAffiliateFeeForUser(context.signers.hedger.address, [], [], [], [])).to.revertedWith(
				"ControlFacet: Invalid array length",
			)
		})

		it("should fail if fee is high", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await expect(
				context.controlFacet.setAffiliateFeeForUser(
					context.signers.hedger.address,
					[context.signers.user.address],
					[1],
					[BigInt(2e18)],
					[BigInt(1e18)],
				),
			).to.revertedWith("ControlFacet: High fee")
			await expect(
				context.controlFacet.setAffiliateFeeForUser(
					context.signers.hedger.address,
					[context.signers.user.address],
					[1],
					[BigInt(1e18)],
					[BigInt(2e18)],
				),
			).to.revertedWith("ControlFacet: High fee")
			await expect(
				context.controlFacet.setAffiliateFeeForUser(
					context.signers.hedger.address,
					[context.signers.user.address],
					[1],
					[BigInt(2e18)],
					[BigInt(2e18)],
				),
			).to.revertedWith("ControlFacet: High fee")
		})

		it("should fail if fee is less than threshold", async () => {
			await context.controlFacet.registerAffiliate(context.signers.hedger)
			await context.controlFacet.setMinAffiliateFee(BigInt(5e17))
			await expect(
				context.controlFacet.setAffiliateFeeForUser(
					context.signers.hedger.address,
					[context.signers.user.address],
					[1],
					[BigInt(1e17)],
					[BigInt(9e17)],
				),
			).to.revertedWith("ControlFacet: Not allowed to set fee less than threshold")
			await expect(
				context.controlFacet.setAffiliateFeeForUser(
					context.signers.hedger.address,
					[context.signers.user.address],
					[1],
					[BigInt(9e17)],
					[BigInt(1e17)],
				),
			).to.revertedWith("ControlFacet: Not allowed to set fee less than threshold")
		})
	})

	describe("setMinAffiliateFee", () => {
		it("should set min fee for affiliates successfully", async () => {
			await expect(context.controlFacet.setMinAffiliateFee(BigInt(1e16))).to.not.reverted
			const threshold = await context.viewFacet.getMinAffiliateFee()
			expect(threshold).to.equal(BigInt(1e16))
		})
	})

	describe("setPenaltyCollector", () => {
		it("should set penalty collector correctly", async () => {
			await expect(context.controlFacet.setSoftLiquidationPenaltyCollector(context.signers.admin)).to.not.reverted
			expect(await context.viewFacet.getSoftLiquidationPenaltyCollector()).to.equal(context.signers.admin.address)
		})
	})

	describe("setPartyBStrictDeallocation", () => {
		it("should be disabled by default and allow Party B manager to enable it per solver", async () => {
			expect(await context.viewFacet.isPartyBStrictDeallocationEnabled(hedger.address)).to.equal(false)

			await expect(context.controlFacet.connect(owner).setPartyBStrictDeallocation(hedger.address, true))
				.to.emit(context.controlFacet, "SetPartyBStrictDeallocation")
				.withArgs(hedger.address, true)

			expect(await context.viewFacet.isPartyBStrictDeallocationEnabled(hedger.address)).to.equal(true)
		})

		it("should reject callers without Party B manager role", async () => {
			await expect(context.controlFacet.connect(user2).setPartyBStrictDeallocation(hedger.address, true)).to.be.revertedWith(
				"Accessibility: Must have role",
			)
		})

		it("should reject a non-PartyB address", async () => {
			await expect(context.controlFacet.connect(owner).setPartyBStrictDeallocation(user2.address, true)).to.be.revertedWith(
				"ControlFacet: Address is not PartyB",
			)
		})
	})

	describe("SetPartyBBindable", () => {
		// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE, so no separate grant needed

		it("should fail to set non party B bindable", async () => {
			await expect(context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.user.address, true)).to.revertedWith(
				"ControlFacet: Address is not PartyB",
			)
		})

		it("should fail to unset non party B bindable", async () => {
			await expect(context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.user.address, false)).to.revertedWith(
				"ControlFacet: Address is not PartyB",
			)
		})

		it("should set party B bindable correctly", async () => {
			await expect(context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)).not.reverted
			expect(await context.viewFacet.isBindable(context.signers.hedger.address)).to.be.true
		})

		it("should unset party B bindable correctly", async () => {
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
			await expect(context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, false)).not.reverted
			expect(await context.viewFacet.isBindable(context.signers.hedger.address)).to.be.false
		})

		it("should allow setting bindable multiple times", async () => {
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
			await expect(context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)).not.reverted
			expect(await context.viewFacet.isBindable(context.signers.hedger.address)).to.be.true
		})

		it("should allow unsetting unbindable party B", async () => {
			await expect(context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, false)).not.reverted
			expect(await context.viewFacet.isBindable(context.signers.hedger.address)).to.be.false
		})
	})
}
