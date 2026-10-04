import { expect } from "chai"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { batchPlanDigest } from "../../deployment-tooling/batch-withdrawal.js"
import { setCheckpointSimulated } from "../../tasks/deploy/checkpoint.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"
import { loadFixture, time } from "../helpers/network-helpers.js"

describe("batch withdrawal Hardhat adapter", function () {
	it("deallocates, adopts existing requests, queues cooldowns and proves later common-recipient transfers on a local Core", async function () {
		const context = await loadFixture(initializeFixture)
		const accounts = [context.signers.user, (await ethers.getSigners())[18]]
		const recipient = (await ethers.getSigners())[19].address
		await context.controlFacet.setMaxWithdrawParts(50)
		await context.controlFacet.setWithdrawCooldownPeriod(120)
		for (const [index, signer] of accounts.entries()) {
			const amount = ethers.parseEther(index === 0 ? "5" : "2")
			await context.collateral.mint(signer.address, amount)
			await context.collateral.connect(signer).approve(context.diamond, amount)
			await context.accountFacet.connect(signer).deposit(amount)
		}
		await context.accountFacet.connect(accounts[0]).allocate(ethers.parseEther("5"))
		await context.withdrawFacet.connect(accounts[1]).initiateWithdraw(
			[
				{
					id: 0,
					amount: ethers.parseEther("1"),
					chainId: 31337,
					receiver: recipient,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				},
			],
			false,
			"0x",
		)
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "batch-withdrawal-evm-"))
		const inputFile = path.join(scratch, "input.json"),
			output = path.join(scratch, "report.json")
		const input = {
			schema: 1,
			network: (await hre.network.getOrCreate()).networkName,
			chainId: 31337,
			core: context.diamond,
			accounts: accounts.map(signer => signer.address),
			recipientMode: "common",
			recipient,
			amount: "all",
			route: "auto",
			muonUrl: "https://muon.example/",
		}
		fs.writeFileSync(inputFile, JSON.stringify(input))
		const readReport = () => JSON.parse(fs.readFileSync(output, "utf8"))
		const task = hre.tasks.getTask("internal:batch-withdrawal")
		const envNames = ["EXECUTE", "CONFIRM_CHAIN_ID", "DRY_RUN", "DEPLOY_TX_CONFIRMATIONS"]
		const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
		const previousFetch = globalThis.fetch
		let signatureRequests = 0
		globalThis.fetch = async url => {
			signatureRequests++
			const account = new URL(String(url)).searchParams.get("params[partyA]")!
			return new Response(
				JSON.stringify({
					success: true,
					result: {
						confirmed: true,
						app: "symmio",
						method: "uPnl_A",
						reqId: "0x1234",
						data: {
							timestamp: (await ethers.provider.getBlock("latest"))!.timestamp,
							result: {
								chainId: "31337",
								symmio: context.diamond,
								partyA: account,
								nonce: String(await context.viewFacet.nonceOfPartyA(account)),
								uPnl: "0",
							},
							init: { nonceAddress: account },
						},
						shieldSignature: "0x" + "01".repeat(65),
						signatures: [{ signature: "0x" + "02".repeat(32), owner: account }],
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			)
		}
		const run = async (account: string, phase: string, execute = false) => {
			process.env.EXECUTE = String(execute)
			process.env.CONFIRM_CHAIN_ID = "31337"
			delete process.env.DRY_RUN
			process.env.DEPLOY_TX_CONFIRMATIONS = "1"
			await task.run({ account, phase, input: inputFile, output })
		}
		try {
			for (const account of input.accounts) await run(account, "inspect")
			const report = readReport()
			report.approvedDigest = batchPlanDigest(report)
			fs.writeFileSync(output, JSON.stringify(report))
			for (const account of input.accounts) await run(account, "process", true)
			expect(readReport().rows[input.accounts[0].toLowerCase()].status).to.equal("waiting_cooldown")
			expect(readReport().rows[input.accounts[1].toLowerCase()].status).to.equal("completed")
			expect(await context.collateral.balanceOf(recipient)).to.equal(ethers.parseEther("2"))
			expect(await context.viewFacet.getLastWithdrawRequestId(input.accounts[1])).to.equal(2n)
			await time.increase(121)
			for (const account of input.accounts) await run(account, "recheck")
			expect(readReport().rows[input.accounts[0].toLowerCase()].status).to.equal("ready")
			await run(input.accounts[0], "withdraw-ready", true)
			await run(input.accounts[0], "withdraw-ready", true)
			expect(await context.collateral.balanceOf(recipient)).to.equal(ethers.parseEther("7"))
			expect(await context.viewFacet.balanceOf(input.accounts[0])).to.equal(0n)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(input.accounts[0])).to.equal(0n)
			expect(await context.viewFacet.getLastWithdrawRequestId(input.accounts[0])).to.equal(1n)
			expect(readReport().rows[input.accounts[0].toLowerCase()].fresh.proofs.withdraw.eventsVerified).to.equal(true)
			expect(signatureRequests).to.equal(1)
		} finally {
			globalThis.fetch = previousFetch
			for (const name of envNames) {
				if (previousEnv[name] === undefined) delete process.env[name]
				else process.env[name] = previousEnv[name]
			}
			setCheckpointSimulated(false)
			fs.rmSync(scratch, { recursive: true, force: true })
		}
	})
})
