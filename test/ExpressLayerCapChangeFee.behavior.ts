import { expect } from "chai"

import { deployExpressProvider } from "../tasks/deploy/expressWithdrawLayerDiamond.js"
import { initializeFixture } from "./Initialize.fixture.js"
import connection, { ethers, hre } from "./helpers/hardhat-connection.js"
import { RunContext } from "./models/RunContext.js"

const SETTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE"))

export function shouldBehaveLikeExpressLayerCapChangeFee(): void {
	async function deployFixture() {
		const context: RunContext = await initializeFixture()

		const allSigners = await ethers.getSigners()
		const deployer = context.signers.admin
		const affiliateA = allSigners[13]
		const affiliateB = allSigners[14]
		const feeReceiver = allSigners[15]
		const nonAffiliate = allSigners[16]
		const accountLayer = await ethers.deployContract("MockExpressAccountLayer")

		const expressProvider = await deployExpressProvider(hre, connection, {
			admin: deployer.address,
			symmio: context.diamond,
			collateral: await context.collateral.getAddress(),
			accountLayer: await accountLayer.getAddress(),
		})

		// Deploy a separate ERC20 as the cap-change fee token (distinct from collateral).
		const feeToken = await (await ethers.getContractFactory("FakeStablecoin")).connect(deployer).deploy()
		await feeToken.waitForDeployment()

		// Mint and pre-approve fee token for both affiliates (enough for several paid changes).
		const feeBalance = 1_000_000n * 10n ** 18n
		await feeToken.mint(affiliateA.address, feeBalance)
		await feeToken.mint(affiliateB.address, feeBalance)
		await feeToken.connect(affiliateA).approve(await expressProvider.getAddress(), ethers.MaxUint256)
		await feeToken.connect(affiliateB).approve(await expressProvider.getAddress(), ethers.MaxUint256)

		return {
			context,
			deployer,
			affiliateA,
			affiliateB,
			feeReceiver,
			nonAffiliate,
			expressProvider,
			feeToken,
			feeBalance,
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	//                        DORMANT (DEFAULT) STATE
	// ═══════════════════════════════════════════════════════════════════

	describe("Dormant (unconfigured)", function () {
		it("allows unlimited self increases when quota is unconfigured", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)

			// Quota unconfigured (windowDuration == 0). Many increases should all succeed fee-free.
			for (let i = 1; i <= 5; i++) {
				await expressProvider.connect(affiliateA).setMyCreditLineConfig(BigInt(i) * 100n * 10n ** 18n, 100n * BigInt(i))
			}

			const [count] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(count).to.equal(0n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                           DECREASE IS FREE
	// ═══════════════════════════════════════════════════════════════════

	describe("Decrease semantics", function () {
		it("decreasing both maxDebt and maxDebtBps is free and does not count toward quota", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(2n, 86400n)

			// Seed affiliate (0 → 500 is a decrease from "uncapped" to "500")
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 5000n)
			const [countBefore] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countBefore).to.equal(0n)

			// Tighten further — still a decrease, counter unchanged
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n)

			const [countAfter] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countAfter).to.equal(0n)

			const info = await expressProvider.creditLineAffiliateMaxDebt(affiliateA.address)
			expect(info).to.equal(200n * 10n ** 18n)
		})

		it("decreasing one dim while keeping the other equal is a decrease (free)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(1n, 86400n)

			await expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 5000n)
			const [countBefore] = await expressProvider.capChangeAffiliateState(affiliateA.address)

			// Lower maxDebtBps, keep maxDebt constant — still a decrease
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 3000n)
			const [countAfter] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countAfter).to.equal(countBefore)
		})

		it("loosening one dim while tightening the other counts as increase", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(5n, 86400n)

			// Seed (decrease from 0 → 500)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 5000n)
			const [countBefore] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countBefore).to.equal(0n)

			// maxDebt down (tighter) but maxDebtBps up (looser) — overall an increase
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(300n * 10n ** 18n, 7000n)
			const [countAfter] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countAfter).to.equal(1n)
		})

		it("going from uncapped (0) to a finite cap is a decrease", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(1n, 86400n)

			// First a non-zero set so we can go 0→finite on a later step
			// Start from 0 (default) — set to finite → treated as decrease (from infinity)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 5000n)
			const [count] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(count).to.equal(0n)
		})

		it("going from finite to uncapped (0) counts as increase", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(5n, 86400n)

			await expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 5000n)
			const [countBefore] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countBefore).to.equal(0n) // was a decrease (0→500)

			// Now go to 0 maxDebt — that is the affiliate removing their self-cap, a loosening
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(0n, 5000n)
			const [countAfter] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countAfter).to.equal(1n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                       FREE QUOTA / PAID QUOTA
	// ═══════════════════════════════════════════════════════════════════

	describe("Quota + fee", function () {
		it("first N increases within quota are free, (N+1)th charges fee", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer, feeToken, feeReceiver } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(2n, 86400n)
			const feeAmount = 50_000n * 10n ** 18n
			await expressProvider.connect(deployer).setCapChangeFeeConfig(await feeToken.getAddress(), feeAmount, feeReceiver.address)

			const before = await feeToken.balanceOf(feeReceiver.address)

			// Seed: 0→100 (decrease, free)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(100n * 10n ** 18n, 1000n)
			// 1st increase (free)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n)
			// 2nd increase (free)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(300n * 10n ** 18n, 3000n)

			expect(await feeToken.balanceOf(feeReceiver.address)).to.equal(before)

			// 3rd increase (paid)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(400n * 10n ** 18n, 4000n)

			expect(await feeToken.balanceOf(feeReceiver.address)).to.equal(before + feeAmount)

			const [count] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(count).to.equal(3n)
		})

		it("reverts CapChangeFeeNotConfigured when quota set but fee unset", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(1n, 86400n)

			await expressProvider.connect(affiliateA).setMyCreditLineConfig(100n * 10n ** 18n, 1000n) // seed decrease
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n) // free 1

			await expect(expressProvider.connect(affiliateA).setMyCreditLineConfig(300n * 10n ** 18n, 3000n)).to.be.revertedWithCustomError(
				expressProvider,
				"CapChangeFeeNotConfigured",
			)
		})

		it("reverts on insufficient allowance when fee is required", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer, feeToken, feeReceiver } = fixture

			// Revoke allowance
			await feeToken.connect(affiliateA).approve(await expressProvider.getAddress(), 0n)

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(1n, 86400n)
			await expressProvider.connect(deployer).setCapChangeFeeConfig(await feeToken.getAddress(), 50n * 10n ** 18n, feeReceiver.address)

			await expressProvider.connect(affiliateA).setMyCreditLineConfig(100n * 10n ** 18n, 1000n) // seed decrease
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n) // free 1

			// Paid (2nd increase beyond quota of 1) — will try to pull tokens but no allowance
			await expect(expressProvider.connect(affiliateA).setMyCreditLineConfig(300n * 10n ** 18n, 3000n)).to.be.reverted
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                         EPOCH RESET
	// ═══════════════════════════════════════════════════════════════════

	describe("Epoch reset", function () {
		it("counter resets after windowDuration elapses", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer, feeToken, feeReceiver } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(1n, 3600n) // 1 free per hour
			await expressProvider.connect(deployer).setCapChangeFeeConfig(await feeToken.getAddress(), 50n * 10n ** 18n, feeReceiver.address)

			// Seed decrease
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(100n * 10n ** 18n, 1000n)

			// 1st increase (free)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n)
			const [countPre] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countPre).to.equal(1n)

			// Advance past windowDuration
			await ethers.provider.send("evm_increaseTime", [3601])
			await ethers.provider.send("evm_mine", [])

			// 2nd increase after reset — free again (not paid)
			const receiverBefore = await feeToken.balanceOf(feeReceiver.address)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(300n * 10n ** 18n, 3000n)
			expect(await feeToken.balanceOf(feeReceiver.address)).to.equal(receiverBefore)

			const [countPost] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(countPost).to.equal(1n)
		})

		it("view getter reports full quota available once the window has elapsed", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(3n, 3600n)

			await expressProvider.connect(affiliateA).setMyCreditLineConfig(100n * 10n ** 18n, 1000n) // decrease
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n) // free 1

			const [, , remainingMid] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(remainingMid).to.equal(2n)

			await ethers.provider.send("evm_increaseTime", [3601])
			await ethers.provider.send("evm_mine", [])

			const [, , remainingAfter] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(remainingAfter).to.equal(3n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                          EDGE GUARDS
	// ═══════════════════════════════════════════════════════════════════

	describe("Edge cases", function () {
		it("reverts NoOpCapChange when values are unchanged", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 5000n)

			await expect(expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 5000n)).to.be.revertedWithCustomError(
				expressProvider,
				"NoOpCapChange",
			)
		})

		it("enforces protocol cap on self-service path", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 1_000n * 10n ** 18n, 1_000n)

			await expect(expressProvider.connect(affiliateA).setMyCreditLineConfig(2_000n * 10n ** 18n, 500n)).to.be.revertedWithCustomError(
				expressProvider,
				"AffiliateLimitExceedsProtocol",
			)
		})

		it("admin bypass via setCreditLineAffiliateConfig still works without fees or counter", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer, feeToken, feeReceiver } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(1n, 86400n)
			await expressProvider.connect(deployer).setCapChangeFeeConfig(await feeToken.getAddress(), 50n * 10n ** 18n, feeReceiver.address)

			const receiverBefore = await feeToken.balanceOf(feeReceiver.address)
			// Admin makes many changes
			for (let i = 1; i <= 5; i++) {
				await expressProvider.connect(deployer).setCreditLineAffiliateConfig(affiliateA.address, BigInt(i) * 100n * 10n ** 18n, BigInt(i) * 100n)
			}

			// No fees pulled, counter stays 0
			expect(await feeToken.balanceOf(feeReceiver.address)).to.equal(receiverBefore)
			const [count] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			expect(count).to.equal(0n)
		})

		it("non-affiliate call only affects the caller's own affiliate slot", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, nonAffiliate, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(500n * 10n ** 18n, 5000n)

			// nonAffiliate calls — affects their OWN slot (no permission to touch affiliateA).
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(nonAffiliate.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(nonAffiliate).setMyCreditLineConfig(42n * 10n ** 18n, 42n)

			// affiliateA's config untouched
			expect(await expressProvider.creditLineAffiliateMaxDebt(affiliateA.address)).to.equal(500n * 10n ** 18n)
			// nonAffiliate's own config set
			expect(await expressProvider.creditLineAffiliateMaxDebt(nonAffiliate.address)).to.equal(42n * 10n ** 18n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                        MULTI-AFFILIATE ISOLATION
	// ═══════════════════════════════════════════════════════════════════

	describe("Isolation", function () {
		it("affiliates have independent counters and epochs", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, affiliateB, deployer } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateB.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(2n, 86400n)

			// Affiliate A performs seed + 2 increases
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(100n * 10n ** 18n, 1000n)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(300n * 10n ** 18n, 3000n)

			const [countA] = await expressProvider.capChangeAffiliateState(affiliateA.address)
			const [countB] = await expressProvider.capChangeAffiliateState(affiliateB.address)
			expect(countA).to.equal(2n)
			expect(countB).to.equal(0n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                        VIEW GETTERS
	// ═══════════════════════════════════════════════════════════════════

	describe("View getters", function () {
		it("reports fee and quota config round-trip", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, feeToken, feeReceiver } = fixture

			await expressProvider.connect(deployer).setCapChangeFeeConfig(await feeToken.getAddress(), 50n * 10n ** 18n, feeReceiver.address)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(2n, 86400n)

			const [token, amount, recv] = await expressProvider.capChangeFeeConfig()
			expect(token).to.equal(await feeToken.getAddress())
			expect(amount).to.equal(50n * 10n ** 18n)
			expect(recv).to.equal(feeReceiver.address)

			const [maxFree, windowDuration] = await expressProvider.capChangeQuotaConfig()
			expect(maxFree).to.equal(2n)
			expect(windowDuration).to.equal(86400n)
		})

		it("fee receiver change takes effect on next paid call", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer, feeToken, feeReceiver, nonAffiliate } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(1n, 86400n)
			await expressProvider.connect(deployer).setCapChangeFeeConfig(await feeToken.getAddress(), 50n * 10n ** 18n, feeReceiver.address)

			await expressProvider.connect(affiliateA).setMyCreditLineConfig(100n * 10n ** 18n, 1000n) // seed decrease
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n) // free 1

			// Rotate receiver, then make a paid change
			await expressProvider.connect(deployer).setCapChangeFeeConfig(await feeToken.getAddress(), 50n * 10n ** 18n, nonAffiliate.address)
			const before = await feeToken.balanceOf(nonAffiliate.address)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(300n * 10n ** 18n, 3000n)
			expect(await feeToken.balanceOf(nonAffiliate.address)).to.equal(before + 50n * 10n ** 18n)
		})

		it("quota config update mid-window affects subsequent calls", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliateA, deployer, feeToken, feeReceiver } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateA.address, 10_000n * 10n ** 18n, 10_000n)
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(2n, 86400n)
			await expressProvider.connect(deployer).setCapChangeFeeConfig(await feeToken.getAddress(), 50n * 10n ** 18n, feeReceiver.address)

			await expressProvider.connect(affiliateA).setMyCreditLineConfig(100n * 10n ** 18n, 1000n) // seed decrease
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(200n * 10n ** 18n, 2000n) // free 1
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(300n * 10n ** 18n, 3000n) // free 2

			// Next increase would be paid, but admin bumps quota
			await expressProvider.connect(deployer).setCapChangeQuotaConfig(5n, 86400n)

			const before = await feeToken.balanceOf(feeReceiver.address)
			await expressProvider.connect(affiliateA).setMyCreditLineConfig(400n * 10n ** 18n, 4000n)
			expect(await feeToken.balanceOf(feeReceiver.address)).to.equal(before) // free
		})
	})
}
