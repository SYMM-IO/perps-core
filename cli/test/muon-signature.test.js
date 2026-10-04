import { assertMuonSignatureFresh, muonSignatureTiming, MuonFreshnessError } from "../../deployment-tooling/muon-signature.js";
import assert from "node:assert/strict";
import test from "node:test";

test("Muon deadline and refresh boundary follow the signed timestamp and effective Core window", () => {
	const snapshot = { timestamp: 1000, upnlValidTime: 60 };
	assert.deepEqual(assertMuonSignatureFresh(955, snapshot), {
		timestamp: 955,
		chainTimestamp: 1000,
		validitySeconds: 60,
		expiresAt: 1015,
		refreshAt: 1000,
		remainingSeconds: 15,
		reason: "fresh",
	});
	for (const [timestamp, reason] of [
		[954, "near_expiry"],
		[940, "near_expiry"],
		[939, "expired"],
		[1001, "future_dated"],
	]) {
		assert.throws(
			() => assertMuonSignatureFresh(timestamp, snapshot),
			error => error instanceof MuonFreshnessError && error.timing.reason === reason,
		);
	}
	assert.equal(muonSignatureTiming(990, { ...snapshot, upnlValidTime: 30 }).expiresAt, 1020);
	assert.equal(muonSignatureTiming(990, { ...snapshot, upnlValidTime: 20 }).reason, "near_expiry");
});
test("malformed timestamps and Core windows are configuration errors, not refreshable expiry", () => {
	for (const [timestamp, snapshot] of [
		["1000", { timestamp: 1000, upnlValidTime: 60 }],
		[-1, { timestamp: 1000, upnlValidTime: 60 }],
		[1000, { timestamp: NaN, upnlValidTime: 60 }],
		[1000, { timestamp: 1000, upnlValidTime: -1 }],
		[Number.MAX_SAFE_INTEGER, { timestamp: 1000, upnlValidTime: 60 }],
	]) {
		assert.throws(
			() => assertMuonSignatureFresh(timestamp, snapshot),
			error => !(error instanceof MuonFreshnessError) && /Invalid/.test(error.message),
		);
	}
});
