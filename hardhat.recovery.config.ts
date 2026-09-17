import hardhatLedger from "@nomicfoundation/hardhat-ledger"
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import { configVariable, defineConfig } from "hardhat/config"

import { hyperevmZeroRecoveryTask } from "./tasks/deploy/hyperevmZeroRecovery.js"

// Credentials are explicit references supplied by the guided task. Never load .env or fallback wallets.
const mode = process.env.SYMMIO_RECOVERY_EXECUTE === "true" ? process.env.SYMMIO_SIGNER_MODE : undefined
const accounts =
	mode === "hardhat-keystore"
		? [configVariable(process.env.KEYSTORE_DEPLOYER_KEY || "NEW_DEPLOYER")]
		: mode === "private-key"
			? [process.env.SYMMIO_EPHEMERAL_PRIVATE_KEY || ""]
			: []
const rpc = configVariable(process.env.SYMMIO_RECOVERY_RPC_KEY || "RPC_HYPEREVM")
const archive = configVariable(process.env.SYMMIO_RECOVERY_ARCHIVE_KEY || "RPC_HYPEREVM_ARCHIVE")
const forkBlock = Number(process.env.SYMMIO_RECOVERY_FORK_BLOCK || "0")
const ledger =
	mode === "ledger"
		? {
				ledgerAccounts: [process.env.SYMMIO_LEDGER_ADDRESS || ""],
				...(process.env.SYMMIO_LEDGER_DERIVATION === "legacy"
					? { ledgerOptions: { derivationFunction: (index: number) => `m/44'/60'/0'/${index}` } }
					: {}),
			}
		: {}

// Isolated v0.8.5 build. Do not compile a production recovery artifact with the v0.8.6 configuration.
export default defineConfig({
	plugins: [hardhatToolboxMochaEthers, hardhatLedger],
	tasks: [hyperevmZeroRecoveryTask],
	chainDescriptors: {
		999: {
			name: "HyperEVM",
			chainType: "generic",
			hardforkHistory: { merge: { blockNumber: 0 }, shanghai: { blockNumber: 0 }, cancun: { blockNumber: 0 } },
			blockExplorers: { etherscan: { name: "Hyperevmscan", url: "https://hyperevmscan.io" } },
		},
	},
	verify: { etherscan: { apiKey: configVariable("ETHERSCAN_APIKEY") } },
	typechain: { outDir: "./artifacts/recovery/types" },
	paths: {
		sources: "./contracts/patches/hyperevm-v085",
		tests: { mocha: "./test/recovery" },
		artifacts: "./artifacts/recovery",
		cache: "./cache/recovery",
	},
	solidity: {
		version: "0.8.18",
		settings: { evmVersion: "paris", metadata: { bytecodeHash: "none" }, optimizer: { enabled: true, runs: 200 }, viaIR: true },
	},
	networks: {
		default: { type: "edr-simulated", hardfork: "cancun" },
		hyperevm: { type: "http", chainId: 999, url: rpc, accounts, ...ledger },
		"recovery-archive": { type: "http", chainId: 999, url: archive, accounts: [] },
		...(forkBlock > 0
			? { "recovery-fork": { type: "edr-simulated" as const, chainId: 999, hardfork: "cancun", forking: { url: archive, blockNumber: forkBlock } } }
			: {}),
	},
})
