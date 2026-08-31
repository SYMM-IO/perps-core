// Deployment recipe bootstrap must run before task modules read process.env.
// sort-imports-ignore
import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers"
import hardhatLedgerPlugin from "@nomicfoundation/hardhat-ledger"
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import hardhatVerify from "@nomicfoundation/hardhat-verify"
import { config as dotenvConfig } from "dotenv"
import { configVariable, defineConfig } from "hardhat/config"
import { resolve } from "node:path"

import { activeDeploymentRecipe } from "./tasks/deploy/recipeRuntime.js"
import { deployTasks } from "./tasks/deploy/index.js"

if (!activeDeploymentRecipe) {
	const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH || "./.env"
	// quiet: dotenv v17 logs a summary banner on every load; Hardhat runs are noisy enough.
	dotenvConfig({ path: resolve(process.cwd(), dotenvConfigPath), quiet: true })
}

const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"

function parseBooleanEnv(name: string, fallback = false): boolean {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return fallback
	if (raw === "true") return true
	if (raw === "false") return false
	throw new Error(`${name} must be exactly true or false; received ${JSON.stringify(raw)}.`)
}

function parseForkBlockNumber(): number | undefined {
	const raw = process.env.FORK_BLOCK_NUMBER
	if (raw === undefined || raw === "" || raw === "0") return undefined
	if (!/^\d+$/.test(raw)) throw new Error(`FORK_BLOCK_NUMBER must be a positive whole number; received ${JSON.stringify(raw)}.`)
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`FORK_BLOCK_NUMBER must be a positive safe integer; received ${JSON.stringify(raw)}.`)
	}
	return value
}

function resolveRecipeSecret(name: "deployer" | "rpc" | "explorer"): ReturnType<typeof configVariable> | string | undefined {
	const metadata = activeDeploymentRecipe?.secrets[name]
	if (!metadata) return undefined
	if (metadata.provider === "hardhat-keystore") return configVariable(metadata.key)
	const value = process.env[metadata.key]
	if (!value) {
		throw new Error(
			`Deployment recipe secret ${name} references env://${metadata.key}, but process.env.${metadata.key} is unavailable. ` +
				"Only the exact declared secret key is read; public deployment settings still come exclusively from the JSON recipe.",
		)
	}
	return value
}

export function recipeCredentialPolicy(readOnly: boolean): { deployer: boolean; rpc: true; explorer: boolean } {
	return { deployer: !readOnly, rpc: true, explorer: !readOnly }
}

export function recipeAccountsForNetwork<T>(network: string, recipeNetwork: string, deployerKey: T | undefined, readOnly: boolean): T[] {
	return !readOnly && network === recipeNetwork && deployerKey ? [deployerKey] : []
}

export function recipeAccountsForSimulatedNetwork(readOnly: boolean): [] | undefined {
	return readOnly ? [] : undefined
}

export function recipeAccountsForPersistentLocal(readOnly: boolean): [] | "remote" {
	return readOnly ? [] : "remote"
}

// Recipe mode resolves only its declared secret references. Legacy invocations preserve
// the existing env/keystore behavior when SYMMIO_DEPLOYMENT_RECIPE is absent.
const useKeystore = activeDeploymentRecipe ? false : parseBooleanEnv("USE_KEYSTORE")
const recipeReadOnly = activeDeploymentRecipe ? parseBooleanEnv("SYMMIO_RECIPE_READ_ONLY") : false
const recipeCredentials = recipeCredentialPolicy(recipeReadOnly)
const operatorSignerMode = process.env.SYMMIO_SIGNER_MODE
const safeOnlySigner = operatorSignerMode === "safe-file" || operatorSignerMode === "safe-service"
const keystoreDeployerKey = process.env.KEYSTORE_DEPLOYER_KEY || "NEW_DEPLOYER"
const keystoreAccounts = new Set(
	(process.env.KEYSTORE_ACCOUNTS || keystoreDeployerKey)
		.split(",")
		.map(value => value.trim())
		.filter(Boolean),
)
const optionalKeystoreAccount = (name: string) => (useKeystore && keystoreAccounts.has(name) ? configVariable(name) : undefined)
const configuredProtocolAdminKey =
	recipeReadOnly || safeOnlySigner || operatorSignerMode === "ledger" || operatorSignerMode === "local-node"
		? undefined
		: operatorSignerMode === "private-key"
			? process.env.SYMMIO_EPHEMERAL_PRIVATE_KEY
			: operatorSignerMode === "hardhat-keystore"
				? configVariable(keystoreDeployerKey)
				: activeDeploymentRecipe
					? recipeCredentials.deployer
						? resolveRecipeSecret("deployer")
						: undefined
					: process.env.NEW_DEPLOYER || process.env.TEAM_DEPLOYER || (useKeystore ? configVariable(keystoreDeployerKey) : undefined)
