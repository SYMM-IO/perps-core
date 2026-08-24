import { expect } from "chai"
import { keccak256 } from "ethers"
import { readFileSync } from "node:fs"

import {
	GOLDEN_WALLET_INITCODE_HASH,
	GOLDEN_WALLET_SALT_FOR_REFERENCE_OWNER,
	REFERENCE_WALLET_OWNER,
	gaslessWalletSalt,
} from "../scripts/gaslessLayer/gasless-wallet.js"
import { assertGaslessLayerStorageLayoutStable } from "../scripts/gaslessLayer/storage-layout.js"

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
			"GaslessWallet bytecode drifted — this MOVES every deposit address. Check solc 0.8.18 / viaIR / runs=200 / no metadata, and any edit to GaslessWallet.sol.",
		).to.equal(GOLDEN_WALLET_INITCODE_HASH)
	})

	it("pins the CREATE2 salt scheme to its golden value", () => {
		expect(
			gaslessWalletSalt(REFERENCE_WALLET_OWNER),
			"The GaslessWallet salt scheme changed (version tag or abi.encode shape) — this MOVES every deposit address.",
		).to.equal(GOLDEN_WALLET_SALT_FOR_REFERENCE_OWNER)
	})
})

describe("GaslessLayer storage layout", () => {
	// The live UUPS proxy's storage is append-only. A changed existing slot remaps live fee/nonce/quota
	// state onto the wrong slot and corrupts funds on upgrade. This guard diffs the compiled layout against
	// the committed snapshot; regenerate the snapshot only for a deliberate, reviewed change
	// (npm run storage:gasless-layer:snapshot).
	it("stays append-only vs the committed snapshot", () => {
		expect(() => assertGaslessLayerStorageLayoutStable()).to.not.throw()
	})
})
