/**
 * Legacy alias for verifyDiamondSelectors.ts.
 *
 * Canonical command:
 *   RPC_<NETWORK>=<rpc> npx hardhat run scripts/upgrade/verifyDiamondSelectors.ts --network <network>
 */
console.warn("verifyDiamond.ts is a legacy alias. Use verifyDiamondSelectors.ts for final diamond selector verification.")

await import("./verifyDiamondSelectors.js")
