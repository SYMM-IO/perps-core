import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers"
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import hardhatVerify from "@nomicfoundation/hardhat-verify"
import { config as dotenvConfig } from "dotenv"
import { configVariable, defineConfig } from "hardhat/config"
import { resolve } from "node:path"

import { deployTasks } from "./tasks/deploy/index.js"

const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH || "./.env"
dotenvConfig({ path: resolve(process.cwd(), dotenvConfigPath) })

const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"

// Use process.env directly to avoid hardhat-keystore password prompts.
// When USE_KEYSTORE=true, RPC values come from keystore so stale .env values
// cannot shadow the operator-selected endpoint.
const useKeystore = process.env.USE_KEYSTORE === "true"
const keystoreDeployerKey = process.env.KEYSTORE_DEPLOYER_KEY || "NEW_DEPLOYER"
const protocolAdminKey =
	process.env.NEW_DEPLOYER || process.env.TEAM_DEPLOYER || (useKeystore ? configVariable(keystoreDeployerKey) : DUMMY_PRIVATE_KEY)
const migratorKey = process.env.TEAM_MIGRATOR || (useKeystore ? configVariable("TEAM_MIGRATOR") : undefined)
const upgradeOperatorKey = process.env.TEAM_UPGRADE_OPERATOR || (useKeystore ? configVariable("TEAM_UPGRADE_OPERATOR") : undefined)
const proposerKey = process.env.TEAM_PROPOSER || (useKeystore ? configVariable("TEAM_PROPOSER") : undefined)
const etherscanApiKey = process.env.ETHERSCAN_APIKEY || (useKeystore ? configVariable("ETHERSCAN_APIKEY") : "")
const rpcUrl = (network: string, defaultUrl: string) => {
	const envName = `RPC_${network.toUpperCase()}`
	return useKeystore ? configVariable(envName) : process.env[envName] || defaultUrl
}

const createNetworkConfig = (network: string, defaultUrl: string) =>
	({
		type: "http",
		url: rpcUrl(network, defaultUrl),
		accounts: [protocolAdminKey, migratorKey, upgradeOperatorKey, proposerKey].filter(Boolean),
	}) as {
		type: "http"
		url: string
		accounts: string[]
	}

const customChains = [
	{
		network: "base",
		chainId: 8453,
		urls: {
			apiURL: "https://api.basescan.org/api",
			browserURL: "https://basescan.org",
		},
	},
	{
		network: "zkEvm",
		chainId: 1101,
		urls: {
			apiURL: "https://api-zkevm.polygonscan.com/api",
			browserURL: "https://zkevm.polygonscan.com",
		},
	},
	{
		network: "opbnb",
		chainId: 204,
		urls: {
			apiURL: "https://api-opbnb.bscscan.com/api",
			browserURL: "https://opbnb.bscscan.com",
		},
	},
	{
		network: "iota",
		chainId: 8822,
		urls: {
			apiURL: "https://explorer.evm.iota.org/api",
			browserURL: "https://explorer.evm.iota.org",
		},
	},
	{
		network: "mode",
		chainId: 34443,
		urls: {
			apiURL: "https://api.routescan.io/v2/network/mainnet/evm/34443/etherscan",
			browserURL: "https://modescan.io",
		},
	},
	{
		network: "blast",
		chainId: 81457,
		urls: {
			apiURL: "https://api.blastscan.io/api",
			browserURL: "https://blastscan.io",
		},
	},
	{
		network: "mantle",
		chainId: 5000,
		urls: {
			apiURL: "https://api.mantlescan.xyz/api",
			browserURL: "https://mantlescan.xyz",
		},
	},
	{
		network: "hyperevm",
		chainId: 999,
		urls: {
			apiURL: "https://api.hyperevmscan.io/api",
			browserURL: "https://hyperevmscan.io",
		},
	},
	{
		network: "sei",
		chainId: 1329,
		urls: {
			apiURL: "https://seitrace.com/pacific-1/api",
			browserURL: "https://seitrace.com",
		},
	},
	{
		network: "bsc",
		chainId: 56,
		urls: {
			apiURL: "https://api.bscscan.com/api",
			browserURL: "https://bscscan.com",
		},
	},
	{
		network: "coti",
		chainId: 2632500,
		urls: {
			apiURL: "https://mainnet.cotiscan.io/api",
			browserURL: "https://mainnet.cotiscan.io",
		},
	},
	{
		network: "sonic",
		chainId: 146,
		urls: {
			apiURL: "https://api.sonicscan.org/api",
			browserURL: "https://sonicscan.org",
		},
	},
	{
		network: "plasma",
		chainId: 9745,
		urls: {
			apiURL: "https://api.routescan.io/v2/network/mainnet/evm/9745/etherscan",
			browserURL: "https://plasmascan.to",
		},
	},
	{
		network: "bera",
		chainId: 80094,
		urls: {
			apiURL: "https://api.berascan.com/api",
			browserURL: "https://berascan.com",
		},
	},
]

