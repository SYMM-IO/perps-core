/**
 * Legacy alias for verifyCoreBytecode.ts.
 *
 * Canonical command:
 *   NETWORK=<network> RPC_URL=<rpc> node --import tsx scripts/upgrade/verifyCoreBytecode.ts
 */
import { spawnSync } from "child_process"

console.warn("verifyDeploy.ts is a legacy alias. Use verifyCoreBytecode.ts for core bytecode parity verification.")

const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/upgrade/verifyCoreBytecode.ts"], {
	env: process.env,
	stdio: "inherit",
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
