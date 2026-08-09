/**
 * Legacy alias for verification scripts with historically overloaded naming.
 *
 * Canonical commands:
 *   # Peripheral bytecode parity:
 *   NETWORK=<network> RPC_URL=<rpc> node --import tsx scripts/upgrade/verifyPeripheralBytecode.ts
 *
 *   # Final peripheral wiring/state:
 *   RPC_<NETWORK>=<rpc> ./node_modules/.bin/hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network <network>
 */
import { spawnSync } from "child_process"

if (process.env.RPC_URL) {
	console.warn("verifyPeripherals.ts with RPC_URL is a legacy alias. Use verifyPeripheralBytecode.ts for peripheral bytecode parity.")
	const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/upgrade/verifyPeripheralBytecode.ts"], {
		env: process.env,
		stdio: "inherit",
	})
	if (result.error) throw result.error
	process.exitCode = result.status ?? 1
} else {
	console.warn("verifyPeripherals.ts is a legacy alias. Use verifyPeripheralWiring.ts for final peripheral wiring/state verification.")
	await import("./verifyPeripheralWiring.js")
}
