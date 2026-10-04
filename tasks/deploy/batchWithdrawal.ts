import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import fs from "node:fs"

import { batchSourceDigest, runBatchAccount, validateBatchInput } from "../../deployment-tooling/batch-withdrawal.js"
import { digest, json } from "../../deployment-tooling/core-withdrawal.js"
import { atomicWriteFile } from "../utils/fs.js"
import { acquireCheckpointLock, setCheckpointSimulated } from "./checkpoint.js"
import { requireExecutionConfirmation } from "./executionGuard.js"
import { completeGovernanceTransactionRequest } from "./governanceActions.js"
import { emitTaskEvent } from "./logger.js"
import { send } from "./tx.js"

export const batchWithdrawalTask = task("internal:batch-withdrawal", "Inspect or process one account in a reviewed withdrawal batch")
	.addOption({ name: "phase", type: ArgumentType.STRING, defaultValue: "inspect" })
	.addOption({ name: "account", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "input", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "output", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "transaction", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "transactionPhase", type: ArgumentType.STRING, defaultValue: "" })
	.setAction(async () => ({
		default: async (args: any, hre: any) => {
			const input = JSON.parse(fs.readFileSync(args.input, "utf8"))
			validateBatchInput(input)
			const connection = await hre.network.getOrCreate()
			if (connection.networkName !== input.network) throw new Error("Selected network differs from the withdrawal batch")
			const execute = requireExecutionConfirmation(input.chainId)
			if (execute && !["process", "withdraw-ready"].includes(args.phase)) throw new Error("Read-only batch phase cannot execute")
			setCheckpointSimulated(connection.networkConfig.type !== "http" || input.network === "localhost")
			const lock = acquireCheckpointLock(input.chainId, `batch-withdraw-${input.core.toLowerCase()}`)
			try {
				const source = batchSourceDigest(process.cwd())
				const report = fs.existsSync(args.output)
					? JSON.parse(fs.readFileSync(args.output, "utf8"))
					: { schema: 1, inputDigest: digest(input), sourceDigest: source, rows: {} }
				if (report.sourceDigest !== source) throw new Error("Batch runtime changed after review; restore the original source before continuing")
				const save = () => atomicWriteFile(args.output, json(report) + "\n", 0o600)
				let signer
				if (execute) {
					for (const candidate of await connection.ethers.getSigners())
						if ((await candidate.getAddress()).toLowerCase() === args.account.toLowerCase()) signer = candidate
					if (!signer) throw new Error("Connected signer does not own the batch account")
				}
				await runBatchAccount({
					provider: connection.ethers.provider,
					input,
					report,
					account: args.account,
					phase: args.phase,
					execute,
					signer,
					save,
					transaction: args.transaction,
					transactionPhase: args.transactionPhase,
					completeRequest: completeGovernanceTransactionRequest,
					send,
					onProgress: (message: string) => emitTaskEvent("activity", { message }),
					onConfirmed: (transaction: any) => emitTaskEvent("tx.confirmed", { transaction }),
				})
				console.log(`Batch account ${args.account}: ${report.rows[args.account.toLowerCase()].status}`)
			} finally {
				lock.release()
			}
		},
	}))
	.build()
