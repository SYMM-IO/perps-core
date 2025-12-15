import "@nomicfoundation/hardhat-chai-matchers"
import "@nomicfoundation/hardhat-toolbox"
import "@openzeppelin/hardhat-upgrades"
import { config as dotenvConfig } from "dotenv"
import "hardhat-contract-sizer"
import type { HardhatUserConfig } from "hardhat/config"
import { resolve } from "path"
import "solidity-docgen"

import "./tasks/deploy"

// Load environment variables
const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH || "./.env"
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) })

// Environment variables with fallbacks
const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"
const privateKey = process.env.PRIVATE_KEY || DUMMY_PRIVATE_KEY
const privateKeyList = process.env.PRIVATE_KEYS_STR?.split(",") || []
const etherscanApiKey = process.env.ETHERSCAN_API_KEY || ""
const hardhatDockerUrl = process.env.HARDHAT_DOCKER_URL || ""

// Network configuration helper
const createNetworkConfig = (url: string) => ({
	url,
	accounts: [privateKey],
})

// Etherscan custom chains configuration
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
]

const config: HardhatUserConfig = {
	defaultNetwork: "hardhat",

	solidity: {
		version: "0.8.21",
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

	networks: {
		hardhat: {
			allowUnlimitedContractSize: false,
		},
		docker: {
			url: hardhatDockerUrl,
			allowUnlimitedContractSize: false,
			accounts: privateKeyList,
		},
		bsc: createNetworkConfig("https://binance.llamarpc.com"),
		base: createNetworkConfig("https://api.zan.top/base-mainnet"),
		polygon: createNetworkConfig("https://polygon-rpc.com"),
		iota: createNetworkConfig("https://json-rpc.evm.iotaledger.net"),
		blast: createNetworkConfig("https://rpc.blast.io"),
		mode: createNetworkConfig("https://mainnet.mode.network"),
		mantle: createNetworkConfig("https://mantle.drpc.org"),
		mantle2: createNetworkConfig("https://mantle.drpc.org"),
		arbitrum: createNetworkConfig("https://arbitrum.llamarpc.com"),
	},

	etherscan: {
		apiKey: etherscanApiKey,
		customChains,
	},

	paths: {
		artifacts: "./artifacts",
		cache: "./cache",
		sources: "./contracts",
		tests: "./test",
	},

	typechain: {
		outDir: "src/types",
		target: "ethers-v6",
	},

	gasReporter: {
		currency: "USD",
		enabled: false,
		excludeContracts: [],
		src: "./contracts",
	},

	contractSizer: {
		alphaSort: false,
		disambiguatePaths: false,
		runOnCompile: false,
		strict: true,
	},

	mocha: {
		timeout: 100000000,
	},
}

export default config
