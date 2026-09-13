import { expect } from "chai"
import { execFile } from "node:child_process"
import fs from "node:fs"
import { createServer, type Server } from "node:http"
import path from "node:path"

import { initializeFixture } from "../Initialize.fixture.js"
import { scalarGetterSlot, setSignedStorage } from "../helpers/diamond-storage.js"
import connection, { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture, time } from "../helpers/network-helpers.js"
import { PositionType } from "../models/Enums.js"
import { Hedger } from "../models/Hedger.js"
import type { RunContext } from "../models/RunContext.js"
import { User } from "../models/User.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"

interface RpcRequest {
	id: number
	method: string
	params: unknown[]
}

describe("aggregate funding repair script", function () {
	this.timeout(60_000)
	const epoch = 500n
	const rate = 10_000_000_000_000_001n
	const quantity = decimal(100n) + 100n
	const openPrice = decimal(10n)
	const temporaryRoot = path.resolve("tmp")
	let context: RunContext
	let server: Server
	let rpcUrl: string
	let directory: string
	let partyB: string
	let groups: Array<{ partyA: string; partyB: string; symbolId: string; positionType: "LONG" | "SHORT" }>
	let correctFunding: bigint[]
	const requests: RpcRequest[] = []

	before(async function () {
		// Forward the CLI's localhost RPC calls to the same isolated chain as the fixture.
		server = createServer(async (request, response) => {
			try {
				let body = ""
				for await (const chunk of request) body += chunk.toString()
				const input = JSON.parse(body) as RpcRequest | RpcRequest[]
				const dispatch = async (rpc: RpcRequest) => {
					requests.push(rpc)
					try {
						const result = await connection.provider.request({ method: rpc.method, params: rpc.params })
						return { jsonrpc: "2.0", id: rpc.id, result }
					} catch (error) {
						const failure = error as { code?: number; message: string; data?: unknown }
						return { jsonrpc: "2.0", id: rpc.id, error: { code: failure.code ?? -32000, message: failure.message, data: failure.data } }
					}
				}
				const output = Array.isArray(input) ? await Promise.all(input.map(dispatch)) : await dispatch(input)
				response.writeHead(200, { "content-type": "application/json" })
				response.end(JSON.stringify(output))
			} catch (error) {
				response.writeHead(500)
				response.end(String(error))
			}
		})
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("Test RPC server did not bind a TCP port")
		rpcUrl = `http://127.0.0.1:${address.port}`
	})

	after(async function () {
		await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
	})

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		const user = new User(context, context.signers.user)
		const user2 = new User(context, context.signers.user2)
		for (const owner of [user, user2]) {
			await owner.setup()
			await owner.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
		}
		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))
		partyB = await hedger.getAddress()
		const aligned = (BigInt(await time.latest()) / epoch + 1n) * epoch
		await time.setNextBlockTimestamp(aligned)
		await context.pauseControlFacet.activateAccumulatedFunding()
		await context.fundingRateFacet.connect(hedger.signer).setEpochDurations([1n], [epoch])
		await context.fundingRateFacet.connect(hedger.signer).setFundingFee([1n], [rate], [-rate], [decimal(1n)])
		await time.setNextBlockTimestamp(aligned + epoch + 100n)
		await context.controlFacet.setMuonConfig(1000n, 1000n)

		for (const [owner, side] of [
			[user, PositionType.LONG],
			[user, PositionType.SHORT],
			[user, PositionType.LONG],
			[user2, PositionType.LONG],
		] as const) {
			const quote = await owner.sendQuote(
				limitQuoteRequestBuilder().positionType(side).quantity(quantity).price(openPrice).maxFundingRate(decimal(1n)).build(),
			)
			await hedger.lockQuote(quote)
			await hedger.openPosition(quote, limitOpenRequestBuilder().filledAmount(quantity).openPrice(openPrice).price(openPrice).build())
		}
		groups = [
			{ partyA: await user.getAddress(), partyB, symbolId: "1", positionType: "LONG" },
			{ partyA: await user2.getAddress(), partyB, symbolId: "1", positionType: "LONG" },
			{ partyA: await user.getAddress(), partyB, symbolId: "1", positionType: "SHORT" },
		]
		correctFunding = await Promise.all(
			groups.map(group =>
				context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					group.partyA,
					partyB,
					1n,
					group.positionType === "LONG" ? PositionType.LONG : PositionType.SHORT,
				),
			),
		)
		expect(correctFunding).to.deep.equal([2n * ((quantity * rate) / decimal(1n)), (quantity * rate) / decimal(1n), (quantity * -rate) / decimal(1n)])
		await context.pauseControlFacet.pauseGlobal()
		// The privileged repair setter can recreate legacy drift without fixed storage offsets.
		await context.migrationFacet.resyncAggregateFunding(
			groups.map((group, index) => ({
				...group,
				positionType: group.positionType === "LONG" ? PositionType.LONG : PositionType.SHORT,
				expectedPartyAFunding: correctFunding[index],
				expectedPartyBFunding: correctFunding[index],
				newFunding: correctFunding[index] + BigInt(index + 1),
			})),
		)
		fs.mkdirSync(temporaryRoot, { recursive: true })
		directory = fs.mkdtempSync(path.join(temporaryRoot, "funding-resync-"))
		fs.writeFileSync(path.join(directory, "groups.json"), JSON.stringify(groups))
		requests.length = 0
	})

	afterEach(function () {
		if (directory) {
			expect(path.dirname(path.resolve(directory))).to.equal(temporaryRoot)
			expect(path.basename(directory)).to.match(/^funding-resync-/)
			fs.rmSync(directory, { recursive: true, force: true })
			directory = ""
		}
	})

	function runScript(overrides: NodeJS.ProcessEnv = {}) {
		const env = { ...process.env }
		for (const key of ["EXECUTE", "CONFIRM_CHAIN_ID", "SYMMIO_DEPLOYMENT_RECIPE", "SYMMIO_RPC_URL_OVERRIDE"]) delete env[key]
		Object.assign(env, {
			SYMMIO: context.diamond,
			GROUPS_FILE: path.join(directory, "groups.json"),
			OUTPUT_FILE: path.join(directory, "plan.json"),
			PAGE_SIZE: "1",
			GROUP_BATCH_SIZE: "1",
			RPC_LOCALHOST: rpcUrl,
			SYMMIO_SIGNER_MODE: "local-node",
			DOTENV_CONFIG_PATH: path.join(directory, "unused.env"),
			USE_KEYSTORE: "false",
			...overrides,
		})
		return new Promise<{ code: string | number; stdout: string; stderr: string }>(resolve => {
			execFile(
				process.execPath,
				[path.resolve("node_modules/hardhat/dist/src/cli.js"), "run", "--no-compile", "--network", "localhost", "scripts/resyncAggregateFunding.ts"],
				{ env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 },
				(error, stdout, stderr) => resolve({ code: error ? (error.code ?? "failed") : 0, stdout, stderr }),
			)
		})
	}

	function expectNoTransactions() {
		expect(requests.filter(request => ["eth_sendTransaction", "eth_sendRawTransaction"].includes(request.method))).to.be.empty
	}

	it("dry-runs the real entry point with fixed-block pagination, exact signed amounts, and decodable calldata", async function () {
		const blockBefore = await ethers.provider.send("eth_blockNumber", [])
		const result = await runScript()
		expect(result.code, result.stderr).to.equal(0)
		expect(result.stdout).to.include("Dry run only. No transaction was sent.")
		const plan = JSON.parse(fs.readFileSync(path.join(directory, "plan.json"), "utf8"))
		expect(plan.chainId).to.equal("31337")
		expect(BigInt(plan.blockTag)).to.equal(BigInt(blockBefore))
		expect(plan.transactions).to.have.length(3)
		for (const [index, transaction] of plan.transactions.entries()) {
			const [repairs] = context.migrationFacet.interface.decodeFunctionData("resyncAggregateFunding", transaction.data)
			expect(repairs).to.have.length(1)
			expect(repairs[0].partyA).to.equal(groups[index].partyA)
			expect(repairs[0].newFunding).to.equal(correctFunding[index])
			expect(repairs[0].expectedPartyAFunding).to.equal(correctFunding[index] + BigInt(index + 1))
			expect(repairs[0].expectedPartyBFunding).to.equal(repairs[0].expectedPartyAFunding)
			expect(transaction.groups[0].quoteCount).to.equal(index === 1 ? "1" : "3")
		}
		expect(plan.globalFunding.map((group: { newFunding: string }) => BigInt(group.newFunding))).to.deep.equal([
			correctFunding[0] + correctFunding[1],
			correctFunding[2],
		])
		const calls = requests.filter(request => request.method === "eth_call")
		expect(calls.length).to.be.greaterThan(0)
		for (const call of calls) expect(BigInt(String(call.params[1]))).to.equal(BigInt(plan.blockTag))
		expectNoTransactions()
		expect(await ethers.provider.send("eth_blockNumber", [])).to.equal(blockBefore)
	})

	it("executes multiple batches, repairs shared totals, verifies post-state, and safely repeats", async function () {
		const counterBefore = await context.viewFacet.upnlCounterOfPartyA(groups[0].partyA)
		const result = await runScript({ EXECUTE: "true", CONFIRM_CHAIN_ID: "31337" })
		expect(result.code, result.stderr).to.equal(0)
		expect(result.stdout).to.include("Applied repair batch 3/3").and.include("Verified 3 repaired funding group(s).")
		for (const [index, group] of groups.entries()) {
			const side = group.positionType === "LONG" ? PositionType.LONG : PositionType.SHORT
			expect(await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(group.partyA, partyB, 1n, side)).to.equal(correctFunding[index])
			expect(await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(partyB, group.partyA, 1n, side)).to.equal(correctFunding[index])
		}
		expect(await context.viewFacetAggregate.getPartyBAggregatedFunding(partyB, 1n, PositionType.LONG)).to.equal(correctFunding[0] + correctFunding[1])
		expect(await context.viewFacetAggregate.getPartyBAggregatedFunding(partyB, 1n, PositionType.SHORT)).to.equal(correctFunding[2])
		const counterAfter = await context.viewFacet.upnlCounterOfPartyA(groups[0].partyA)
		expect(counterAfter).to.equal(counterBefore + 2n)
		const repeat = await runScript({ EXECUTE: "true", CONFIRM_CHAIN_ID: "31337" })
		expect(repeat.code, repeat.stderr).to.equal(0)
		expect(await context.viewFacet.upnlCounterOfPartyA(groups[0].partyA)).to.equal(counterAfter)
	})

	it("rejects an unpaused protocol without sending a transaction", async function () {
		await context.controlFacet.grantRole(context.signers.admin.address, ethers.id("UNPAUSER_ROLE"))
		await context.pauseControlFacet.unpauseGlobal()
		const result = await runScript({ EXECUTE: "true", CONFIRM_CHAIN_ID: "31337" })
		expect(result.code).to.equal(1)
		expect(result.stderr).to.include("Protocol was not globally paused")
		expectNoTransactions()
	})

	it("requires the matching chain confirmation before executing", async function () {
		const result = await runScript({ EXECUTE: "true", CONFIRM_CHAIN_ID: "1" })
		expect(result.code).to.equal(1)
		expect(result.stderr).to.include("Set CONFIRM_CHAIN_ID=31337")
		expectNoTransactions()
	})

	it("requires the configured signer to hold MIGRATION_ROLE", async function () {
		await context.controlFacet.revokeRole(context.signers.admin.address, ethers.id("MIGRATION_ROLE"))
		const result = await runScript({ EXECUTE: "true", CONFIRM_CHAIN_ID: "31337" })
		expect(result.code).to.equal(1)
		expect(result.stderr).to.include("does not have MIGRATION_ROLE")
		expectNoTransactions()
	})

	it("rejects duplicate input groups before sending repairs", async function () {
		fs.writeFileSync(path.join(directory, "groups.json"), JSON.stringify([...groups, groups[0]]))
		const result = await runScript({ EXECUTE: "true", CONFIRM_CHAIN_ID: "31337" })
		expect(result.code).to.equal(1)
		expect(result.stderr).to.include("duplicates an earlier funding group")
		expectNoTransactions()
	})

	it("rejects a mismatch between the reported position count and the actual paginated list", async function () {
		const slot = await scalarGetterSlot(context.viewFacetQuote, "partyBPositionsCount", [partyB, groups[0].partyA])
		await setSignedStorage(context.diamond, slot, 4n)
		const result = await runScript({ EXECUTE: "true", CONFIRM_CHAIN_ID: "31337" })
		expect(result.code).to.equal(1)
		expect(result.stderr).to.include("Open-position array length 3 does not match partyBPositionsCount 4")
		expectNoTransactions()
	})
})
