import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import fs from "node:fs"
import path from "node:path"

import { digest, json, runWithdrawalPhase, sourceDigest, validateWithdrawalInput } from "../../deployment-tooling/core-withdrawal.js"
import { atomicWriteFile } from "../utils/fs.js"
import { acquireCheckpointLock, setCheckpointSimulated } from "./checkpoint.js"
import { requireExecutionConfirmation } from "./executionGuard.js"
import { completeGovernanceTransactionRequest } from "./governanceActions.js"
import { emitTaskEvent } from "./logger.js"
import { send } from "./tx.js"

export const coreWithdrawalTask = task("internal:core-withdrawal", "Inspect, deallocate and withdraw a direct Core account")
	.addOption({ name: "phase", type: ArgumentType.STRING, defaultValue: "inspect" })
	.addOption({ name: "input", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "output", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "transaction", type: ArgumentType.STRING, defaultValue: "" })
	.setAction(async () => ({
		default: async (args: any, hre: any) => {
			const input = JSON.parse(fs.readFileSync(args.input, "utf8"))
			validateWithdrawalInput(input)
			const connection = await hre.network.getOrCreate(),
				provider = connection.ethers.provider
			if (connection.networkName !== input.network) throw new Error("Selected network differs from withdrawal input")
			const execute = requireExecutionConfirmation(input.chainId)
			if (input.action === "check" && execute) throw new Error("Check-only task cannot execute transactions")
			setCheckpointSimulated(connection.networkConfig.type !== "http" || input.network === "localhost")
			const lock = acquireCheckpointLock(input.chainId, `withdraw-${input.core.toLowerCase()}-${input.account.toLowerCase()}`)
			try {
				const source = sourceDigest(process.cwd())
				const report = fs.existsSync(args.output)
					? JSON.parse(fs.readFileSync(args.output, "utf8"))
					: { schema: 1, inputDigest: digest(input), sourceDigest: source, operations: {}, actions: {} }
				if (report.sourceDigest !== source) throw new Error("Withdrawal runtime changed after review; restore source before resuming")
				const save = () => {
					fs.mkdirSync(path.dirname(args.output), { recursive: true })
					atomicWriteFile(args.output, json(report) + "\n", 0o600)
				}
				let signer
				if (execute && ["deallocate", "initiate", "withdraw"].includes(args.phase)) {
					signer = (await connection.ethers.getSigners()).find((s: any) => s.address?.toLowerCase() === input.account.toLowerCase())
					if (!signer) {
						for (const s of await connection.ethers.getSigners())
							if ((await s.getAddress()).toLowerCase() === input.account.toLowerCase()) {
								signer = s
								break
							}
					}
					if (!signer) throw new Error("Selected signer does not own the reviewed Core account")
				}
				await runWithdrawalPhase({
					provider,
					input,
					report,
					phase: args.phase,
					save,
					signer,
					execute,
					transaction: args.transaction,
					completeRequest: completeGovernanceTransactionRequest,
					send,
					onConfirmed: (transaction: any) => {
						emitTaskEvent("tx.confirmed", { transaction })
					},
				})
				console.log(
					`Core withdrawal ${args.phase}: ${report.completed ? "verified" : report.readiness?.ready === false ? "cooldown pending" : "checked"}`,
				)
			} finally {
				lock.release()
			}
		},
	}))
	.build()
