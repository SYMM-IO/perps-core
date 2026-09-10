import { AbiCoder, getCreate2Address, keccak256 } from "ethers"

/**
 * Frozen-invariant constants for the GaslessWallet deposit-address derivation.
 *
 * Every user's cross-chain deposit address is:
 *   CREATE2(deployer = GaslessLayer proxy, salt = walletSalt(owner, walletId), GOLDEN_WALLET_INITCODE_HASH)
 * where GOLDEN_WALLET_INITCODE_HASH = keccak256(type(GaslessWallet).creationCode).
 *
 * The wallet bytecode, salt scheme, and pinned toolchain are load-bearing: change any of
 * them and EVERY already-deployed user's deposit address moves. These constants let the test suite and
 * the upgrade script assert the derivation is unchanged, turning "silently moved every address" into a
 * loud failure. Update GOLDEN_WALLET_INITCODE_HASH ONLY as a deliberate, migration-planned decision.
 */
export const GASLESS_WALLET_VERSION = 1n

// keccak256(type(GaslessWallet).creationCode) under solc 0.8.36, Cancun, viaIR, runs=200, no metadata hash.
export const GOLDEN_WALLET_INITCODE_HASH = "0x3f601fa99034209285834aabec34f49354849bbf4fdfdbb92b51f5f9b5064f31"

// A fixed reference owner used to pin the salt scheme and to sanity-check on-chain derivation.
export const REFERENCE_WALLET_OWNER = "0x0000000000000000000000000000000000000001"

// walletSalt(REFERENCE_WALLET_OWNER, 0n) — pins the salt encoding (version tag + abi.encode shape).
export const GOLDEN_WALLET_SALT_FOR_REFERENCE_OWNER = "0xdc793d4f7b4ff4f2f024fe01139004fa590092b087ee5ad69058f84576867384"

/** Wallet 0 is the original owner-only wallet. Every positive index derives an additional wallet. */
export function walletSalt(owner: string, walletId: bigint): string {
	if (walletId === 0n)
		return keccak256(AbiCoder.defaultAbiCoder().encode(["string", "uint256", "address"], ["GaslessQWallet", GASLESS_WALLET_VERSION, owner]))
	return keccak256(
		AbiCoder.defaultAbiCoder().encode(
			["string", "uint256", "address", "uint256"],
			["GaslessQIndexedWallet", GASLESS_WALLET_VERSION, owner, walletId],
		),
	)
}

export function predictWalletAddress(deployer: string, owner: string, walletId: bigint): string {
	return getCreate2Address(deployer, walletSalt(owner, walletId), GOLDEN_WALLET_INITCODE_HASH)
}
