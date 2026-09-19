import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import fs from "node:fs"
import path from "node:path"

import {
	buildPlan,
	check,
	contracts,
	digest,
	json,
	PHASES,
	readSnapshot,
	sameAddress,
	sourceDigest,
	submitOperation,
	validateInput,
	validateStage,
	verifyOperationEvents,
	verifyPlan,
} from "../../deployment-tooling/disputed-settlement.js"
import { atomicWriteFile } from "../utils/fs.js"
import { acquireCheckpointLock, setCheckpointSimulated } from "./checkpoint.js"
import { requireExecutionConfirmation } from "./executionGuard.js"
import { completeGovernanceTransactionRequest } from "./governanceActions.js"
import { emitTaskEvent } from "./logger.js"
import { send } from "./tx.js"

export async function runSettlementPhase({
	provider,
	input,
	report,
	phase,
	save,
	root,
	signer,
	execute = false,
	transaction,
	completeRequest = completeGovernanceTransactionRequest,
	sendTransaction = send,
}: any) {
	validateInput(input)
	check(Number((await provider.getNetwork()).chainId) === input.chainId, "Connected chain differs from the input file")
	check(report.inputDigest === digest(input), "Settlement report input changed")
	const { core } = contracts(provider, input, root)
	if (phase === "inspect") {
		if (report.plan) {
			verifyPlan(report.plan, input)
			return report
		}
		const snapshot = await readSnapshot(provider, input, root, undefined, console.log)
		report.plan = buildPlan(input, snapshot, core.interface)
		report.sourceDigest = sourceDigest(root)
		save()
		return report
	}
	check(report.plan, "Inspect this liquidation before any transaction")
	verifyPlan(report.plan, input)
	check(report.sourceDigest === sourceDigest(root), "Settlement source changed after review")
	const plan = report.plan
	const reconcile = async (action: any, suppliedHash?: string) => {
		const operation = report.operations[action.phase]
		const originalHash = operation.journal?.hash || operation.hash
		const receipt = await submitOperation({ provider, plan, action, report, save, completeRequest, send: sendTransaction, suppliedHash })
		verifyOperationEvents(plan, action, receipt, core.interface)
		report.proofs ||= {}
		report.proofs[action.phase] = {
			...report.proofs[action.phase],
			transactionHash: receipt.hash,
			blockNumber: receipt.blockNumber,
			eventsVerified: true,
		}
		save()
		// A crash can leave the CLI journal behind the case report. Restore its receipt
		// event too, including replacement identity, without resubmitting the transaction.
		emitTaskEvent("tx.confirmed", {
			transaction: {
				...operation.journal,
				...operation.intent,
				label: `disputed settlement ${action.phase}`,
				hash: receipt.hash,
				originalHash,
				nonce: operation.nonce,
				status: "confirmed",
				blockNumber: receipt.blockNumber,
				gasUsed: String(receipt.gasUsed),
			},
		})
		return receipt
	}
	if (phase === "reconcile") {
		for (const action of plan.actions) if (report.operations?.[action.phase]?.hash) await reconcile(action)
		return report
	}
	// Replay only receipt verification, never payments. Prepared/no-hash operations block
	// all later writes and survive process failure and task cancellation.
	for (const action of plan.actions) {
		if (!report.operations?.[action.phase]) break
		await reconcile(action, action.phase === phase ? transaction : undefined)
	}
	const completed = plan.actions.filter((a: any) => report.operations?.[a.phase]?.status === "confirmed").map((a: any) => a.phase)
	let snapshot = await readSnapshot(provider, input, root, plan)
	validateStage(plan, snapshot, completed)
	if (phase === "verify") {
		check(completed.length === plan.actions.length, "Not every reviewed transaction is confirmed")
		check(
			(!plan.actions.some((a: any) => a.phase === "payment") || report.proofs?.payment) && report.proofs?.finalize,
			"Payment and finalization balance evidence is incomplete",
		)
		report.final = snapshot
		report.completed = true
		save()
		return report
	}
	check(PHASES.includes(phase), "Unknown settlement phase")
	const action = plan.actions.find((a: any) => a.phase === phase)
	if (!action || completed.includes(phase)) return report
	check(plan.actions.find((a: any) => !completed.includes(a.phase))?.phase === phase, "Settle in the reviewed order")
	if (!execute) {
		report.nextAction = action
		save()
		return report
	}
	check(report.approvedDigest === plan.digest, "Operator has not approved this exact settlement preview")
	check(signer && sameAddress(await signer.getAddress(), input.operator), "Connected signer is not the operator named in the input file")
	// eth_call + estimateGas use the actual sender and fresh state immediately before signing.
	await provider.call({ from: input.operator, to: action.to, data: action.data, value: 0n })
	report.preOperation ||= {}
	report.preOperation[phase] = snapshot
	save()
	const receipt = await submitOperation({
		provider,
		signer,
		plan,
		action,
		report,
		save,
		completeRequest,
		send: sendTransaction,
		suppliedHash: transaction,
	})
	verifyOperationEvents(plan, action, receipt, core.interface)
	completed.push(phase)
	snapshot = await readSnapshot(provider, input, root, plan, undefined, receipt.blockNumber)
	validateStage(plan, snapshot, completed)
	report.proofs ||= {}
	// Per-account settlement events and the exact parent transfer prove transaction-local
	// amounts even if unrelated activity changes a solver/parent balance in the same block.
	report.proofs[phase] = { transactionHash: receipt.hash, blockNumber: receipt.blockNumber, eventsVerified: true, snapshot }
	save()
	return report
}

export const disputedSettlementTask = task("internal:disputed-settlement", "Reviewed direct-signer clearing-house settlement")
	.addOption({ name: "phase", type: ArgumentType.STRING, defaultValue: "inspect" })
	.addOption({ name: "input", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "output", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "transaction", type: ArgumentType.STRING, defaultValue: "" })
	.setAction(async () => ({
		default: async (args: any, hre: any) => {
			const input = JSON.parse(fs.readFileSync(args.input, "utf8"))
			validateInput(input)
			const connection = await hre.network.getOrCreate(),
				provider = connection.ethers.provider
			check(connection.networkName === input.network, "Selected network differs from input file")
			const execute = requireExecutionConfirmation(input.chainId)
			setCheckpointSimulated(connection.networkConfig.type !== "http" || input.network === "localhost")
			const lock = acquireCheckpointLock(input.chainId, `dispute-${input.core.toLowerCase()}-${input.partyA.toLowerCase()}`)
			try {
				const report = fs.existsSync(args.output)
					? JSON.parse(fs.readFileSync(args.output, "utf8"))
					: { schema: 1, inputDigest: digest(input), operations: {} }
				const save = () => {
					fs.mkdirSync(path.dirname(args.output), { recursive: true })
					atomicWriteFile(args.output, json(report) + "\n", 0o600)
				}
				let signer
				if (execute && PHASES.includes(args.phase)) {
					const candidates = await connection.ethers.getSigners()
					for (const candidate of candidates)
						if (sameAddress(await candidate.getAddress(), input.operator)) {
							signer = candidate
							break
						}
					check(signer, "The selected signing method does not expose the reviewed admin wallet")
				}
				await runSettlementPhase({
					provider,
					input,
					report,
					phase: args.phase,
					save,
					root: process.cwd(),
					signer,
					execute,
					transaction: args.transaction,
				})
			} finally {
				lock.release()
			}
		},
	}))
	.build()
