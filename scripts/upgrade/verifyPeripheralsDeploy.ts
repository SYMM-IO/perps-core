/**
 * Legacy alias for verifyPeripheralBytecode.ts.
 *
 * Canonical command:
 *   NETWORK=<network> RPC_URL=<rpc> node --import tsx scripts/upgrade/verifyPeripheralBytecode.ts
 */
import { spawnSync } from "child_process"

console.warn("verifyPeripheralsDeploy.ts is a legacy alias. Use verifyPeripheralBytecode.ts for peripheral bytecode parity verification.")

const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/upgrade/verifyPeripheralBytecode.ts"], {
	env: process.env,
	stdio: "inherit",
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
