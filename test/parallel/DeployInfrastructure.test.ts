import { expect } from "chai"

import {
	assertCheckpointContractsHaveCode,
	assertCheckpointManifest,
	createCheckpoint,
	createDeployedContract,
	createDeploymentManifest,
	migrateCheckpointManifestSource,
} from "../../tasks/deploy/checkpoint.js"
import { resolveVerificationContractName, verificationProviderForChain } from "../../tasks/deploy/explorer.js"
import {
	getDeploymentTransactionJournal,
	getDeploymentTransactionSettings,
	deploymentTimeoutRecoveryHint,
	resetDeploymentTransactionJournal,
	send,
} from "../../tasks/deploy/tx.js"
import { FacetSpecs, LibrarySpecs } from "../../utils/deploymentManifest.js"
import { hre } from "../helpers/hardhat-connection.js"

describe("deployment infrastructure", function () {
	it("selects Blockscout for the configured IOTA, Mode, and COTI explorers", function () {
		for (const chainId of [8822, 34443, 2632500]) expect(verificationProviderForChain(chainId)).to.equal("blockscout")
		expect(verificationProviderForChain(42161)).to.equal("etherscan")
	})

	it("resolves an explicit compatible explorer for every non-built-in verification chain", function () {
		for (const chainId of [8822, 34443, 2632500]) {
			const explorer = hre.config.chainDescriptors.get(BigInt(chainId))?.blockExplorers.blockscout
			expect(explorer?.apiUrl).to.match(/^https:\/\//)
		}
		for (const chainId of [146, 999, 1329, 5000, 9745, 80094, 81457]) {
			const explorer = hre.config.chainDescriptors.get(BigInt(chainId))?.blockExplorers.etherscan
			expect(explorer?.url).to.match(/^https:\/\//)
		}
		expect(hre.config.chainDescriptors.get(1329n)?.blockExplorers.etherscan?.url).to.equal("https://seiscan.io")
	})

	it("resolves every release deployment artifact to an exact verification FQN", async function () {
		for (const scope of ["core", "accountLayer"] as const) {
			for (const spec of [...Object.values(LibrarySpecs[scope]), ...Object.values(FacetSpecs[scope])]) {
				const fqn = await resolveVerificationContractName(hre.artifacts, spec.artifact)
				expect(fqn, `${scope}:${spec.name}`).to.match(/^[^:]+:[^:]+$/)
				const artifact = await hre.artifacts.readArtifact(fqn)
				expect(fqn).to.equal(`${artifact.sourceName}:${artifact.contractName}`)
			}
		}
		expect(await resolveVerificationContractName(hre.artifacts, "AccountFacet")).to.equal(
			"contracts/core/facets/Account/AccountFacet.sol:AccountFacet",
		)
	})
	it("validates transaction timing settings instead of accepting NaN or unsafe ranges", function () {
		expect(getDeploymentTransactionSettings({})).to.deep.equal({ confirmations: 1, timeoutSeconds: 300, slowNoticeSeconds: 30 })
		expect(() => getDeploymentTransactionSettings({ DEPLOY_CONFIRMATIONS: "NaN" })).to.throw("must be a whole number")
		expect(() => getDeploymentTransactionSettings({ DEPLOY_TX_TIMEOUT: "29" })).to.throw("must be between 30")
		expect(() => getDeploymentTransactionSettings({ DEPLOY_TX_TIMEOUT: "30", DEPLOY_SLOW_TX_NOTICE: "30" })).to.throw("must be less than")
	})

	it("never tells an unjournaled standalone transaction that it is safe to rerun", function () {
		expect(deploymentTimeoutRecoveryHint(true)).to.include("write-ahead checkpointed")
		expect(deploymentTimeoutRecoveryHint(false)).to.include("No durable standalone checkpoint")
		expect(deploymentTimeoutRecoveryHint(false)).to.include("Do not broadcast this action again")
	})

	it("binds a checkpoint to public deployment intent and deployment source", function () {
		const checkpoint = createCheckpoint("default", 31337)
		const manifest = createDeploymentManifest(
			{ admin: "0x1", templates: [1, 2] },
			{ deploymentId: checkpoint.deploymentId, sourcePaths: ["package.json"] },
		)
		checkpoint.manifest = manifest

		expect(() => assertCheckpointManifest(checkpoint, { ...manifest, createdAt: new Date().toISOString() })).not.to.throw()
		const changed = createDeploymentManifest(
			{ admin: "0x2", templates: [1, 2] },
			{ deploymentId: checkpoint.deploymentId, sourcePaths: ["package.json"] },
		)
		expect(() => assertCheckpointManifest(checkpoint, changed)).to.throw("deployment configuration")
	})

	it("records an operator-authorized source-only checkpoint migration and preserves fail-closed boundaries", function () {
		const checkpoint = createCheckpoint("arbitrum", 42161, "upgrade-test")
		const intent = { inputDigest: "a".repeat(64), network: "arbitrum" }
		const previous = createDeploymentManifest(intent, {
			deploymentId: checkpoint.deploymentId,
			sourcePaths: ["package.json"],
		})
		const current = createDeploymentManifest(intent, {
			deploymentId: checkpoint.deploymentId,
			sourcePaths: ["tsconfig.json"],
		})
		checkpoint.manifest = previous
		checkpoint.transactions = [{ hash: "0xconfirmed", status: "confirmed" } as any]
		const evidence = {
			apiVersion: "operations.symm.io/task-source-migration-v1" as const,
			taskId: "maintenance.arbitrum-perps-upgrade",
			taskRunId: "run-1",
			inputDigest: "a".repeat(64),
			originalCommit: "b".repeat(40),
			currentCommit: "c".repeat(40),
			migrations: [
				{
					at: "2026-09-03T10:20:57.957Z",
					from: `sha256:${"1".repeat(64)}`,
					to: `sha256:${"2".repeat(64)}`,
					authorization: "operator-confirmed" as const,
				},
			],
			changedFiles: ["tasks/deploy/componentDeployment.ts"],
		}
		const migration = migrateCheckpointManifestSource(checkpoint, current, evidence, "2026-09-03T10:30:00.000Z")
		expect(checkpoint.manifest).to.deep.equal(current)
		expect(checkpoint.manifestSourceMigrations).to.deep.equal([migration])
		expect(migration).to.include({
			apiVersion: "operations.symm.io/deployment-manifest-source-migration-v1",
			migratedAt: "2026-09-03T10:30:00.000Z",
			transactionCount: 1,
		})
		expect(migration.from).to.deep.equal({ sourceHash: previous.sourceHash, fingerprint: previous.fingerprint })
		expect(migration.to).to.deep.equal({ sourceHash: current.sourceHash, fingerprint: current.fingerprint })
		expect(migration.preservedStateHash).to.match(/^sha256:[0-9a-f]{64}$/)

		const configurationChanged = createDeploymentManifest(
			{ ...intent, network: "base" },
			{
				deploymentId: checkpoint.deploymentId,
				sourcePaths: ["package-lock.json"],
			},
		)
		expect(() => migrateCheckpointManifestSource({ ...checkpoint, manifest: previous }, configurationChanged, evidence)).to.throw(
			"deployment configuration changed",
		)
		expect(() =>
			migrateCheckpointManifestSource(
				{ ...checkpoint, manifest: previous, transactions: [{ hash: "0xunknown", status: "unresolved" } as any] },
				current,
				evidence,
			),
		).to.throw("transaction outcome(s) remain uncertain")
	})

	it("refuses checkpoint addresses that have no code on the connected chain", async function () {
		const checkpoint = createCheckpoint("default", 31337)
		checkpoint.contracts.signatureVerifier = createDeployedContract("0x0000000000000000000000000000000000000001")
		let failure: unknown
		try {
			await assertCheckpointContractsHaveCode(checkpoint, async () => "0x")
		} catch (error) {
			failure = error
		}
		expect(failure).to.be.instanceOf(Error)
		expect((failure as Error).message).to.include("has no code")
		await assertCheckpointContractsHaveCode(checkpoint, async () => "0x6000")
	})

	it("journals confirmed and successfully replaced transactions", async function () {
		resetDeploymentTransactionJournal()
		const receipt = {
			status: 1,
			hash: "0xconfirmed",
			blockNumber: 10,
			gasUsed: 21_000n,
			gasPrice: 2n,
		}
		await send(Promise.resolve({ hash: "0xsubmitted", nonce: 7, wait: async () => receipt } as any), "test confirmation")
		expect(getDeploymentTransactionJournal()[0]).to.include({
			hash: "0xsubmitted",
			nonce: 7,
			status: "confirmed",
			gasUsed: "21000",
			nativeCostWei: "42000",
		})

		resetDeploymentTransactionJournal()
		const replacement = { ...receipt, hash: "0xreplacement", blockNumber: 11 }
		await send(
			Promise.resolve({
				hash: "0xoriginal",
				nonce: 8,
				wait: async () => {
					throw { code: "TRANSACTION_REPLACED", cancelled: false, receipt: replacement, replacement: { hash: replacement.hash } }
				},
			} as any),
			"test replacement",
		)
		expect(getDeploymentTransactionJournal()[0]).to.include({
			hash: "0xoriginal",
			replacementHash: "0xreplacement",
			status: "replaced",
		})
	})
})