if (operatorSignerMode === "private-key" && !configuredProtocolAdminKey) {
	throw new Error("The selected private-key signer was not hydrated into the operator process")
}
const protocolAdminKey = configuredProtocolAdminKey || DUMMY_PRIVATE_KEY
const migratorKey = activeDeploymentRecipe ? undefined : process.env.TEAM_MIGRATOR || optionalKeystoreAccount("TEAM_MIGRATOR")
const upgradeOperatorKey = activeDeploymentRecipe ? undefined : process.env.TEAM_UPGRADE_OPERATOR || optionalKeystoreAccount("TEAM_UPGRADE_OPERATOR")
const proposerKey = activeDeploymentRecipe ? undefined : process.env.TEAM_PROPOSER || optionalKeystoreAccount("TEAM_PROPOSER")
const etherscanApiKey = activeDeploymentRecipe
	? recipeCredentials.explorer
		? resolveRecipeSecret("explorer") || ""
		: ""
	: process.env.ETHERSCAN_APIKEY || (useKeystore ? configVariable("ETHERSCAN_APIKEY") : "")
const rpcUrl = (network: string, defaultUrl: string, configuredNetwork = network) => {
	if (activeDeploymentRecipe) {
		return configuredNetwork === activeDeploymentRecipe.recipe.network.name ? resolveRecipeSecret("rpc") || defaultUrl : defaultUrl
	}
	const envName = `RPC_${network.toUpperCase()}`
	// The post-deployment verification harness binds bytecode and Hardhat gates to
	// one explicit endpoint, even when USE_KEYSTORE would otherwise select another RPC.
	if (process.env.SYMMIO_RPC_URL_OVERRIDE) return process.env.SYMMIO_RPC_URL_OVERRIDE
	return useKeystore ? configVariable(envName) : process.env[envName] || defaultUrl
}

const accountsForNetwork = (network: string) => {
	if (safeOnlySigner || operatorSignerMode === "ledger") return []
	if (operatorSignerMode === "local-node") return "remote"
	if (activeDeploymentRecipe) {
		return recipeAccountsForNetwork(network, activeDeploymentRecipe.recipe.network.name, configuredProtocolAdminKey, recipeReadOnly)
	}
	return configuredProtocolAdminKey ? [configuredProtocolAdminKey, migratorKey, upgradeOperatorKey, proposerKey].filter(Boolean) : []
}

const simulatedAccounts = () => {
	if (recipeReadOnly || safeOnlySigner || operatorSignerMode === "ledger") return []
	if (configuredProtocolAdminKey && operatorSignerMode && operatorSignerMode !== "local-node") {
		return [{ privateKey: configuredProtocolAdminKey, balance: 10n ** 24n }]
	}
	return undefined
}

const ledgerAddress = operatorSignerMode === "ledger" ? process.env.SYMMIO_LEDGER_ADDRESS : undefined
if (operatorSignerMode === "ledger" && (!ledgerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ledgerAddress))) {
	throw new Error("The selected Ledger signer requires SYMMIO_LEDGER_ADDRESS")
}
const ledgerConfig = ledgerAddress
	? {
			ledgerAccounts: [ledgerAddress],
			...(process.env.SYMMIO_LEDGER_DERIVATION === "legacy"
				? { ledgerOptions: { derivationFunction: (index: number) => `m/44'/60'/0'/${index}` } }
				: {}),
		}
	: { ledgerAccounts: [] as string[] }

const createNetworkConfig = (network: string, chainId: number, defaultUrl: string) =>
	({
		type: "http",
		chainId,
		url: rpcUrl(network, defaultUrl),
		// Never put the repository's public local-only dummy key on a live network. With
		// no configured signer, reads still work and every attempted write fails closed.
		// Signer index 0 is the deployer throughout the task suite. Never let a role key
		// slide into that position when NEW_DEPLOYER/TEAM_DEPLOYER is missing.
		accounts: accountsForNetwork(network),
		...ledgerConfig,
	}) as {
		type: "http"
		chainId: number
		url: string
		accounts: string[]
	}

