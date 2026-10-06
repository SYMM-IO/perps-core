import { expect } from "chai"
import fs from "node:fs"
import path from "node:path"

import {
	clearCheckpoint,
	createCheckpoint,
	saveCheckpoint,
	setCheckpointSimulated,
	type DeploymentCheckpoint,
} from "../../tasks/deploy/checkpoint.js"
import { persistSubmittedTransaction } from "../../tasks/deploy/deploymentRecovery.js"
import { resolveCreate2FactoryAddress } from "../../tasks/deploy/diamond.js"
import { deployStablecoin } from "../../tasks/deploy/stablecoin.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	reconcileDeploymentTransactions,
	recoverConfirmedDeployment,
	resetDeploymentTransactionJournal,
	send,
	type DeploymentTransactionRecord,
} from "../../tasks/deploy/tx.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

const ORIGINAL_HASH = `0x${"71".repeat(32)}`
const REPLACEMENT_HASH = `0x${"72".repeat(32)}`

describe("contract creation timeout recovery", function () {
	const checkpointChainId = 98_601_347
	const checkpointPath = path.resolve(`tasks/data/checkpoints/checkpoint-${checkpointChainId}.json`)

	beforeEach(function () {
		resetDeploymentTransactionJournal()
		setCheckpointSimulated(false)
	})

	afterEach(function () {
		clearDeploymentTransactionWriteAhead()
		fs.rmSync(checkpointPath, { force: true })
		resetDeploymentTransactionJournal()
	})

	it("resumes a timed-out landed CREATE at its original address without broadcasting another deployment", async function () {
		const [deployer] = await ethers.getSigners()
		const factory = await ethers.getContractFactory("FakeStablecoin")
		const original = await factory.connect(deployer).deploy()
		const tx = original.deploymentTransaction()!
		const receipt = await tx.wait()
		expect(receipt?.status).to.equal(1)

		const address = await original.getAddress()
		const record: DeploymentTransactionRecord = {
			label: "deploy FakeStablecoin",
			hash: tx.hash,
			nonce: tx.nonce,
			status: "timed_out",
			from: tx.from,
			to: tx.to,
			data: tx.data,
			value: tx.value.toString(),
			submittedAt: new Date(Date.now() - 60_000).toISOString(),
			durationMs: 30_000,
			confirmations: 1,
			error: "receipt wait timed out",
			deployment: {
				kind: "create",
				component: "contracts.collateral",
				expectedAddress: address,
				initCodeHash: ethers.keccak256(tx.data),
				constructorArgs: [],
			},
		}
		const checkpoint: DeploymentCheckpoint = createCheckpoint("creation-resume-test", checkpointChainId)
		checkpoint.transactions = [record]

		expect(await reconcileDeploymentTransactions(checkpoint.transactions, ethers.provider, await deployer.getAddress(), {})).to.equal(1)
		expect(record.status).to.equal("confirmed")
		expect(record.deployment?.runtimeCodeHash).to.equal(ethers.keccak256(await ethers.provider.getCode(address)))

		const nonceBeforeResume = await ethers.provider.getTransactionCount(await deployer.getAddress(), "latest")
		const resumed = await deployStablecoin(hre, { checkpoint, logData: false })
		const nonceAfterResume = await ethers.provider.getTransactionCount(await deployer.getAddress(), "latest")

		expect(await resumed.getAddress()).to.equal(address)
		expect(checkpoint.contracts.collateral?.address).to.equal(address)
		expect(nonceAfterResume).to.equal(nonceBeforeResume)
	})

	it("accepts only a same-intent CREATE replacement and retains the original derived address", async function () {
		const from = "0x0000000000000000000000000000000000000001"
		const nonce = 7
		const data = "0x60006000"
		const expectedAddress = ethers.getCreateAddress({ from, nonce })
		const record: DeploymentTransactionRecord = {
			label: "deploy replacement fixture",
			hash: ORIGINAL_HASH,
			nonce,
			status: "timed_out",
			from,
			to: null,
			data,
			value: "0",
			submittedAt: new Date(Date.now() - 60_000).toISOString(),
			durationMs: 30_000,
			confirmations: 1,
			deployment: {
				kind: "create",
				component: "contracts.fixture",
				expectedAddress,
				initCodeHash: ethers.keccak256(data),
			},
		}
		const replacement = { hash: REPLACEMENT_HASH, from, to: null, data, value: 0n, nonce }
		const replacementReceipt = {
			hash: REPLACEMENT_HASH,
			status: 1,
			blockNumber: 100,
			gasUsed: 100_000n,
			gasPrice: 2n,
			contractAddress: expectedAddress,
		}
		const provider = {
			getBlockNumber: async () => 100,
			getTransactionReceipt: async (hash: string) => (hash === REPLACEMENT_HASH ? replacementReceipt : null),
			getTransaction: async (hash: string) => (hash === REPLACEMENT_HASH ? replacement : null),
			getTransactionCount: async () => nonce + 1,
			getCode: async (address: string) => (address.toLowerCase() === expectedAddress.toLowerCase() ? "0x6000" : "0x"),
		}

		expect(
			await reconcileDeploymentTransactions([record], provider, from, {
				DEPLOY_TX_REPLACEMENTS: `${ORIGINAL_HASH}=${REPLACEMENT_HASH}`,
			}),
		).to.equal(1)
		expect(record.status).to.equal("replaced")
		expect(await recoverConfirmedDeployment([record], "contracts.fixture", provider)).to.equal(expectedAddress)

		const conflictingRecord: DeploymentTransactionRecord = {
			...record,
			status: "timed_out",
			replacementHash: undefined,
			deployment: { ...record.deployment!, runtimeCodeHash: undefined },
		}
		let conflict: unknown
		try {
			await reconcileDeploymentTransactions(
				[conflictingRecord],
				{
					...provider,
					getTransaction: async (hash: string) => (hash === REPLACEMENT_HASH ? { ...replacement, data: "0x60016000" } : null),
				},
				from,
				{ DEPLOY_TX_REPLACEMENTS: `${ORIGINAL_HASH}=${REPLACEMENT_HASH}` },
			)
		} catch (error) {
			conflict = error
		}
		expect(conflict).to.be.instanceOf(Error)
		expect((conflict as Error).message).to.include("different non-cancellation intent")
		expect(conflictingRecord.status).to.equal("timed_out")
	})

	it("refuses --fresh archival while any broadcast still has an unknown outcome", function () {
		const checkpoint = createCheckpoint("creation-resume-test", checkpointChainId)
		checkpoint.transactions = [
			{
				label: "deploy fixture",
				hash: ORIGINAL_HASH,
				nonce: 1,
				status: "unresolved",
				submittedAt: new Date().toISOString(),
				durationMs: 0,
				confirmations: 1,
			},
		]
		saveCheckpoint(checkpoint)

		expect(() => clearCheckpoint(checkpointChainId, checkpoint.network, "abandoned")).to.throw("--fresh cannot abandon")
		expect(fs.existsSync(checkpointPath)).to.equal(true)
	})

	it("persists every broadcast before receipt waiting and lets an explicit creation sink take precedence", async function () {
		const checkpoint = createCheckpoint("creation-resume-test", checkpointChainId)
		let observedWriteAheadBeforeWait = false
		bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint, record))

		let failure: unknown
		try {
			await send(
				Promise.resolve({
					hash: ORIGINAL_HASH,
					nonce: 9,
					from: "0x0000000000000000000000000000000000000001",
					to: "0x0000000000000000000000000000000000000002",
					data: "0x1234",
					value: 0n,
					wait: async () => {
						const persisted = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as DeploymentCheckpoint
						observedWriteAheadBeforeWait = persisted.transactions?.[0]?.status === "unresolved"
						throw new Error("stop after write-ahead assertion")
					},
				} as any),
				"write-ahead fixture",
			)
		} catch (error) {
			failure = error
		}
		expect(failure).to.be.instanceOf(Error)
		expect(observedWriteAheadBeforeWait).to.equal(true)

		let globalCalls = 0
		clearDeploymentTransactionWriteAhead()
		bindDeploymentTransactionWriteAhead(() => {
			globalCalls++
		})
		let explicitCalls = 0
		await send(
			Promise.resolve({
				hash: REPLACEMENT_HASH,
				nonce: 10,
				wait: async () => ({ status: 1, hash: REPLACEMENT_HASH, blockNumber: 101, gasUsed: 21_000n, gasPrice: 1n }),
			} as any),
			"explicit write-ahead fixture",
			1,
			{ onSubmitted: () => explicitCalls++ },
		)
		expect(explicitCalls).to.equal(1)
		expect(globalCalls).to.equal(0)
	})

	it("treats an explicitly configured CREATE2 factory as mandatory", async function () {
		const configured = "0x0000000000000000000000000000000000000001"
		let failure: unknown
		try {
			await resolveCreate2FactoryAddress(
				{
					getAddress: ethers.getAddress,
					provider: { getCode: async () => "0x" },
				},
				configured,
			)
		} catch (error) {
			failure = error
		}
		expect(failure).to.be.instanceOf(Error)
		expect((failure as Error).message).to.include("explicitly configured")
		expect(await resolveCreate2FactoryAddress({ getAddress: ethers.getAddress, provider: { getCode: async () => "0x" } }, "")).to.equal("")
	})
})
