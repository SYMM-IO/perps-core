// Deliberately separate from the TTY operator. Local evidence ingestion only.
import { assessDeployment } from "../deployment-tooling/operations/assurance.js";
import { observeDeploymentTransaction } from "../tasks/deploy/tx.ts";
import fs from "node:fs";
import path from "node:path";

const [inputPath, evidencePath, outputPath, ...extra] = process.argv.slice(2);
if (!inputPath || !evidencePath || !outputPath || extra.length)
	throw new Error("Usage: node --import tsx scripts/assure-deployment.mjs <input.json> <evidence.json> <new-result.json>");
function read(file) {
	if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error("Evidence file exceeds 5 MiB");
	return JSON.parse(fs.readFileSync(file, "utf8"));
}
let result;
try {
	const input = read(inputPath);
	const evidence = read(evidencePath);
	result = await assessDeployment(input, {
		report: async () => evidence,
		component: async id => evidence.components?.[id],
		transaction: async record => {
			const provider = {
				getBlock: async number => evidence.blocks?.[number] || null,
				getTransactionReceipt: async hash => evidence.receipts?.[hash] || null,
				getTransaction: async hash => evidence.transactions?.[hash] || null,
				getCode: async address => {
					const code = evidence.code?.[address.toLowerCase()];
					if (typeof code !== "string") throw new Error("Missing finalized bytecode evidence");
					return code;
				},
			};
			return {
				chainId: evidence.chainId,
				blockHash: evidence.blockHash,
				...(await observeDeploymentTransaction(record, provider, input.finalized)),
			};
		},
	});
} catch {
	result = {
		apiVersion: "operations.symm.io/assurance-v1",
		createdAt: new Date().toISOString(),
		evidenceKind: "owner-provided",
		status: "failed",
		errorCategory: "invalid-input-or-evidence",
	};
}

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(`Assurance ${result.status}; protected evidence: ${path.resolve(outputPath)}`);
process.exitCode = result.status === "complete" ? 0 : result.status === "failed" ? 1 : 2;