export default defineConfig({
	plugins: [hardhatToolboxMochaEthers, hardhatEthersPlugin, hardhatLedgerPlugin, hardhatVerify],
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
			blockExplorers: {
				etherscan: { name: "Mantlescan", url: "https://mantlescan.xyz" },
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
			blockExplorers: {
				etherscan: { name: "SonicScan", url: "https://sonicscan.org" },
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
			blockExplorers: {
				etherscan: { name: "PlasmaScan", url: "https://plasmascan.to" },
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
			blockExplorers: {
				etherscan: { name: "BeraScan", url: "https://berascan.com" },
			},
		},
		8822: {
			name: "IOTA EVM",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				blockscout: {
					name: "IOTA EVM Explorer",
					url: "https://explorer.evm.iota.org",
					apiUrl: "https://explorer.evm.iota.org/api",
				},
			},
		},
		34443: {
			name: "Mode",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				blockscout: {
					name: "Mode Explorer",
					url: "https://explorer.mode.network",
					apiUrl: "https://explorer.mode.network/api",
				},
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
					name: "SeiScan",
					url: "https://seiscan.io",
				},
			},
		},
		81457: {
			name: "Blast",
			chainType: "generic",
			hardforkHistory: {
				merge: { blockNumber: 0 },
				shanghai: { blockNumber: 0 },
				cancun: { blockNumber: 0 },
			},
			blockExplorers: {
				etherscan: { name: "Blastscan", url: "https://blastscan.io" },
			},
		},
	},
	// evmVersion "cancun" is load-bearing, not incidental. LibExecutionContext and
	// LibAccountLayerSigner emit EIP-1153 tload/tstore, and solc rejects those below cancun
	// with a hard error and no bytecode (verified on 0.8.36, 2026-08) rather than silently
	// producing something that reverts on chain.
	// Every chain we target supports Cancun except COTI (chain 2632500), which is pre-Shanghai
	// and rejects PUSH0 too -- so it is broken by these settings independently of the transient
	// execution context, and would need its own build at evmVersion "paris" together with
	// persistent-only variants of those two libraries. Full checklist in the PRE-CANCUN PORT
	// block at the top of contracts/core/libraries/LibExecutionContext.sol.
	solidity: {
		profiles: {
			default: {
				compilers: [
					{
						version: "0.8.36",
						settings: {
							evmVersion: "cancun",
							metadata: { bytecodeHash: "none" },
							optimizer: { enabled: true, runs: 200 },
							viaIR: true,
						},
					},
				],
			},
			production: {
				compilers: [
					{
						version: "0.8.36",
						settings: {
							evmVersion: "cancun",
							metadata: { bytecodeHash: "none" },
							optimizer: { enabled: true, runs: 200 },
							viaIR: true,
						},
					},
				],
			},
		},
	},
	networks: {
		default: {
			type: "edr-simulated",
			accounts: simulatedAccounts() ?? recipeAccountsForSimulatedNetwork(recipeReadOnly),
			...ledgerConfig,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
		},
		docker: {
			type: "http",
			url: activeDeploymentRecipe ? rpcUrl("docker", "http://localhost:8545") : process.env.HARDHAT_DOCKER_URL || "http://localhost:8545",
			accounts: accountsForNetwork("docker") as string[],
			...ledgerConfig,
		},
		// A persistent local node (`./node_modules/.bin/hardhat node`). Unlike the in-process `default`
		// network, state survives the task, so a deployment can be inspected afterwards.
		localhost: {
			type: "http",
			chainId: 31337,
			url: activeDeploymentRecipe ? rpcUrl("localhost", "http://127.0.0.1:8545") : process.env.RPC_LOCALHOST || "http://127.0.0.1:8545",
			// A local recipe deliberately uses the unlocked accounts exposed by `hardhat node`.
			// This keeps public development keys out of recipe/task state and makes the persistent-node
			// rehearsal work immediately after starting the node. Every non-local recipe stays on the
			// explicit private-key path and therefore fails closed when its secret is unavailable.
			accounts: (operatorSignerMode
				? accountsForNetwork("localhost")
				: activeDeploymentRecipe?.recipe.network.mode === "local"
					? recipeAccountsForPersistentLocal(recipeReadOnly)
					: activeDeploymentRecipe
						? recipeAccountsForNetwork("localhost", activeDeploymentRecipe.recipe.network.name, protocolAdminKey, recipeReadOnly)
						: [protocolAdminKey, migratorKey, upgradeOperatorKey, proposerKey].filter(Boolean)) as "remote" | string[],
			...ledgerConfig,
		},
		bsc: createNetworkConfig("bsc", 56, "https://bsc-rpc.publicnode.com"),
		base: createNetworkConfig("base", 8453, "https://mainnet.base.org"),
		sonic: createNetworkConfig("sonic", 146, "https://rpc.soniclabs.com"),
		plasma: createNetworkConfig("plasma", 9745, "https://rpc.plasma.to"),
		bera: createNetworkConfig("bera", 80094, "https://rpc.berachain.com"),
		polygon: createNetworkConfig("polygon", 137, "https://polygon-rpc.com"),
		iota: createNetworkConfig("iota", 8822, "https://json-rpc.evm.iotaledger.net"),
		blast: createNetworkConfig("blast", 81457, "https://rpc.blast.io"),
		mode: createNetworkConfig("mode", 34443, "https://mainnet.mode.network"),
		mantle: createNetworkConfig("mantle", 5000, "https://mantle.drpc.org"),
		hyperevm: createNetworkConfig("hyperevm", 999, "https://rpc.hyperliquid.xyz/evm"),
		sei: createNetworkConfig("sei", 1329, "https://evm-rpc.sei-apis.com"),
		arbitrum: createNetworkConfig("arbitrum", 42161, "https://arbitrum.llamarpc.com"),
		"fork-hyperevm": {
			type: "edr-simulated",
			accounts: simulatedAccounts() ?? recipeAccountsForSimulatedNetwork(recipeReadOnly),
			...ledgerConfig,
			chainId: 999,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: false,
			hardfork: "cancun",
			forking: {
				url: activeDeploymentRecipe
					? rpcUrl("hyperevm", "https://rpc.hyperliquid.xyz/evm", "fork-hyperevm")
					: process.env.RPC_HYPEREVM || "https://rpc.hyperliquid.xyz/evm",
				blockNumber: parseForkBlockNumber(),
			},
		},
		coti: createNetworkConfig("coti", 2632500, "https://mainnet.coti.io/rpc"),
		"fork-arbitrum": {
			type: "edr-simulated",
			accounts: simulatedAccounts() ?? recipeAccountsForSimulatedNetwork(recipeReadOnly),
			...ledgerConfig,
			chainId: 42161,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: false,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("arbitrum", "https://arbitrum.drpc.org", "fork-arbitrum"),
				blockNumber: parseForkBlockNumber(),
			},
		},
		"fork-base": {
			type: "edr-simulated",
			accounts: simulatedAccounts() ?? recipeAccountsForSimulatedNetwork(recipeReadOnly),
			...ledgerConfig,
			chainId: 8453,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: false,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("base", "https://base.drpc.org", "fork-base"),
				blockNumber: parseForkBlockNumber(),
			},
		},
		"fork-bsc": {
			type: "edr-simulated",
			accounts: simulatedAccounts() ?? recipeAccountsForSimulatedNetwork(recipeReadOnly),
			...ledgerConfig,
			chainId: 56,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: true,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("bsc", "https://bsc-rpc.publicnode.com", "fork-bsc"),
				blockNumber: parseForkBlockNumber(),
			},
		},
		"fork-mantle": {
			type: "edr-simulated",
			accounts: simulatedAccounts() ?? recipeAccountsForSimulatedNetwork(recipeReadOnly),
			...ledgerConfig,
			chainId: 5000,
			blockGasLimit: 30_000_000,
			allowUnlimitedContractSize: false,
			hardfork: "cancun",
			forking: {
				url: rpcUrl("mantle", "https://mantle.drpc.org", "fork-mantle"),
				blockNumber: parseForkBlockNumber(),
			},
		},
	},
	verify: {
		etherscan: {
			apiKey: etherscanApiKey,
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
		// Solidity 0.8.36 can emit identical inherited event entries more than once.
		// TypeChain preserves those entries, so skip checking generated declarations
		// while continuing to type-check all handwritten operational code.
		tsNocheck: true,
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
