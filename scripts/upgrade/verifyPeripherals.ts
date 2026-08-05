/**
 * Legacy alias for verification scripts with historically overloaded naming.
 *
 * Canonical commands:
 *   # Peripheral bytecode parity:
 *   NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts
 *
 *   # Final peripheral wiring/state:
 *   RPC_<NETWORK>=<rpc> npx hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network <network>
 */
import { spawnSync } from "child_process"

function isTsNodeEntrypoint(): boolean {
	return process.argv.some(arg => /(^|[/\\])ts-node($|\.js$)/.test(arg))
}

if (isTsNodeEntrypoint()) {
	if (!process.env.RPC_URL) {
		console.error("verifyPeripherals.ts is a legacy alias.")
		console.error("For bytecode parity, set RPC_URL and use verifyPeripheralBytecode.ts.")
		console.error("For final wiring/state, run verifyPeripheralWiring.ts with npx hardhat run.")
		process.exitCode = 1
	} else {
		console.warn("verifyPeripherals.ts with RPC_URL is a legacy alias. Use verifyPeripheralBytecode.ts for peripheral bytecode parity.")
		const result = spawnSync("npx", ["ts-node", "scripts/upgrade/verifyPeripheralBytecode.ts"], {
			env: process.env,
			stdio: "inherit",
		})
		process.exitCode = result.status ?? 1
	}
} else {
	console.warn("verifyPeripherals.ts is a legacy alias. Use verifyPeripheralWiring.ts for final peripheral wiring/state verification.")
	await import("./verifyPeripheralWiring.js")
}
