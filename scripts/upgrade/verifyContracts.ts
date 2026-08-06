/**
 * Legacy alias for verifyBlockExplorer.ts.
 *
 * Canonical command:
 *   USE_KEYSTORE=true ./node_modules/.bin/hardhat run scripts/upgrade/verifyBlockExplorer.ts --network <network>
 */
console.warn("verifyContracts.ts is a legacy alias. Use verifyBlockExplorer.ts for block explorer source + ABI verification.")

await import("./verifyBlockExplorer.js")
