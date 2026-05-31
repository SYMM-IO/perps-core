/**
 * Legacy alias for verifyCoreBytecode.ts.
 *
 * Canonical command:
 *   NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyCoreBytecode.ts
 */
import { spawnSync } from "child_process"

console.warn("verifyDeploy.ts is a legacy alias. Use verifyCoreBytecode.ts for core bytecode parity verification.")

const result = spawnSync("npx", ["ts-node", "scripts/upgrade/verifyCoreBytecode.ts"], {
	env: process.env,
	stdio: "inherit",
})

process.exitCode = result.status ?? 1
