import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { configureFuzzLayers } from "../models/FuzzLayerUser.js"
import type { RunContext } from "../models/RunContext.js"
import { TestManager } from "../models/TestManager.js"
import { decimal } from "../utils/Common.js"
import {
	executeFuzzLegacyImport,
	executeFuzzMarginRecovery,
	executeFuzzOwnership,
	executeFuzzSingleVA,
	type FuzzAccountFeatureOptions,
} from "../utils/FuzzAccountLayerFeatures.js"
import { executeFuzzDelegation, executeFuzzFlexFields } from "../utils/FuzzInstantLayerFeatures.js"
import { executeFuzzInstantTrading } from "../utils/FuzzInstantTradingCampaign.js"
import { executeFuzzTimelocks } from "../utils/FuzzTimelockCampaign.js"
import { setRandomSeed } from "../utils/RandomUtils.js"

describe("Fuzz layer feature campaigns", function () {
	let context: RunContext
	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		context.manager = new TestManager(context, false, "direct")
		await context.manager.start()
		await context.controlFacet.setBalanceLimitPerUser(decimal(10_000_000n))
		await configureFuzzLayers(context)
		setRandomSeed(this.currentTest!.title)
	})
	afterEach(async function () {
		setRandomSeed(undefined)
		await context?.manager.stopAndDrain(30_000)
	})
	function options(route: FuzzAccountFeatureOptions["route"]): FuzzAccountFeatureOptions {
		return { context, manager: context.manager, owner: context.signers.user, route }
	}
	for (const route of ["account-layer", "instant-layer"] as const) {
		for (const isolationType of [1, 2]) {
			it(`shares VA keys and switches to independent VAs for isolation ${isolationType} through ${route}`, async function () {
				expect((await executeFuzzSingleVA({ ...options(route), isolationType })).quoteIds).to.have.length(6)
			})
		}
		it(`transfers ownership of pending child quotes and deletes the empty account through ${route}`, async function () {
			expect((await executeFuzzOwnership(options(route))).quoteIds).to.have.length(1)
		})
		it(`preserves funded legacy accounts through import and trading via ${route}`, async function () {
			expect((await executeFuzzLegacyImport(options(route))).quoteIds).to.have.length(1)
		})
		it(`recovers orphaned margin and preserves safe removal reserves via ${route}`, async function () {
			expect((await executeFuzzMarginRecovery(options(route))).quoteIds).to.have.length(1)
		})
		for (const contractUnlocker of [false, true]) {
			it(`enforces schedules and ${contractUnlocker ? "EIP-1271" : "EOA"} timelock approvals via ${route}`, async function () {
				expect((await executeFuzzTimelocks({ ...options(route), contractUnlocker })).quoteIds).to.have.length(1)
			})
		}
	}
	for (const seed of ["first", "second"]) {
		it(`executes grants, scoped delegates, revocations and expiry (${seed} seed)`, async function () {
			expect((await executeFuzzDelegation(options("instant-layer"))).quoteIds).to.have.length(3)
		})
		it(`executes authenticated flex fills and rolls back failing batches (${seed} seed)`, async function () {
			expect((await executeFuzzFlexFields(options("instant-layer"))).quoteIds).to.have.length(1)
		})
	}
	for (const nativeContext of [false, true]) {
		for (const instantOpen of [false, true]) {
			it(`chains trading template results with instantOpen=${instantOpen} and nativeContext=${nativeContext}`, async function () {
				expect(
					(await executeFuzzInstantTrading({ ...options("instant-layer"), execution: "template", instantOpen, nativeContext })).quoteIds,
				).to.have.length(1)
			})
		}
		it(`relays contract PartyB trading batches with nativeContext=${nativeContext}`, async function () {
			expect((await executeFuzzInstantTrading({ ...options("instant-layer"), execution: "batch", nativeContext })).quoteIds).to.have.length(1)
		})
	}
})
