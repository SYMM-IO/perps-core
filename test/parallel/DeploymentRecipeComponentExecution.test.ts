import { expect } from "chai"
import fs from "node:fs"
import path from "node:path"

import {
	assertReadOnlySignerConfiguration,
	assertComponentStatusCheckpointBinding,
	assertComponentStatusReportBinding,
	inspectComponentStatus,
} from "../../tasks/deploy/checkComponent.js"
import { getCheckpointPath, setCheckpointSimulated } from "../../tasks/deploy/checkpoint.js"
import { executeComponentDeployment, resolveExpressProviderConfig } from "../../tasks/deploy/componentDeployment.js"
import { componentCheckpointScope, type CoreDependencyReport } from "../../tasks/deploy/deploymentRecipe.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

describe("deployment recipe standalone component execution", function () {
	const recipeName = "component-engine-test"
	const reportDir = path.resolve(`tasks/data/31337-fork/components/${recipeName}`)
	const checkpointFiles = ["partyB", "symbolManager", "expressProvider", "gaslessLayer"].map(component => {
		setCheckpointSimulated(true)
		return path.resolve(
			getCheckpointPath(31337, componentCheckpointScope(recipeName, component as "partyB" | "symbolManager" | "expressProvider" | "gaslessLayer")),
		)
	})

	afterEach(function () {
		setCheckpointSimulated(false)
		for (const file of checkpointFiles) fs.rmSync(file, { force: true })
		fs.rmSync(reportDir, { recursive: true, force: true })
	})

	it("allows inherent unlocked accounts only for read-only localhost component checks", function () {
		expect(() => assertReadOnlySignerConfiguration("local", 20)).not.to.throw()
		expect(() => assertReadOnlySignerConfiguration("fork", 1)).to.throw("expected zero configured signers")
		expect(() => assertReadOnlySignerConfiguration("live", 1)).to.throw("expected zero configured signers")
	})

	it("deploys, wires, verifies post-state, and durably reports PartyB and SymbolManager independently", async function () {
		const context = await loadFixture(initializeFixture)
		const [admin, partyBOperator] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const coreReport: CoreDependencyReport = {
			deploymentId: "fixture-core",
			deployerAddress: admin.address,
			network: networkName,
			chainId: 31337,
			lifecycle: "complete",
			checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			config: { admin: admin.address },
			addresses: {
				diamond: context.diamond,
				instantLayer: await context.instantLayer.getAddress(),
			},
		}
		const target = { name: networkName, chainId: 31337, mode: "local" as const }

		const partyBInput = {
			recipeName,
			recipePath: "/tmp/component-engine-test.json",
			recipeDigest: "partyB-digest",
			target,
			component: "partyB",
			componentConfig: { mode: "deploy", operators: [partyBOperator.address], adlEnabled: true, admin: admin.address },
			coreReport,
			coreReportPath: "/tmp/core-report.json",
			fresh: false,
			verify: false,
		} as const
		const partyB = await executeComponentDeployment(hre, partyBInput)
		expect(partyB.report.lifecycle).to.equal("complete")
		expect(partyB.report.health.status).to.equal("passed")
		expect(partyB.report.verification.records).to.have.length(2)
		expect(await context.viewFacet.isPartyB(partyB.report.address)).to.equal(true)
		expect(await context.instantLayer.registeredPartyBs(partyB.report.address)).to.equal(true)
		const partyBContract = await ethers.getContractAt("SymmioPartyB", partyB.report.address!)
		expect(partyB.report.config).to.deep.equal({ admin: admin.address, operators: [partyBOperator.address], adlEnabled: true })
		expect(await partyBContract.signer()).to.equal(ethers.ZeroAddress)
		expect(await partyBContract.hasRole(await partyBContract.TRUSTED_ROLE(), partyBOperator.address)).to.equal(true)
		expect(
			assertComponentStatusReportBinding(partyB.report, {
				component: "partyB",
				recipeName,
				recipePath: partyBInput.recipePath,
				recipeDigest: partyBInput.recipeDigest,
				network: networkName,
				chainId: 31337,
				live: false,
				config: { admin: admin.address, operators: [partyBOperator.address], adlEnabled: true },
				coreReport,
				coreReportPath: partyBInput.coreReportPath,
			}).deploymentId,
		).to.equal(partyB.report.deploymentId)
		const resumedPartyB = await executeComponentDeployment(hre, partyBInput)
		expect(resumedPartyB.report.address).to.equal(partyB.report.address)
		const freshPartyB = await executeComponentDeployment(hre, { ...partyBInput, fresh: true })
		expect(freshPartyB.report.deploymentId).to.not.equal(partyB.report.deploymentId)
		expect(freshPartyB.report.address).to.not.equal(partyB.report.address)
		const archivedPartyB = JSON.parse(fs.readFileSync(path.join(reportDir, "history", `partyB-${partyB.report.deploymentId}-report.json`), "utf8"))
		expect(archivedPartyB.deploymentId).to.equal(partyB.report.deploymentId)
		expect(archivedPartyB.address).to.equal(partyB.report.address)

		const symbolManager = await executeComponentDeployment(hre, {
			recipeName,
			recipePath: "/tmp/component-engine-test.json",
			recipeDigest: "symbol-manager-digest",
			target,
			component: "symbolManager",
			componentConfig: { mode: "deploy", operator: admin.address, admin: admin.address },
			coreReport,
			coreReportPath: "/tmp/core-report.json",
			fresh: false,
			verify: false,
		})
		expect(symbolManager.report.lifecycle).to.equal("complete")
		expect(symbolManager.report.health.status).to.equal("passed")
		expect(symbolManager.report.verification.records).to.have.length(1)
		const manager = await ethers.getContractAt("SymmioSymbolManager", symbolManager.report.address!)
		expect(await manager.symmioAddress()).to.equal(context.diamond)
	})

	it("deploys, configures, registers, and hands over an ExpressProvider, then resumes without redeploying", async function () {
		const context = await loadFixture(initializeFixture)
		const [admin, operator, signer, affiliate] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const coreReport: CoreDependencyReport = {
			deploymentId: "fixture-core-express",
			deployerAddress: admin.address,
			network: networkName,
			chainId: 31337,
			lifecycle: "complete",
			checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			config: { admin: admin.address },
			addresses: {
				diamond: context.diamond,
				accountLayerDiamond: context.accountLayerDiamond,
				instantLayer: await context.instantLayer.getAddress(),
			},
		}
		const input = {
			recipeName,
			recipePath: "/tmp/component-engine-test.json",
			recipeDigest: "express-digest",
			target: { name: networkName, chainId: 31337, mode: "local" as const },
			component: "expressProvider",
			componentConfig: {
				mode: "deploy",
				admin: admin.address,
				registerOnCore: true,
				securityWindow: 30,
				tolerancePeriod: 90,
				creditLine: { signatureVerifier: "fromCore", muonAppId: "42", muonFreshnessWindow: 300 },
				roles: { OPERATOR_ROLE: [operator.address], LOCKER_ROLE: [operator.address], SIGNER_ROLE: [signer.address] },
				affiliates: [
					{
						address: affiliate.address,
						feeRate: "25",
						operatorFee: "10",
						maxDebt: "1000000",
						maxDebtBps: 4000,
						validators: [signer.address],
						minValidatorSignatures: 1,
						validatorApprovalTimeout: 45,
					},
				],
			},
			coreReport,
			coreReportPath: "/tmp/core-report.json",
			fresh: false,
			verify: false,
		} as const

		const express = await executeComponentDeployment(hre, input)
		expect(express.report.health.status).to.equal("passed")
		expect(express.report.lifecycle).to.equal("complete")
		// DiamondCutFacet + Diamond + Init + 6 facets.
		expect(express.report.verification.records).to.have.length(9)

		const view = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/View/ViewFacet.sol:ViewFacet", express.report.address!)
		const control = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet", express.report.address!)
		const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))

		expect(await view.symmio()).to.equal(context.diamond)
		expect(await view.accountLayer()).to.equal(context.accountLayerDiamond)
		expect(await view.creditLineSignatureVerifier()).to.equal(await context.viewFacet.getSignatureVerifier())
		expect(await view.creditLineMuonAppId()).to.equal(42n)
		expect(await view.creditLineMuonFreshnessWindow()).to.equal(300n)
		expect(await view.securityWindow()).to.equal(30n)
		expect(await view.tolerancePeriod()).to.equal(90n)
		expect(await view["hasRole(address,bytes32)"](operator.address, roleHash("OPERATOR_ROLE"))).to.equal(true)
		expect(await view["hasRole(address,bytes32)"](signer.address, roleHash("SIGNER_ROLE"))).to.equal(true)

		const affiliateConfig = await view.affiliateConfigs(affiliate.address)
		expect(affiliateConfig[0]).to.equal(25n)
		expect(affiliateConfig[1]).to.equal(10n)
		expect(await view.creditLineProtocolMaxDebt(affiliate.address)).to.equal(1000000n)
		expect(await view.creditLineProtocolMaxDebtBps(affiliate.address)).to.equal(4000n)
		expect(await view.isValidator(affiliate.address, signer.address)).to.equal(true)
		expect(await view.minValidatorSignatures(affiliate.address)).to.equal(1n)
		expect(await view.validatorApprovalTimeout(affiliate.address)).to.equal(45n)

		// The provider must be usable by core, and the admin must own it.
		expect(await context.viewFacet.isExpressProviderRegistered(express.report.address)).to.equal(true)
		expect(await control.owner()).to.equal(admin.address)

		// Resume must recover the same diamond rather than deploying a second one.
		const resumed = await executeComponentDeployment(hre, input)
		expect(resumed.report.address).to.equal(express.report.address)
		expect(resumed.report.health.status).to.equal("passed")
	})

	it("deploys, configures, wires, verifies, and resumes GaslessLayer as a standalone component", async function () {
		const context = await loadFixture(initializeFixture)
		const [admin, relayer, treasury] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const input = {
			recipeName,
			recipePath: "/tmp/component-engine-test.json",
			recipeDigest: "gasless-digest",
			target: { name: networkName, chainId: 31337, mode: "local" as const },
			component: "gaslessLayer",
			componentConfig: {
				mode: "deploy",
				admin: admin.address,
				treasury: treasury.address,
				depositFee: "2",
				minimumDeposit: "5",
				defaultSelectorFee: "7",
				dailyFreeOpsLimit: "3",
				revertWhenFreeQuotaExhausted: false,
				dailySponsoredNativeLimit: "10000000000000000",
				revertWhenNativeSponsorLimitExhausted: true,
				maxNativeGasTopUpAmount: "1000000000000000",
				nativeGasTopUpFeeBps: 250,
				relayers: [relayer.address],
				selectorFees: [{ selector: "0x12345678", configured: true, amount: "11" }],
			},
			coreReport: {
				deploymentId: "fixture-core-gasless",
				deployerAddress: admin.address,
				network: networkName,
				chainId: 31337,
				lifecycle: "complete",
				checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
				config: { admin: admin.address },
				addresses: {
					diamond: context.diamond,
					accountLayerDiamond: context.accountLayerDiamond,
					instantLayer: await context.instantLayer.getAddress(),
				},
			} as CoreDependencyReport,
			coreReportPath: "/tmp/core-report.json",
			fresh: false,
			verify: false,
		} as const

		const deployed = await executeComponentDeployment(hre, input)
		expect(deployed.report.lifecycle).to.equal("complete")
		expect(deployed.report.health.status).to.equal("passed")
		expect(deployed.report.verification.records).to.have.length(6)
		expect(deployed.report.implementation).to.properAddress

		const layer = await ethers.getContractAt("GaslessLayer", deployed.report.address!)
		expect(await layer.core()).to.equal(context.diamond)
		expect(await layer.accountLayer()).to.equal(context.accountLayerDiamond)
		expect(await layer.instantLayer()).to.equal(await context.instantLayer.getAddress())
		expect(await layer.treasury()).to.equal(treasury.address)
		expect(await layer.defaultSelectorFee()).to.equal(7n)
		expect(await layer.dailyFreeOpsLimit()).to.equal(3n)
		expect(await layer.revertWhenNativeSponsorLimitExhausted()).to.equal(true)
		expect(await layer.nativeGasTopUpFeeBps()).to.equal(250n)
		expect(await layer.hasRole(await layer.RELAYER_ROLE(), relayer.address)).to.equal(true)
		expect(await context.viewFacet.isOperationalFeeCharger(deployed.report.address)).to.equal(true)
		expect(await context.instantLayer.hasRole(await context.instantLayer.OPERATOR_ROLE(), deployed.report.address)).to.equal(true)
		expect(await layer.selectorFeeConfigs("0x12345678")).to.deep.equal([true, 11n])

		const resumed = await executeComponentDeployment(hre, input)
		expect(resumed.report.address).to.equal(deployed.report.address)
		expect(resumed.report.implementation).to.equal(deployed.report.implementation)
	})

	it("rejects an Express credit verifier without the forward-compatible capability API", async function () {
		const context = await loadFixture(initializeFixture)
		const [admin] = await ethers.getSigners()
		const legacyVerifier = await ethers.deployContract("LegacyMuonSignatureVerifier")
		await legacyVerifier.waitForDeployment()

		try {
			await resolveExpressProviderConfig(
				ethers,
				{
					admin: admin.address,
					creditLine: {
						// It predates the explicit capability API, so support cannot be proven.
						signatureVerifier: await legacyVerifier.getAddress(),
						muonAppId: "1",
						muonFreshnessWindow: 60,
					},
				},
				{ core: context.diamond, accountLayer: context.accountLayerDiamond, admin: admin.address },
				admin.address,
			)
			expect.fail("Expected the legacy verifier compatibility probe to reject")
		} catch (error) {
			expect((error as Error).message).to.include("does not support MuonFunction.ExpressCredit (index 8)")
		}
	})

	it("rejects an incompatible verifier before an Express patch and accepts a forward-compatible verifier", async function () {
		const context = await loadFixture(initializeFixture)
		const [admin] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const coreReport: CoreDependencyReport = {
			deploymentId: "fixture-core-express-verifier-patch",
			deployerAddress: admin.address,
			network: networkName,
			chainId: 31337,
			lifecycle: "complete",
			checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			config: { admin: admin.address },
			addresses: {
				diamond: context.diamond,
				accountLayerDiamond: context.accountLayerDiamond,
				instantLayer: await context.instantLayer.getAddress(),
			},
		}
		const shared = {
			recipeName,
			recipePath: "/tmp/component-engine-test.json",
			target: { name: networkName, chainId: 31337, mode: "local" as const },
			component: "expressProvider" as const,
			coreReport,
			coreReportPath: "/tmp/core-report.json",
			fresh: false,
			verify: false,
		}

		const deployed = await executeComponentDeployment(hre, {
			...shared,
			recipeDigest: "express-verifier-patch-deploy",
			componentConfig: { mode: "deploy", admin: admin.address },
		})
		const address = deployed.report.address!
		const view = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/View/ViewFacet.sol:ViewFacet", address)

		const legacyVerifier = await ethers.deployContract("LegacyMuonSignatureVerifier")
		await legacyVerifier.waitForDeployment()
		let failure: Error | undefined
		try {
			await executeComponentDeployment(hre, {
				...shared,
				recipeDigest: "express-incompatible-verifier-patch",
				componentConfig: {
					mode: "reuse",
					address,
					admin: admin.address,
					creditLine: { signatureVerifier: await legacyVerifier.getAddress(), muonAppId: "1", muonFreshnessWindow: 60 },
				},
			})
		} catch (error) {
			failure = error as Error
		}
		expect(failure?.message).to.include("does not support MuonFunction.ExpressCredit (index 8)")
		// Resolution fails before a setter transaction or Safe action can alter the provider.
		expect(await view.creditLineSignatureVerifier()).to.equal(ethers.ZeroAddress)

		const compatibleVerifier = await ethers.deployContract("MockMuonSignatureVerifier")
		await compatibleVerifier.waitForDeployment()
		const patched = await executeComponentDeployment(hre, {
			...shared,
			recipeDigest: "express-compatible-verifier-patch",
			componentConfig: {
				mode: "reuse",
				address,
				admin: admin.address,
				creditLine: { signatureVerifier: await compatibleVerifier.getAddress(), muonAppId: "1", muonFreshnessWindow: 60 },
			},
		})
		expect(patched.report.lifecycle).to.equal("complete")
		expect(await view.creditLineSignatureVerifier()).to.equal(await compatibleVerifier.getAddress())
	})

	it("deploys an ExpressProvider with every setup section deferred, writing none of them on-chain", async function () {
		const context = await loadFixture(initializeFixture)
		const [admin] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const express = await executeComponentDeployment(hre, {
			recipeName,
			recipePath: "/tmp/component-engine-test.json",
			recipeDigest: "express-deferred-digest",
			target: { name: networkName, chainId: 31337, mode: "local" as const },
			component: "expressProvider",
			// No creditLine, roles, affiliates, or registerOnCore: the diamond is cut and handed over,
			// and nothing else is configured until a later reuse patch supplies it.
			componentConfig: { mode: "deploy", admin: admin.address },
			coreReport: {
				deploymentId: "fixture-core-express-deferred",
				deployerAddress: admin.address,
				network: networkName,
				chainId: 31337,
				lifecycle: "complete",
				checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
				config: { admin: admin.address },
				addresses: {
					diamond: context.diamond,
					accountLayerDiamond: context.accountLayerDiamond,
					instantLayer: await context.instantLayer.getAddress(),
				},
			} as CoreDependencyReport,
			coreReportPath: "/tmp/core-report.json",
			fresh: false,
			verify: false,
		})

		expect(express.report.health.status).to.equal("passed")
		expect(express.report.lifecycle).to.equal("complete")

		const view = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/View/ViewFacet.sol:ViewFacet", express.report.address!)
		const control = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet", express.report.address!)

		// An unset verifier is what keeps reserveDebt reverting with CreditLineNotConfigured.
		expect(await view.creditLineSignatureVerifier()).to.equal(ethers.ZeroAddress)
		expect(await view.creditLineMuonAppId()).to.equal(0n)
		// Nothing routes to it and no key can sign an offer, so the provider is inert but owned.
		expect(await context.viewFacet.isExpressProviderRegistered(express.report.address)).to.equal(false)
		expect(await view["hasRole(address,bytes32)"](admin.address, ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ROLE")))).to.equal(false)
		expect(await control.owner()).to.equal(admin.address)
		// Init's own defaults survive an omitted securityWindow/tolerancePeriod.
		expect(await view.securityWindow()).to.equal(20n)
		expect(await view.tolerancePeriod()).to.equal(60n)
	})

	it("keeps an ExpressProvider run pending until its admin accepts ownership and core registers it", async function () {
		const context = await loadFixture(initializeFixture)
		const [deployer, futureAdmin, operator] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const coreReport: CoreDependencyReport = {
			deploymentId: "fixture-core-express-pending",
			deployerAddress: deployer.address,
			network: networkName,
			chainId: 31337,
			lifecycle: "complete",
			checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			config: { admin: deployer.address },
			addresses: {
				diamond: context.diamond,
				accountLayerDiamond: context.accountLayerDiamond,
				instantLayer: await context.instantLayer.getAddress(),
			},
		}
		const express = await executeComponentDeployment(hre, {
			recipeName,
			recipePath: "/tmp/component-engine-test.json",
			recipeDigest: "express-pending-digest",
			target: { name: networkName, chainId: 31337, mode: "local" as const },
			component: "expressProvider",
			// A separate admin means ownership is a two-step handover that is not yet accepted.
			componentConfig: {
				mode: "deploy",
				admin: futureAdmin.address,
				registerOnCore: true,
				creditLine: { signatureVerifier: "fromCore", muonAppId: "1", muonFreshnessWindow: 120 },
				roles: { OPERATOR_ROLE: [operator.address] },
				affiliates: [{ address: operator.address, feeRate: "0", operatorFee: "0", maxDebt: "5", maxDebtBps: 100 }],
			},
			coreReport,
			coreReportPath: "/tmp/core-report.json",
			fresh: false,
			verify: false,
		})

		expect(express.report.lifecycle).to.equal("pending_handover")
		expect(express.report.health.status).to.equal("pending")
		expect(express.report.manualActions.map(action => action.description)).to.include(`Accept ExpressProvider ownership at ${express.report.address}`)

		const control = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet", express.report.address!)
		const view = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/View/ViewFacet.sol:ViewFacet", express.report.address!)
		// The deployer must retain no privilege once the final admin holds the Init roles.
		for (const role of ["SETTER_ROLE", "FEE_CLAIMER_ROLE", "WITHDRAWER_ROLE", "PAUSER_ROLE"]) {
			const hash = ethers.keccak256(ethers.toUtf8Bytes(role))
			expect(await view["hasRole(address,bytes32)"](futureAdmin.address, hash), `${role} for admin`).to.equal(true)
			expect(await view["hasRole(address,bytes32)"](deployer.address, hash), `${role} for deployer`).to.equal(false)
		}
		expect(await control.pendingOwner()).to.equal(futureAdmin.address)
	})

	it("patches a deployed ExpressProvider: updates settings, grants new holders, revokes removed ones", async function () {
		const context = await loadFixture(initializeFixture)
		const [admin, operator, signer, affiliate, newOperator] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const coreReport: CoreDependencyReport = {
			deploymentId: "fixture-core-express-patch",
			deployerAddress: admin.address,
			network: networkName,
			chainId: 31337,
			lifecycle: "complete",
			checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			config: { admin: admin.address },
			addresses: {
				diamond: context.diamond,
				accountLayerDiamond: context.accountLayerDiamond,
				instantLayer: await context.instantLayer.getAddress(),
			},
		}
		const target = { name: networkName, chainId: 31337, mode: "local" as const }
		const shared = { recipeName, recipePath: "/tmp/component-engine-test.json", target, coreReport, coreReportPath: "/tmp/core-report.json" }

		const deployed = await executeComponentDeployment(hre, {
			...shared,
			recipeDigest: "express-before-patch",
			component: "expressProvider",
			componentConfig: {
				mode: "deploy",
				admin: admin.address,
				registerOnCore: true,
				securityWindow: 30,
				creditLine: { signatureVerifier: "fromCore", muonAppId: "42", muonFreshnessWindow: 300 },
				roles: { OPERATOR_ROLE: [operator.address], LOCKER_ROLE: [operator.address], SIGNER_ROLE: [signer.address] },
				affiliates: [{ address: affiliate.address, feeRate: "25", operatorFee: "10", maxDebt: "1000000", maxDebtBps: 4000 }],
			},
			fresh: false,
			verify: false,
		})
		expect(deployed.report.lifecycle).to.equal("complete")
		const address = deployed.report.address!

		// The patch: rotate the operator, drop LOCKER entirely, raise the security window.
		// Affiliates are NOT declared, so that whole section must stay untouched.
		const patchInput = {
			...shared,
			recipeDigest: "express-patch-1",
			component: "expressProvider",
			componentConfig: {
				mode: "reuse",
				address,
				admin: admin.address,
				securityWindow: 45,
				roles: { OPERATOR_ROLE: [newOperator.address], SIGNER_ROLE: [signer.address] },
			},
			fresh: false,
			verify: false,
		} as const
		const patched = await executeComponentDeployment(hre, patchInput)
		expect(patched.report.mode).to.equal("patch")
		expect(patched.report.lifecycle).to.equal("complete")
		expect(patched.report.verification.policy).to.equal("not_applicable")
		const boundPatch = assertComponentStatusReportBinding(patched.report, {
			component: "expressProvider",
			recipeName,
			recipePath: shared.recipePath,
			recipeDigest: patchInput.recipeDigest,
			network: networkName,
			chainId: 31337,
			live: false,
			config: { admin: admin.address },
			coreReport,
			coreReportPath: shared.coreReportPath,
		})
		const patchScope = componentCheckpointScope(recipeName, "expressProvider")
		const patchCheckpoint = JSON.parse(fs.readFileSync(path.resolve(getCheckpointPath(31337, patchScope)), "utf8"))
		expect(
			assertComponentStatusCheckpointBinding(patchCheckpoint, boundPatch, {
				component: "expressProvider",
				scope: patchScope,
				network: networkName,
				chainId: 31337,
			}).deploymentId,
		).to.equal(patched.report.deploymentId)

		const view = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/View/ViewFacet.sol:ViewFacet", address)
		const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
		expect(await view["hasRole(address,bytes32)"](newOperator.address, roleHash("OPERATOR_ROLE")), "new operator granted").to.equal(true)
		expect(await view["hasRole(address,bytes32)"](operator.address, roleHash("OPERATOR_ROLE")), "old operator revoked").to.equal(false)
		expect(await view["hasRole(address,bytes32)"](operator.address, roleHash("LOCKER_ROLE")), "dropped role revoked").to.equal(false)
		expect(await view["hasRole(address,bytes32)"](signer.address, roleHash("SIGNER_ROLE")), "kept holder untouched").to.equal(true)
		expect(await view.securityWindow()).to.equal(45n)
		// Untouched sections survive on chain and in the stored baseline.
		expect(await view.creditLineProtocolMaxDebt(affiliate.address)).to.equal(1000000n)
		const applied = patched.report.config.expressProvider!
		expect(applied.roles).to.deep.equal({ OPERATOR_ROLE: [newOperator.address], SIGNER_ROLE: [signer.address] })
		expect(applied.affiliates?.[0]?.address).to.equal(affiliate.address)
		expect(applied.muonAppId).to.equal("42")

		// Same patch again: nothing to change, still complete, still no new deployment.
		const again = await executeComponentDeployment(hre, patchInput)
		expect(again.report.lifecycle).to.equal("complete")
		expect(again.report.address).to.equal(address)
		expect(again.report.health.checks.some(check => /already matches/.test(check.check))).to.equal(true)
	})

	it("Safe action-only patching broadcasts nothing, queues exact calldata, and completes after execution", async function () {
		const context = await loadFixture(initializeFixture)
		const [deployer, operator, signer, affiliate, newOperator, futureOwner] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const coreReport: CoreDependencyReport = {
			deploymentId: "fixture-core-express-patch-authority",
			deployerAddress: deployer.address,
			network: networkName,
			chainId: 31337,
			lifecycle: "complete",
			checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			config: { admin: deployer.address },
			addresses: {
				diamond: context.diamond,
				accountLayerDiamond: context.accountLayerDiamond,
				instantLayer: await context.instantLayer.getAddress(),
			},
		}
		const target = { name: networkName, chainId: 31337, mode: "local" as const }
		const shared = { recipeName, recipePath: "/tmp/component-engine-test.json", target, coreReport, coreReportPath: "/tmp/core-report.json" }

		const deployed = await executeComponentDeployment(hre, {
			...shared,
			recipeDigest: "express-authority-deploy",
			component: "expressProvider",
			componentConfig: {
				mode: "deploy",
				admin: deployer.address,
				registerOnCore: true,
				creditLine: { signatureVerifier: "fromCore", muonAppId: "7", muonFreshnessWindow: 120 },
				roles: { OPERATOR_ROLE: [operator.address], SIGNER_ROLE: [signer.address] },
				affiliates: [{ address: affiliate.address, feeRate: "0", operatorFee: "0", maxDebt: "5", maxDebtBps: 100 }],
			},
			fresh: false,
			verify: false,
		})
		const address = deployed.report.address!

		// Hand the diamond to another owner, exactly as a real handover would.
		const control = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet", address)
		await (await control.connect(deployer).transferOwnership(futureOwner.address)).wait()
		await (await control.connect(futureOwner).acceptOwnership()).wait()

		// Role changes are owner-gated, so the patch must queue a Safe action, not send.
		const patchInput = {
			...shared,
			recipeDigest: "express-authority-patch",
			component: "expressProvider",
			componentConfig: {
				mode: "reuse",
				address,
				admin: futureOwner.address,
				roles: { OPERATOR_ROLE: [operator.address, newOperator.address], SIGNER_ROLE: [signer.address] },
			},
			fresh: false,
			verify: false,
		} as const
		const previousSafeOnly = process.env.SYMMIO_SAFE_ACTIONS_ONLY
		const previousSafeAddress = process.env.SYMMIO_SAFE_ADDRESS
		process.env.SYMMIO_SAFE_ACTIONS_ONLY = "true"
		process.env.SYMMIO_SAFE_ADDRESS = futureOwner.address
		try {
			const pending = await executeComponentDeployment(hre, patchInput)
			expect(pending.report.lifecycle).to.equal("pending_handover")
			expect(pending.report.manualActions).to.have.length(1)
			expect(pending.report.transactions).to.have.length(0)
			const view = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/View/ViewFacet.sol:ViewFacet", address)
			const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
			expect(await view["hasRole(address,bytes32)"](newOperator.address, roleHash("OPERATOR_ROLE"))).to.equal(false)

			// The Safe owner executes the exact calldata the report printed, then the same intent converges.
			const action = pending.report.manualActions[0]
			await (await futureOwner.sendTransaction({ to: action.to, data: action.data })).wait()
			const finished = await executeComponentDeployment(hre, patchInput)
			expect(finished.report.lifecycle).to.equal("complete")
			expect(finished.report.transactions).to.have.length(0)
			expect(await view["hasRole(address,bytes32)"](newOperator.address, roleHash("OPERATOR_ROLE"))).to.equal(true)
		} finally {
			if (previousSafeOnly === undefined) delete process.env.SYMMIO_SAFE_ACTIONS_ONLY
			else process.env.SYMMIO_SAFE_ACTIONS_ONLY = previousSafeOnly
			if (previousSafeAddress === undefined) delete process.env.SYMMIO_SAFE_ADDRESS
			else process.env.SYMMIO_SAFE_ADDRESS = previousSafeAddress
		}
	})

	it("re-probes PartyB and SymbolManager code, wiring, roles, signer, ADL, and operator without writes", async function () {
		const context = await loadFixture(initializeFixture)
		const [admin, changedSigner, partyBOperator] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const coreReport: CoreDependencyReport = {
			deploymentId: "fixture-core-status",
			deployerAddress: admin.address,
			network: networkName,
			chainId: 31337,
			lifecycle: "complete",
			checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			config: { admin: admin.address },
			addresses: {
				diamond: context.diamond,
				instantLayer: await context.instantLayer.getAddress(),
			},
		}
		const target = { name: networkName, chainId: 31337, mode: "local" as const }
		const recipePath = "/tmp/component-engine-status-test.json"
		const coreReportPath = "/tmp/component-engine-status-core.json"
		const partyB = await executeComponentDeployment(hre, {
			recipeName,
			recipePath,
			recipeDigest: "partyB-status-digest",
			target,
			component: "partyB",
			componentConfig: { mode: "deploy", signer: admin.address, operators: [partyBOperator.address], adlEnabled: true, admin: admin.address },
			coreReport,
			coreReportPath,
			fresh: false,
			verify: false,
		})
		const boundPartyB = assertComponentStatusReportBinding(partyB.report, {
			component: "partyB",
			recipeName,
			recipePath,
			recipeDigest: "partyB-status-digest",
			network: networkName,
			chainId: 31337,
			live: false,
			config: { admin: admin.address, signer: admin.address, operators: [partyBOperator.address], adlEnabled: true },
			coreReport,
			coreReportPath,
		})
		const partyBScope = componentCheckpointScope(recipeName, "partyB")
		setCheckpointSimulated(true)
		const partyBCheckpoint = JSON.parse(fs.readFileSync(path.resolve(getCheckpointPath(31337, partyBScope)), "utf8"))
		expect(
			assertComponentStatusCheckpointBinding(partyBCheckpoint, boundPartyB, {
				component: "partyB",
				scope: partyBScope,
				network: networkName,
				chainId: 31337,
			}).deploymentId,
		).to.equal(partyB.report.deploymentId)

		const healthyPartyB = await inspectComponentStatus(ethers, "partyB", partyB.report, coreReport)
		expect(healthyPartyB.checks.every(check => check.status === "passed")).to.equal(true)
		expect(healthyPartyB.manualActions).to.deep.equal([])
		const partyBContract = await ethers.getContractAt("SymmioPartyB", partyB.report.address!)
		await partyBContract.revokeRole(await partyBContract.TRUSTED_ROLE(), partyBOperator.address)
		const missingPartyBOperator = await inspectComponentStatus(ethers, "partyB", partyB.report, coreReport)
		expect(missingPartyBOperator.checks.find(check => check.check.includes("PartyB operator TRUSTED_ROLE"))?.status).to.equal("failed")
		await partyBContract.grantRole(await partyBContract.TRUSTED_ROLE(), partyBOperator.address)
		await partyBContract.setSigner(changedSigner.address)
		const wrongSigner = await inspectComponentStatus(ethers, "partyB", partyB.report, coreReport)
		expect(wrongSigner.checks.find(check => check.check === "signer")?.status).to.equal("failed")
		await partyBContract.setSigner(admin.address)
		await context.controlFacet.setADLEnabled(partyB.report.address!, false)
		const wrongAdl = await inspectComponentStatus(ethers, "partyB", partyB.report, coreReport)
		expect(wrongAdl.checks.find(check => check.check === "core ADL setting")?.status).to.equal("pending")
		expect(wrongAdl.manualActions.map(action => action.description)).to.deep.equal([`Set ADL=true for PartyB ${partyB.report.address}`])
		await context.controlFacet.setADLEnabled(partyB.report.address!, true)

		const symbolManager = await executeComponentDeployment(hre, {
			recipeName,
			recipePath,
			recipeDigest: "symbol-status-digest",
			target,
			component: "symbolManager",
			componentConfig: { mode: "deploy", operator: admin.address, admin: admin.address },
			coreReport,
			coreReportPath,
			fresh: false,
			verify: false,
		})
		const healthyManager = await inspectComponentStatus(ethers, "symbolManager", symbolManager.report, coreReport)
		expect(healthyManager.checks.every(check => check.status === "passed")).to.equal(true)
		expect(healthyManager.manualActions).to.deep.equal([])
		const manager = await ethers.getContractAt("SymmioSymbolManager", symbolManager.report.address!)
		await manager.revokeRole(await manager.SYMBOL_ADDER_ROLE(), admin.address)
		const missingOperator = await inspectComponentStatus(ethers, "symbolManager", symbolManager.report, coreReport)
		expect(missingOperator.checks.find(check => check.check.startsWith("operator role"))?.status).to.equal("failed")
	})

	it("deploys a PartyB for a separate production admin and resumes without regaining local privileges", async function () {
		const context = await loadFixture(initializeFixture)
		const [deployer, finalAdmin, partyBSigner, partyBOperator] = await ethers.getSigners()
		const networkName = (await hre.network.getOrCreate()).networkName || "default"
		const partyBManagerRole = ethers.keccak256(ethers.toUtf8Bytes("PARTY_B_MANAGER_ROLE"))
		const instantSetterRole = await context.instantLayer.SETTER_ROLE()

		// Shape the dependency like production: the deployment signer can configure the
		// newly-created component, while only the governance admin can wire it into the
		// already-deployed core and InstantLayer.
		await context.controlFacet.connect(deployer).grantRole(finalAdmin.address, partyBManagerRole)
		await context.controlFacet.connect(deployer).revokeRole(deployer.address, partyBManagerRole)
		await context.instantLayer.connect(deployer).grantRole(instantSetterRole, finalAdmin.address)
		await context.instantLayer.connect(deployer).revokeRole(instantSetterRole, deployer.address)
		expect(await context.viewFacet.hasRole(deployer.address, partyBManagerRole)).to.equal(false)
		expect(await context.viewFacet.hasRole(finalAdmin.address, partyBManagerRole)).to.equal(true)
		expect(await context.instantLayer.hasRole(instantSetterRole, deployer.address)).to.equal(false)
		expect(await context.instantLayer.hasRole(instantSetterRole, finalAdmin.address)).to.equal(true)

		const coreReport: CoreDependencyReport = {
			deploymentId: "fixture-core-governance-admin",
			deployerAddress: deployer.address,
			network: networkName,
			chainId: 31337,
			lifecycle: "complete",
			checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			config: { admin: finalAdmin.address },
			addresses: {
				diamond: context.diamond,
				instantLayer: await context.instantLayer.getAddress(),
			},
		}
		const input = {
			recipeName,
			recipePath: "/tmp/component-engine-handover-test.json",
			recipeDigest: "partyB-handover-digest",
			target: { name: networkName, chainId: 31337, mode: "local" as const },
			component: "partyB",
			componentConfig: {
				mode: "deploy",
				signer: partyBSigner.address,
				operators: [partyBOperator.address],
				adlEnabled: true,
				admin: finalAdmin.address,
			},
			coreReport,
			coreReportPath: "/tmp/core-governance-report.json",
			fresh: false,
			verify: false,
		} as const

		const first = await executeComponentDeployment(hre, input)
		expect(first.report.lifecycle).to.equal("pending_handover")
		expect(first.report.health.status).to.equal("pending")
		expect(first.report.config).to.deep.equal({
			admin: finalAdmin.address,
			signer: partyBSigner.address,
			operators: [partyBOperator.address],
			adlEnabled: true,
		})
		expect(first.report.manualActions).to.deep.equal([
			{
				to: context.diamond,
				value: "0",
				data: context.controlFacet.interface.encodeFunctionData("registerPartyB", [first.report.address]),
				description: `Register PartyB ${first.report.address} on core`,
			},
			{
				to: context.diamond,
				value: "0",
				data: context.controlFacet.interface.encodeFunctionData("setADLEnabled", [first.report.address, true]),
				description: `Set ADL=true for PartyB ${first.report.address}`,
			},
			{
				to: await context.instantLayer.getAddress(),
				value: "0",
				data: context.instantLayer.interface.encodeFunctionData("registerPartyBs", [[first.report.address]]),
				description: `Register PartyB ${first.report.address} on InstantLayer`,
			},
		])

		const partyB = await ethers.getContractAt("SymmioPartyB", first.report.address!)
		const localRoles = [
			await partyB.DEFAULT_ADMIN_ROLE(),
			ethers.keccak256(ethers.toUtf8Bytes("TRUSTED_ROLE")),
			ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE")),
			ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE")),
			ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
			ethers.keccak256(ethers.toUtf8Bytes("UNPAUSER_ROLE")),
		]
		for (const role of localRoles) {
			expect(await partyB.hasRole(role, finalAdmin.address)).to.equal(true)
			expect(await partyB.hasRole(role, deployer.address)).to.equal(false)
		}
		expect(await partyB.signer()).to.equal(partyBSigner.address)
		expect(await partyB.hasRole(await partyB.TRUSTED_ROLE(), partyBOperator.address)).to.equal(true)
		expect(await partyB.multicastWhitelist(await context.instantLayer.getAddress())).to.equal(true)
		expect(await context.viewFacet.isPartyB(first.report.address)).to.equal(false)
		expect(await context.instantLayer.registeredPartyBs(first.report.address)).to.equal(false)

		const firstTransactionCount = first.report.transactions.length
		const resumed = await executeComponentDeployment(hre, input)
		expect(resumed.report.address).to.equal(first.report.address)
		expect(resumed.report.lifecycle).to.equal("pending_handover")
		expect(resumed.report.manualActions).to.deep.equal(first.report.manualActions)
		expect(resumed.report.transactions).to.have.length(firstTransactionCount)
		for (const role of localRoles) expect(await partyB.hasRole(role, deployer.address)).to.equal(false)

		// Execute the exact three governance actions and prove the same recipe/checkpoint
		// converges to complete without redeploying or regaining deployer privileges.
		await context.controlFacet.connect(finalAdmin).registerPartyB(first.report.address!)
		await context.controlFacet.connect(finalAdmin).setADLEnabled(first.report.address!, true)
		await context.instantLayer.connect(finalAdmin).registerPartyBs([first.report.address!])
		const completed = await executeComponentDeployment(hre, input)
		expect(completed.report.address).to.equal(first.report.address)
		expect(completed.report.lifecycle).to.equal("complete")
		expect(completed.report.health.status).to.equal("passed")
		expect(completed.report.manualActions).to.deep.equal([])
		expect(completed.report.transactions).to.have.length(firstTransactionCount)
		for (const role of localRoles) expect(await partyB.hasRole(role, deployer.address)).to.equal(false)
	})
})