export default defineConfig({
	plugins: [hardhatToolboxMochaEthers, hardhatEthersPlugin, hardhatVerify],
	tasks: deployTasks,
	chainDescriptors: {
		42161: {
			name: "Arbitrum One",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		5000: {
			name: "Mantle",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		8453: {
			name: "Base",
			// Override default chainType (op) to generic. Hardhat 3's config validator
			// only accepts L1 hardfork names in hardforkHistory; the runtime then needs
			// the chainType to match. For our upgrade scripts (view calls + diamondCut)
			// L1 EVM semantics are sufficient.
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		56: {
			name: "BNB Smart Chain",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		146: {
			name: "Sonic",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		9745: {
			name: "Plasma Mainnet Beta",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		80094: {
			name: "Berachain",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
		},
		2632500: {
			name: "COTI",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				blockscout: {
					name: "COTI Scan",
					url: "https://mainnet.cotiscan.io",
					apiUrl: "https://mainnet.cotiscan.io/api",
				},
			},
		},
		999: {
			name: "HyperEVM",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: {
					name: "Hyperevmscan",
					url: "https://hyperevmscan.io",
				},
			},
		},
		1329: {
			name: "Sei",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: {
					name: "Seitrace",
					url: "https://seitrace.com",
				},
			},
		},
	},
	solidity: {
		profiles: {
			default: {
				version: "0.8.18",
				settings: {
					metadata: {
						bytecodeHash: "none",
					},
					optimizer: {
						enabled: true,
						runs: 200,
					},
					viaIR: true,
				},
			},
			production: {
				version: "0.8.18",
				settings: {
					metadata: {
						bytecodeHash: "none",
					},
					optimizer: {
						enabled: true,
						runs: 200,
					},
					viaIR: true,
				},
			},
		},
	},
	networks: {
		default: {
			type: "edr-simulated",
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "shanghai",
		},
		docker: {
			type: "http",
			url: process.env.HARDHAT_DOCKER_URL || "http://localhost:8545",
		},
		bsc: createNetworkConfig("bsc", "https://bsc-rpc.publicnode.com"),
		base: createNetworkConfig("base", "https://mainnet.base.org"),
		sonic: createNetworkConfig("sonic", "https://rpc.soniclabs.com"),
		plasma: createNetworkConfig("plasma", "https://rpc.plasma.to"),
		bera: createNetworkConfig("bera", "https://rpc.berachain.com"),
		polygon: createNetworkConfig("polygon", "https://polygon-rpc.com"),
		iota: createNetworkConfig("iota", "https://json-rpc.evm.iotaledger.net"),
		blast: createNetworkConfig("blast", "https://rpc.blast.io"),
		mode: createNetworkConfig("mode", "https://mainnet.mode.network"),
		mantle: createNetworkConfig("mantle", "https://mantle.drpc.org"),
		mantle2: createNetworkConfig("mantle2", "https://mantle.drpc.org"),
		hyperevm: createNetworkConfig("hyperevm", "https://rpc.hyperliquid.xyz/evm"),
		sei: createNetworkConfig("sei", "https://evm-rpc.sei-apis.com"),
		arbitrum: createNetworkConfig("arbitrum", "https://arbitrum.llamarpc.com"),
		"fork-hyperevm": {
			type: "edr-simulated",
			chainId: 999,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: process.env.RPC_HYPEREVM || "https://rpc.hyperliquid.xyz/evm",
				blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
			},
		},
		coti: createNetworkConfig("coti", "https://mainnet.coti.io/rpc"),
		"fork-arbitrum": {
			type: "edr-simulated",
			chainId: 42161,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("arbitrum", "https://arbitrum.drpc.org"),
				blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
			},
		},
		"fork-base": {
			type: "edr-simulated",
			chainId: 8453,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("base", "https://base.drpc.org"),
				blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
			},
		},
		"fork-bsc": {
			type: "edr-simulated",
			chainId: 56,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("bsc", "https://bsc-rpc.publicnode.com"),
				blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
			},
		},
		"fork-mantle": {
			type: "edr-simulated",
			chainId: 5000,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("mantle", "https://mantle.drpc.org"),
				blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
			},
		},
	},
	verify: {
		etherscan: {
			apiKey: etherscanApiKey,
			// customChains: [...customChains],
		},
	},
	paths: {
		artifacts: "./artifacts",
		cache: "./cache",
		sources: "./contracts",
		tests: "./test/sequential",
	},
	typechain: {
		outDir: resolve(process.cwd(), "src/types"),
	},
	// gasReporter: {
	// 	currency: "USD",
	// 	enabled: false,
	// 	excludeContracts: [],
	// 	src: "./contracts",
	// },
	// contractSizer: {
	// 	alphaSort: false,
	// 	disambiguatePaths: false,
	// 	runOnCompile: false,
	// 	strict: true,
	// },
})
