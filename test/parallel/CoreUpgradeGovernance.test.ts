import { expect } from "chai"
import fs from "node:fs"

import { digest, CUT_SELECTOR } from "../../deployment-tooling/arbitrum-core-upgrade.js"
import { assertCoreGovernanceProgress, assertCoreUpgradeExecution, buildCoreUpgradeActions } from "../../tasks/deploy/arbitrumCoreUpgrade.js"
import {
	prepareCoreGovernancePayload,
	executeCoreGovernancePayload,
	verifyCoreGovernanceReceipt,
	rehearseCoreGovernancePayload,
} from "../../tasks/deploy/coreUpgradeGovernance.js"
import { assertCoreSnapshotPreserved, coreUpgradeABI } from "../../tasks/deploy/coreUpgradeSnapshot.js"
import { ethers } from "../helpers/hardhat-connection.js"

const address = (n: number) => "0x" + n.toString(16).padStart(40, "0")
async function rejects(fn: () => Promise<any>, pattern: RegExp) {
	try {
		await fn()
	} catch (error) {
		expect(String(error)).to.match(pattern)
		return
	}
	throw new Error("Expected rejection")
}
async function fixture() {
	const [owner, recipient] = await ethers.getSigners()
	const target = await (await ethers.getContractFactory("SymmioSymbolManager")).deploy(owner.address, owner.address)
	await target.waitForDeployment()
	const config = {
		apiVersion: "operations.symm.io/core-upgrade-input-v1",
		network: { chainId: Number((await ethers.provider.getNetwork()).chainId) },
		governance: { kind: "eoa", owner: owner.address },
		target: { core: await target.getAddress() },
		execution: { confirmations: 1 },
	}
	const actions = ["SETTER_ROLE", "SECOND_TEST_ROLE"].map(role => ({
		to: config.target.core,
		value: "0",
		data: target.interface.encodeFunctionData("grantRole", [ethers.id(role), recipient.address]),
		description: `Grant ${role}`,
	}))
	const afterBlock = await ethers.provider.getBlockNumber(),
		envelope = await prepareCoreGovernancePayload(ethers, config, actions)
	return { owner, recipient, target, config, actions, envelope, afterBlock }
}

