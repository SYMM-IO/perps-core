import {
	buildWithdrawalPlan,
	validateWithdrawalInput,
	mapMuonSignature,
	withdrawalReadiness,
	fetchMuon,
} from "../../deployment-tooling/core-withdrawal.js";
import assert from "node:assert/strict";
import test from "node:test";

const account = "0x1111111111111111111111111111111111111111";
const core = "0x2222222222222222222222222222222222222222";
const input = () => ({
	schema: 1,
	network: "bsc",
	chainId: 56,
	core,
	account,
	recipient: account,
	amount: "all",
	action: "all",
	route: "auto",
	muonUrl: "https://muon.example/v1/",
});
const snapshot = () => ({
	blockNumber: 100,
	blockHash: "0x" + "ab".repeat(32),
	timestamp: 1000,
	free: "2000000000000000000",
	allocated: "10123456789012345678",
	decimals: 6,
	collateral: "0x3333333333333333333333333333333333333333",
	nonce: "3",
	upnlValidTime: 60,
	cooldown: 43200,
	withdrawableAt: 1000,
	suspended: false,
	isPartyB: false,
	accountCode: "0x",
	locked: Array(8).fill("0"),
	hasClassic: true,
	hasLegacy: true,
	hasDeallocate: true,
	legacyDeallocateDeprecated: false,
	bindings: {},
});
test("all freezes the amount and leaves sub-token precision dust in allocated balance", () => {
	const p = buildWithdrawalPlan(input(), snapshot());
	assert.equal(p.withdrawToken, "12123456");
	assert.equal(p.withdrawInternal, "12123456000000000000");
	assert.equal(p.deallocate, "10123456000000000000");
	assert.equal(p.dust, "789012345678");
	assert.equal(p.route, "classic");
});
test("partial withdrawal uses free funds first; withdraw-only never deallocates", () => {
	const i = input();
	i.amount = "1";
	let p = buildWithdrawalPlan(i, snapshot());
	assert.equal(p.deallocate, "0");
	i.action = "withdraw";
	i.amount = "3";
	assert.throws(() => buildWithdrawalPlan(i, snapshot()), /free balance/);
});
test("invalid decimal, credentials in URL, unsupported accounts and disabled deallocation fail closed", () => {
	for (const amount of [1, "1e3", "-1", "0", "1.1234567"]) {
		const i = input();
		i.amount = amount;
		assert.throws(() => buildWithdrawalPlan(i, snapshot()));
	}
	const i = input();
	i.muonUrl = "https://secret:password@muon.example/";
	assert.throws(() => validateWithdrawalInput(i));
	for (const change of [{ accountCode: "0x6000" }, { isPartyB: true }, { suspended: true }, { legacyDeallocateDeprecated: true }])
		assert.throws(() => buildWithdrawalPlan(input(), { ...snapshot(), ...change }));
});
test("withdrawal readiness uses chain timestamp and classic request cooldown", () => {
	const p = buildWithdrawalPlan(input(), snapshot());
	assert.equal(withdrawalReadiness(p, { ...snapshot(), withdrawableAt: 1100 }).ready, false);
	assert.equal(withdrawalReadiness(p, snapshot(), { cooldownEndTime: 1001, status: 0 }).ready, false);
	assert.equal(withdrawalReadiness(p, snapshot(), { cooldownEndTime: 1000, status: 0 }).ready, true);
	assert.throws(() => withdrawalReadiness(p, snapshot(), { cooldownEndTime: 1, status: 5 }), /status/);
});
const response = () => ({
	success: true,
	result: {
		confirmed: true,
		app: "symmio",
		method: "uPnl_A",
		reqId: "0x1234",
		data: { timestamp: 990, result: { chainId: "56", symmio: core, partyA: account, nonce: "3", uPnl: "0" }, init: { nonceAddress: account } },
		signatures: [{ signature: "0x" + "01".repeat(32), owner: account }],
		shieldSignature: "0x" + "02".repeat(65),
	},
});
test("Muon binds identity, nonce and freshness; malformed or expired responses are rejected", () => {
	const r = response();
	assert.equal(mapMuonSignature(r, input(), snapshot()).upnl, "0");
	for (const mutate of [
		r => (r.success = false),
		r => (r.result.confirmed = false),
		r => (r.result.data.result.chainId = "1"),
		r => (r.result.data.result.symmio = account),
		r => (r.result.data.result.partyA = core),
		r => (r.result.data.result.nonce = "4"),
		r => (r.result.data.timestamp = 900),
		r => (r.result.data.timestamp = 1001),
		r => (r.result.shieldSignature = "0x"),
	]) {
		const r = response();
		mutate(r);
		assert.throws(() => mapMuonSignature(r, input(), snapshot()));
	}
});
test("Muon fetch keeps identity parameters and requests a response without local caching", async () => {
	const r = response();
	assert.equal(
		await fetchMuon(input(), async (url, options) => {
			assert.equal(url.pathname, "/v1/");
			assert.equal(url.searchParams.get("app"), "symmio");
			assert.equal(url.searchParams.get("method"), "uPnl_A");
			assert.equal(url.searchParams.get("params[partyA]"), account);
			assert.equal(url.searchParams.get("params[symmio]"), core);
			assert.equal(url.searchParams.get("params[chainId]"), "56");
			assert.equal(options.cache, "no-store");
			assert.equal(options.redirect, "error");
			return { ok: true, json: async () => r };
		}),
		r,
	);
});
