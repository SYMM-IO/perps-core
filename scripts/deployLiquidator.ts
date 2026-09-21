/**
 * Deploy and wire SymmioLiquidator. The default mode is read-only planning.
 *
 * ADMIN_PUBLIC_KEY=0x... SYMMIO_ADDRESS=0x... \
 *   ./node_modules/.bin/hardhat run scripts/deployLiquidator.ts --network hyperevm
 *
 * Add EXECUTE=true CONFIRM_CHAIN_ID=<connected chain id> to deploy and wire roles. If deployment succeeds but later
 * wiring fails, resume with LIQUIDATOR_ADDRESS=<deployed proxy>.
 */
import hre from "hardhat"

import { runStandaloneLiquidator } from "../tasks/deploy/standaloneLiquidator.js"

runStandaloneLiquidator(hre).catch(error => {
	console.error(error)
	process.exitCode = 1
})