describe("Generic Core governance", () => {
	it("checks configured Base live/fork boundaries and explicit chain authorization", () => {
		const config = JSON.parse(fs.readFileSync("deployment-tooling/examples/core-upgrade.base-example.input.json", "utf8"))
		const live = { networkName: "base", networkConfig: { type: "http" } },
			fork = { networkName: "fork-base", networkConfig: { type: "edr-simulated" } }
		expect(() => assertCoreUpgradeExecution("inspect", live, 8453, {}, config)).not.to.throw()
		expect(() => assertCoreUpgradeExecution("deploy", live, 8453, {}, config)).to.throw(/authorization/)
		expect(() =>
			assertCoreUpgradeExecution("deploy", live, 8453, { SYMMIO_CORE_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "42161" }, config),
		).to.throw()
		expect(() => assertCoreUpgradeExecution("rehearse-cut", live, 8453, {}, config)).to.throw(/network/)
		expect(() => assertCoreUpgradeExecution("rehearse-cut", fork, 8453, {}, config)).not.to.throw()
	})
	it("verifies mined EOA actions and resumes a broadcast whose receipt wait was interrupted without resending", async () => {
		const f = await fixture(),
			journal: any = {},
			persisted: any[] = []
		let broadcasts = 0,
			failOnce = true
		const mocked = {
			...ethers,
			getSigners: async () => [
				{
					getAddress: () => f.owner.getAddress(),
					sendTransaction: async (request: any) => {
						broadcasts++
						return f.owner.sendTransaction(request)
					},
				},
			],
		}
		const persist = () => {
			persisted.push(structuredClone(journal))
			if (failOnce && journal.transactions?.length) {
				failOnce = false
				throw new Error("Interrupted after durable broadcast")
			}
		}
		await rejects(() => executeCoreGovernancePayload(mocked, f.config, f.envelope, journal, persist), /broadcast.*write-ahead/)
		expect(broadcasts).to.equal(1)
		expect(persisted.at(-1).transactions[0].hash).to.match(/^0x/)
		const hashes = await executeCoreGovernancePayload(mocked, f.config, f.envelope, journal, persist)
		expect(broadcasts).to.equal(2)
		expect(journal.transactions.every((tx: any) => tx.status === "confirmed" && tx.blockHash)).to.equal(true)
		expect((await verifyCoreGovernanceReceipt(ethers, f.config, f.envelope, hashes, f.afterBlock)).receipts).to.have.length(2)
		expect(await f.target.hasRole(ethers.id("SECOND_TEST_ROLE"), f.recipient.address)).to.equal(true)
		await executeCoreGovernancePayload(mocked, f.config, f.envelope, journal, persist)
		expect(broadcasts).to.equal(2)
	})
	it("rejects wrong owner, nonce, calldata, target, value, chain, failed or noncanonical EOA receipts", async () => {
		const f = await fixture(),
			journal: any = {}
		const hashes = await executeCoreGovernancePayload(ethers, f.config, f.envelope, journal, () => {})
		const hash = JSON.parse(hashes)[0],
			realReceipt = await ethers.provider.getTransactionReceipt(hash),
			realTx = await ethers.provider.getTransaction(hash)
		for (const change of [
			{ tx: { from: f.recipient.address } },
			{ tx: { nonce: realTx!.nonce + 1 } },
			{ tx: { data: "0x12345678" } },
			{ tx: { to: f.recipient.address } },
			{ tx: { value: 1n } },
			{ tx: { chainId: 8453n } },
			{ receipt: { status: 0 } },
			{ receipt: { blockNumber: f.afterBlock } },
			{ blockHash: "0x" + "b".repeat(64) },
		]) {
			const mock = {
				...ethers,
				provider: {
					getTransactionReceipt: async (h: string) => (h === hash ? { ...realReceipt, ...change.receipt } : ethers.provider.getTransactionReceipt(h)),
					getTransaction: async (h: string) => (h === hash ? { ...realTx, ...change.tx } : ethers.provider.getTransaction(h)),
					getBlock: async (n: number) => ({ ...(await ethers.provider.getBlock(n)), ...(change.blockHash ? { hash: change.blockHash } : {}) }),
					getBlockNumber: () => ethers.provider.getBlockNumber(),
				},
			}
			await rejects(() => verifyCoreGovernanceReceipt(mock, f.config, f.envelope, hashes, f.afterBlock), /differs|canonical/)
		}
		await rejects(() => verifyCoreGovernanceReceipt(ethers, f.config, f.envelope, JSON.stringify([hash]), f.afterBlock), /Every reviewed/)
		await rejects(
			() => executeCoreGovernancePayload({ ...ethers, getSigners: async () => [f.recipient] }, f.config, f.envelope, {}, () => {}),
			/signer/,
		)
		await rejects(() => executeCoreGovernancePayload(ethers, f.config, { ...f.envelope, payloadDigest: "changed" }, {}, () => {}), /envelope/)
		await rejects(
			() => verifyCoreGovernanceReceipt(ethers, { ...f.config, execution: { confirmations: 10000 } }, f.envelope, hashes, f.afterBlock),
			/confirmations/,
		)
	})
	it("refuses stale owner nonces and impersonation outside a block-pinned fork", async () => {
		const f = await fixture()
		await (await f.owner.sendTransaction({ to: f.recipient.address, value: 0n })).wait()
		await rejects(() => executeCoreGovernancePayload(ethers, f.config, f.envelope, {}, () => {}), /nonce changed/)
		await rejects(() => rehearseCoreGovernancePayload(ethers, f.config, f.envelope, f.afterBlock), /pinned fork/)
	})
	it("stops before the next action if a mined transaction differs from its reviewed intent", async () => {
		const f = await fixture()
		let broadcasts = 0
		const mocked = {
			...ethers,
			getSigners: async () => [
				{
					getAddress: () => f.owner.getAddress(),
					sendTransaction: async (request: any) => {
						broadcasts++
						return f.owner.sendTransaction({ ...request, data: f.actions[1].data })
					},
				},
			],
		}
		await rejects(() => executeCoreGovernancePayload(mocked, f.config, f.envelope, {}, () => {}), /differs from/)
		expect(broadcasts).to.equal(1)
	})
	it("uses only missing input role grants and refuses unrelated changes during a partial EOA cut", () => {
		const config = {
			apiVersion: "operations.symm.io/core-upgrade-input-v1",
			governance: { owner: address(2) },
			target: { core: address(1), symbolManager: address(3) },
			allowedRemovedSelectors: [],
		}
		const before: any = {
			preserved: { getOwner: address(2) },
			wiring: {},
			code: {},
			economy: {},
			pause: [true, false],
			selectors: { [CUT_SELECTOR]: address(4), "0x12345678": address(5) },
			roles: { migration: false, listing: true },
			plannedRoles: [
				{ holder: address(2), role: "GLOBAL_PAUSER_ROLE", held: false },
				{ holder: address(3), role: "SYMBOL_LISTING_ROLE", held: true },
			],
			funding: [],
			globals: [],
		}
		const plan = buildCoreUpgradeActions(ethers, { config }, before, { facets: { f: { address: address(8), selectors: ["0x12345678"] } } })
		expect(plan.actions).to.have.length(2)
		const iface = new ethers.Interface(coreUpgradeABI),
			grant = iface.decodeFunctionData("grantRole", plan.actions[1].data)
		expect(grant[0].toLowerCase()).to.equal(address(2))
		expect(grant[1]).to.equal(ethers.id("GLOBAL_PAUSER_ROLE"))
		const afterCut = { ...structuredClone(before), selectors: plan.desired }
		expect(() => assertCoreGovernanceProgress(ethers, before, afterCut, plan, 1, config)).not.to.throw()
		expect(() => assertCoreGovernanceProgress(ethers, before, { ...afterCut, wiring: { changed: true } }, plan, 1, config)).to.throw(
			/progress changed/,
		)
		expect(() => assertCoreSnapshotPreserved(before, afterCut, true)).to.throw(/grants are incomplete/)
		afterCut.plannedRoles[0].held = true
		expect(() => assertCoreGovernanceProgress(ethers, before, afterCut, plan, 2, config)).not.to.throw()
	})
})
