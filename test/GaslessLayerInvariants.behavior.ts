import { expect } from "chai"
import { Interface, keccak256 } from "ethers"
import { readFileSync } from "node:fs"

import {
	GOLDEN_WALLET_INITCODE_HASH,
	GOLDEN_WALLET_SALT_FOR_REFERENCE_OWNER,
	REFERENCE_WALLET_OWNER,
	walletSalt,
} from "../scripts/gaslessLayer/gasless-wallet.js"

describe("GaslessWallet frozen bytecode", () => {
	// Every user's deposit address is CREATE2(proxy, salt(owner), keccak256(creationCode)). If the wallet
	// bytecode drifts — an edited wallet, reordered functions, or a codegen-affecting compiler/optimizer
	// change — this hash changes and MOVES every deposit address. Unlike the deterministic-address test in
	// GaslessLayer.test.ts, this reads the compiled artifact and compares to a hard-coded golden literal,
	// so a drift fails loudly instead of both sides moving together. Do NOT "fix" a failure by bumping the
	// constant: a change here is a deliberate, migration-requiring decision.
	it("pins the wallet initcode hash to its golden value", () => {
		const artifact = JSON.parse(readFileSync("artifacts/contracts/gaslessLayer/GaslessWallet.sol/GaslessWallet.json", "utf8"))
		expect(
			keccak256(artifact.bytecode),
			"GaslessWallet bytecode drifted — this MOVES every deposit address. Check solc 0.8.36 / Cancun / viaIR / runs=200 / no metadata, and any edit to GaslessWallet.sol.",
		).to.equal(GOLDEN_WALLET_INITCODE_HASH)
	})

	it("pins the CREATE2 salt scheme to its golden value", () => {
		expect(
			walletSalt(REFERENCE_WALLET_OWNER, 0n),
			"The GaslessWallet salt scheme changed (version tag or abi.encode shape) — this MOVES every deposit address.",
		).to.equal(GOLDEN_WALLET_SALT_FOR_REFERENCE_OWNER)
	})
})

describe("GaslessLayer wallet API", () => {
	it("keeps the original method names with explicit wallet parameters and no aliases or overloads", () => {
		const artifact = JSON.parse(readFileSync("artifacts/contracts/gaslessLayer/GaslessLayer.sol/GaslessLayer.json", "utf8"))
		const abi = new Interface(artifact.abi)
		for (const name of [
			"relayWalletBatch",
			"getWalletAddress",
			"settleWalletDepositToNewAccount",
			"settleWalletDepositToExistingAccount",
			"recoverWalletNonCollateralToken",
			"getAccountOperationalFeeForWallets",
			"getWalletOperationNonce",
		]) {
			expect(abi.getFunction(name), name).to.equal(null)
		}
		const expectedInputs: Record<string, string[]> = {
			relayInstantBatch: ["signedOps", "signatures", "fills", "flexFillerSignatures", "walletIds"],
			getGaslessWalletAddress: ["owner", "walletId"],
			settleDepositToNewAccount: ["owner", "walletIndex", "affiliate", "accountData"],
			settleDepositToExistingAccount: ["owner", "walletIndex", "subAccount"],
			recoverNonCollateralToken: ["owner", "walletId", "token", "recipient"],
			getAccountOperationalFee: ["account", "signedOps", "walletIds"],
			walletOperationNonces: ["owner", "walletId", "signerAccount"],
		}
		for (const [name, inputs] of Object.entries(expectedInputs)) {
			expect(
				abi.getFunction(name)!.inputs.map(input => input.name),
				name,
			).to.deep.equal(inputs)
		}
		const functions = artifact.abi.filter((fragment: any) => fragment.type === "function")
		expect(new Set(functions.map((fragment: any) => fragment.name)).size).to.equal(functions.length)
	})
})
