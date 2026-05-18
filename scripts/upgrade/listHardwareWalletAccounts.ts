/**
 * Discover hardware-wallet accounts usable by upgrade scripts.
 *
 * This does not send transactions. It helps resolve the "which signer index/path"
 * problem by matching exposed wallet accounts or scanned Ledger derivation paths
 * against the configured protocolAdmin by default.
 *
 * External wallet RPC pathless mode:
 *   HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port> npx hardhat run scripts/upgrade/listHardwareWalletAccounts.ts --network coti
 *
 * Direct Ledger scan:
 *   HW_WALLET=ledger LEDGER_SCAN=true npx hardhat run scripts/upgrade/listHardwareWalletAccounts.ts --network coti
 *
 * Env overrides:
 *   EXPECTED_ADDRESS      Address to match (defaults to protocolAdmin, upgradeOperator, or migrationRunner by HARDWARE_ROLE)
 *   HARDWARE_ROLE         protocolAdmin, upgradeOperator, or migrationRunner (defaults to protocolAdmin)
 *   HARDWARE_ENV_PREFIX   Env prefix for role-specific vars (defaults to PROTOCOL_ADMIN, UPGRADE_OPERATOR, or MIGRATION_RUNNER)
 *   LEDGER_PATH           Known path, if already known
 *   LEDGER_PATHS          Comma-separated extra paths to scan first
 *   LEDGER_ACCOUNT_COUNT  Ledger Live account count to scan (default 10)
 *   LEDGER_ADDRESS_COUNT  Address-index count to scan for legacy paths (default 20)
 */
import connection from "../../test/helpers/hardhat-connection.js"
import { printHardwareWalletDiscovery } from "./utils/hardwareSigner.js"
import { baseNetworkName, loadUpgradeConfigShared } from "./utils/sharedConfig.js"

async function main() {
	const networkSuffix = baseNetworkName(connection.networkName)
	const shared = loadUpgradeConfigShared(networkSuffix)
	const role = process.env.HARDWARE_ROLE ?? "protocolAdmin"
	const expectedAddress =
		process.env.EXPECTED_ADDRESS ??
		(role === "migrationRunner" ? shared.migrationRunner : role === "upgradeOperator" ? shared.upgradeOperator : shared.protocolAdmin)
	const envPrefix =
		process.env.HARDWARE_ENV_PREFIX ??
		(role === "migrationRunner"
			? "MIGRATION_RUNNER"
			: role === "upgradeOperator"
				? "UPGRADE_OPERATOR"
				: role === "protocolAdmin"
					? "PROTOCOL_ADMIN"
					: undefined)

	await printHardwareWalletDiscovery({
		expectedAddress,
		role,
		envPrefix,
	})
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
