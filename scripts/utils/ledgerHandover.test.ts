import assert from "node:assert/strict"
import test from "node:test"

import { ledgerAddressFromOutput, ledgerArguments, ledgerCandidatePaths, receiptHash } from "./ledgerHandover.js"

const ADDRESS = "0x2222222222222222222222222222222222222222"
const HASH = `0x${"ab".repeat(32)}`

test("Ledger handover scans both supported path families without duplicates", () => {
	assert.deepEqual(ledgerCandidatePaths(2), ["m/44'/60'/0'/0/0", "m/44'/60'/1'/0/0", "m/44'/60'/0'/0/1"])
	assert.deepEqual(ledgerArguments("m/44'/60'/7'/0/0"), ["--ledger", "--mnemonic-derivation-path", "m/44'/60'/7'/0/0"])
	assert.throws(() => ledgerCandidatePaths(0), /between 1 and 1000/)
})

test("Ledger handover accepts the final address from noisy mocked cast output", () => {
	assert.equal(ledgerAddressFromOutput(`device opened\naddress ${ADDRESS}\n`, "m/44'/60'/0'/0/0"), ADDRESS)
	assert.throws(() => ledgerAddressFromOutput("device opened but returned no address", "m/44'/60'/0'/0/0"), /did not return/)
})

test("Ledger handover accepts only successful receipt evidence", () => {
	assert.equal(receiptHash(JSON.stringify({ status: "0x1", transactionHash: HASH })), HASH)
	assert.equal(receiptHash(`confirmed transaction ${HASH}`), HASH)
	assert.throws(() => receiptHash(JSON.stringify({ status: "0x0", transactionHash: HASH })), /failed status 0/)
	assert.throws(() => receiptHash("cast said success without evidence"), /without a transaction hash/)
})
