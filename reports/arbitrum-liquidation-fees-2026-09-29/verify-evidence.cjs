const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
const evidence = read("evidence.json");
const ledger = read("fee-ledger.json");
const unit = 10n ** 18n;
const asRaw = value => {
	const [whole, fraction = ""] = value.split(".");
	return BigInt(whole) * unit + BigInt(fraction.padEnd(18, "0"));
};
const keys = ledger.map(row => `${row.core}:${row.transactionHash}:${row.logIndex ?? row.proof}`);
assert.equal(new Set(keys).size, keys.length, "duplicate ledger entries");
assert.equal(ledger.length, 1044);
let totalEarned = 0n;
let totalRemaining = 0n;
for (const [label, deployment] of Object.entries(evidence.deployments)) {
	const rows = ledger.filter(row => row.deployment === label);
	const total = rows.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n);
	assert.equal(total, BigInt(deployment.earnedRaw));
	assert.equal(total, asRaw(deployment.earnedUSDC));
	let remaining = 0n;
	for (const recipient of deployment.recipients) {
		const credits = rows.filter(row => row.recipient === recipient.address);
		assert.equal(
			credits.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n),
			BigInt(recipient.earnedRaw),
		);
		const held = BigInt(recipient.allocatedBalanceOfPartyA) + BigInt(recipient.balanceOf);
		assert.equal(held, asRaw(recipient.remainingUSDC));
		assert.equal(BigInt(recipient.earnedRaw) - held, asRaw(recipient.withdrawnUSDC));
		remaining += held;
	}
	assert.equal(remaining, BigInt(deployment.remainingRaw));
	assert.equal(total - remaining, BigInt(deployment.withdrawnRaw18));
	totalEarned += total;
	totalRemaining += remaining;
}
assert.equal(totalEarned, asRaw(evidence.totals.earnedUSDC));
assert.equal(totalRemaining, asRaw(evidence.totals.remainingUSDC));
assert.equal(totalEarned - totalRemaining, 1288154906n * 10n ** 12n);
assert.equal(evidence.legacyVerification.mismatches, 0);
assert.equal(evidence.legacyVerification.overlappingHistoricalStorageChecks, 788);
for (const core of Object.values(evidence.crossProviderVerification.cores)) {
	for (const check of Object.values(core.verification)) assert.equal(check.same, true);
}
const receipt = evidence.withdrawalReceipts[0];
assert.equal(receipt.status, "0x1");
assert.equal(receipt.transactionHash, "0x58c7ef581c07c455b2ffd30e187422deeb1c608120cf42325d3508e4c8bb4796");
const usdcTransfer = receipt.logs.find(
	log =>
		log.address.toLowerCase() === "0xaf88d065e77c8cc2239327c5edb3a432268e5831" &&
		log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" &&
		log.topics[1].slice(-40) === "8f06459f184553e5d04f07f868720bdacab39395" &&
		log.topics[2].slice(-40) === "b8b9102302f4a0cfc0c531c2f818392d1d2ec162",
);
assert(usdcTransfer, "matching USDC transfer not found");
assert.equal(BigInt(usdcTransfer.data), 1288154906n);
for (const core of Object.values(evidence.zeroAddress.cores)) {
	for (const row of core.rows) {
		assert(!row.error && !row.unsupportedABI, `zero-address read failed: ${row.function}`);
		if (row.function === "getWithdrawableTime") continue; // A timestamp, not a balance.
		if (Array.isArray(row.value)) assert.equal(row.value.length, 0);
		else if (typeof row.value === "object") Object.values(row.value).forEach(value => assert.equal(value, "0"));
		else assert.equal(row.value, "0");
	}
}
assert.equal(evidence.zeroAddress.tokenBalanceRaw, "0");
console.log("Verified 1,044 ledger entries, exact recipient and aggregate reconciliation, withdrawal receipt, and both zero-address audits.");
