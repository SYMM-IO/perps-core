import hre from "hardhat"
import fs from "node:fs"
import { performance } from "node:perf_hooks"

const EXPECTED_CHAIN_ID = 42161n
const MAX_BLOCK_AGE_SECONDS = 300
const DEFAULT_TIMEOUT_MS = 15_000

interface ArbitrumRecipe {
	network?: { chainId?: number }
	governance?: { admin?: string }
	core?: { collateral?: { address?: string } }
}

function timeoutMs(): number {
	const raw = process.env.RPC_CHECK_TIMEOUT_MS
	if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS
	if (!/^\d+$/.test(raw)) throw new Error(`RPC_CHECK_TIMEOUT_MS must be a positive integer; received ${JSON.stringify(raw)}`)
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
		throw new Error(`RPC_CHECK_TIMEOUT_MS must be between 1000 and 120000; received ${JSON.stringify(raw)}`)
	}
	return value
}

function loadRecipe(): { collateral: string; admin: string } {
	const recipeUrl = new URL("../deployment-recipes/arbitrum.json", import.meta.url)
	const recipe = JSON.parse(fs.readFileSync(recipeUrl, "utf8")) as ArbitrumRecipe
	if (recipe.network?.chainId !== Number(EXPECTED_CHAIN_ID)) {
		throw new Error(`deployment-recipes/arbitrum.json must target chainId ${EXPECTED_CHAIN_ID}; received ${String(recipe.network?.chainId)}`)
	}
	if (!recipe.core?.collateral?.address) throw new Error("deployment-recipes/arbitrum.json does not declare core.collateral.address")
	if (!recipe.governance?.admin) throw new Error("deployment-recipes/arbitrum.json does not declare governance.admin")
	return { collateral: recipe.core.collateral.address, admin: recipe.governance.admin }
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	return message.replace(/(?:https?|wss?):\/\/[^\s'"`<>]+/giu, "<redacted-rpc-url>")
}

async function timed<T>(label: string, action: () => Promise<T>, requestTimeoutMs: number): Promise<{ value: T; elapsedMs: number }> {
	const started = performance.now()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const value = await Promise.race([
			action(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${requestTimeoutMs.toLocaleString()} ms`)), requestTimeoutMs)
			}),
		])
		return { value, elapsedMs: performance.now() - started }
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function milliseconds(value: number): string {
	return `${Math.round(value).toLocaleString()} ms`
}

async function main(): Promise<void> {
	const requestTimeoutMs = timeoutMs()
	const { collateral, admin } = loadRecipe()
	const connection = await hre.network.getOrCreate()
	const { ethers } = connection
	const provider = ethers.provider

	console.log("Checking Hardhat keystore RPC_ARBITRUM (read-only; endpoint hidden)")

	const network = await timed("eth_chainId", () => provider.getNetwork(), requestTimeoutMs)
	if (network.value.chainId !== EXPECTED_CHAIN_ID) {
		throw new Error(`wrong chain: expected Arbitrum One (${EXPECTED_CHAIN_ID}), received chainId ${network.value.chainId}`)
	}
	console.log(`  PASS chainId ${network.value.chainId} (${milliseconds(network.elapsedMs)})`)

	const headReads: Array<{ blockNumber: number; elapsedMs: number }> = []
	for (let index = 1; index <= 3; index++) {
		const head = await timed(`eth_blockNumber probe ${index}`, () => provider.getBlockNumber(), requestTimeoutMs)
		headReads.push({ blockNumber: head.value, elapsedMs: head.elapsedMs })
	}
	for (let index = 1; index < headReads.length; index++) {
		if (headReads[index].blockNumber < headReads[index - 1].blockNumber) throw new Error("latest block number moved backwards between probes")
	}
	console.log(`  PASS three sequential block reads: ${headReads.map(read => `${read.blockNumber} (${milliseconds(read.elapsedMs)})`).join(", ")}`)

	const latest = await timed("eth_getBlockByNumber", () => provider.getBlock("latest"), requestTimeoutMs)
	if (!latest.value) throw new Error("latest block was not returned")
	const blockAgeSeconds = Math.floor(Date.now() / 1000) - latest.value.timestamp
	if (blockAgeSeconds < -60) throw new Error(`latest block timestamp is ${Math.abs(blockAgeSeconds)} seconds in the future`)
	if (blockAgeSeconds > MAX_BLOCK_AGE_SECONDS) {
		throw new Error(`latest block ${latest.value.number} is stale by ${blockAgeSeconds} seconds (maximum ${MAX_BLOCK_AGE_SECONDS})`)
	}
	console.log(`  PASS latest block ${latest.value.number} is ${Math.max(0, blockAgeSeconds)}s old (${milliseconds(latest.elapsedMs)})`)

	const fees = await timed("fee-data probes", () => provider.getFeeData(), requestTimeoutMs)
	if (fees.value.gasPrice === null && fees.value.maxFeePerGas === null) throw new Error("RPC returned no usable gas price or EIP-1559 fee data")
	console.log(`  PASS fee data available (${milliseconds(fees.elapsedMs)})`)

	const code = await timed("eth_getCode collateral probe", () => provider.getCode(collateral), requestTimeoutMs)
	if (code.value === "0x") throw new Error(`configured collateral ${collateral} has no contract code`)
	console.log(`  PASS configured collateral has contract code (${milliseconds(code.elapsedMs)})`)

	const token = await ethers.getContractAt(
		[
			"function decimals() view returns (uint8)",
			"function totalSupply() view returns (uint256)",
			"function balanceOf(address) view returns (uint256)",
		],
		collateral,
	)
	const erc20 = await timed(
		"parallel ERC-20 probes",
		() => Promise.all([token.decimals(), token.totalSupply(), token.balanceOf(admin)]),
		requestTimeoutMs,
	)
	const [decimals, totalSupply] = erc20.value
	if (Number(decimals) !== 6) throw new Error(`configured Arbitrum USDC returned unexpected decimals=${String(decimals)}; expected 6`)
	if (totalSupply <= 0n) throw new Error("configured Arbitrum USDC returned a zero totalSupply")
	console.log(`  PASS parallel decimals/totalSupply/balanceOf probes (${milliseconds(erc20.elapsedMs)})`)

	console.log("RPC_ARBITRUM is healthy for the deployment preflight. No transaction was sent.")
}

try {
	await main()
} catch (error) {
	console.error(`RPC_ARBITRUM check FAILED: ${safeError(error)}`)
	process.exit(1)
}
