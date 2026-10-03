import { submitOperation } from "./operation-transaction.js";
import { Interface, ZeroAddress, getAddress, isHexString, keccak256, parseUnits, formatUnits } from "ethers";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const json = value => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
export const digest = value => createHash("sha256").update(json(value)).digest("hex");
const plain = value => JSON.parse(json(value));
const check = (ok, message) => {
	if (!ok) throw new Error(message);
};
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const PART = "(uint256 id,uint256 amount,int256 chainId,bytes receiver,address virtualProvider,address expressProvider)";
const REQUEST = `(uint256 id,address user,${PART}[] parts,uint256 timestamp,uint256 cooldownEndTime,uint8 status,bool speedUp,bool isCooldownModified,address provider,bool isPureVirtual,bytes providerData,uint256 totalAmount,uint256 totalVirtualAmount,uint256 advancedAmount)`;
export const coreInterface = new Interface([
	"function getCollateral() view returns(address)",
	"function balanceOf(address) view returns(uint256)",
	"function balanceInfoOfPartyA(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
	"function nonceOfPartyA(address) view returns(uint256)",
	"function getMuonConfig() view returns(uint256,uint256)",
	"function getMuonFunctionUpnlValidTime(uint8) view returns(uint256,bool)",
	"function withdrawCooldownOf(address) view returns(uint256)",
	"function deallocateCooldown() view returns(uint256)",
	"function isSuspended(address) view returns(bool)",
	"function isPartyB(address) view returns(bool)",
	"function isLegacyDeallocateDeprecated() view returns(bool)",
	"function facetAddress(bytes4) view returns(address)",
	"function deallocate(uint256,(bytes reqId,uint256 timestamp,int256 upnl,bytes gatewaySignature,(uint256 signature,address owner,address nonce) sigs))",
	"function withdraw(uint256)",
	"function withdrawTo(address,uint256)",
	`function initiateWithdraw(${PART}[] parts,bool speedUp,bytes data) returns(uint256,uint256)`,
	"function finalizeWithdrawRequest(address,uint256)",
	`function getWithdrawRequests(address,uint256) view returns(${REQUEST})`,
	`event WithdrawInitiated(uint256 indexed requestId,address indexed user,${PART}[] parts,bool speedUp,bytes providerData,uint256 cooldownEndTime)`,
	"event DeallocatePartyA(address partyA,uint256 amount,uint256 allocatedBalance)",
	"event Withdraw(address sender,address user,uint256 amount)",
	"event WithdrawFinalized(uint256 indexed requestId,address indexed user)",
]);
export const tokenInterface = new Interface([
	"function decimals() view returns(uint8)",
	"function balanceOf(address) view returns(uint256)",
	"event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export const SOURCE_FILES = [
	"deployment-tooling/core-withdrawal.js",
	"deployment-tooling/operation-transaction.js",
	"deployment-tooling/transaction-receipt.js",
	"tasks/deploy/coreWithdrawal.ts",
	"cli/tasks/core-withdrawal.js",
	"tasks/deploy/tx.ts",
	"tasks/deploy/executionGuard.ts",
	"tasks/deploy/governanceActions.ts",
];
export const sourceDigest = root => digest(SOURCE_FILES.map(f => [f, fs.readFileSync(path.join(root, f), "utf8")]));

export function validateWithdrawalInput(input) {
	check(input?.schema === 1, "Unsupported withdrawal input schema");
	check(Number.isSafeInteger(input.chainId) && input.chainId > 0, "Invalid chain ID");
	check(typeof input.network === "string" && input.network.length > 0, "Network is required");
	for (const name of ["core", "account", "recipient"]) check(getAddress(input[name]) !== ZeroAddress, `Non-zero ${name} required`);
	check(!same(input.recipient, input.core), "Recipient cannot be the Core");
	check(["check", "deallocate", "withdraw", "all"].includes(input.action), "Unknown withdrawal action");
	check(["auto", "legacy", "classic"].includes(input.route), "Unknown withdrawal route");
	check(
		input.amount === "all" ||
			(typeof input.amount === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input.amount) && parseUnits(input.amount, 18) > 0n),
		"Amount must be a positive decimal string or all",
	);
	const url = new URL(input.muonUrl);
	check(
		url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
		"Muon URL must be HTTPS without credentials, query or fragment",
	);
}
async function read(provider, to, iface, name, args, blockTag) {
	return iface.decodeFunctionResult(name, await provider.call({ to, data: iface.encodeFunctionData(name, args), blockTag }));
}
async function facet(provider, core, name, blockTag) {
	return (await read(provider, core, coreInterface, "facetAddress", [coreInterface.getFunction(name).selector], blockTag))[0];
}
export async function readWithdrawalSnapshot(provider, input) {
	validateWithdrawalInput(input);
	check(Number((await provider.getNetwork()).chainId) === input.chainId, "RPC chain ID differs from requested chain");
	const block = await provider.getBlock("latest");
	check(block?.hash, "Missing latest block");
	const tag = block.number;
	const call = (name, args = []) => read(provider, input.core, coreInterface, name, args, tag);
	const [code, accountCode] = await Promise.all([provider.getCode(input.core, tag), provider.getCode(input.account, tag)]);
	check(code !== "0x", "Core has no deployed code");
	const names = [
		"getCollateral",
		"balanceOf",
		"balanceInfoOfPartyA",
		"nonceOfPartyA",
		"getMuonConfig",
		"withdrawCooldownOf",
		"deallocateCooldown",
		"isSuspended",
		"isPartyB",
		"deallocate",
		"withdraw",
		"withdrawTo",
		"initiateWithdraw",
		"finalizeWithdrawRequest",
		"getWithdrawRequests",
		"isLegacyDeallocateDeprecated",
		"getMuonFunctionUpnlValidTime",
	];
	const facets = Object.fromEntries(await Promise.all(names.map(async n => [n, await facet(provider, input.core, n, tag)])));
	for (const n of names.slice(0, 9)) check(!same(facets[n], ZeroAddress), `Core does not expose ${n}`);
	const [collateral, free, info, nonce, muon, lastDeallocation, cooldown, suspended, isPartyB] = await Promise.all([
		call("getCollateral"),
		call("balanceOf", [input.account]),
		call("balanceInfoOfPartyA", [input.account]),
		call("nonceOfPartyA", [input.account]),
		call("getMuonConfig"),
		call("withdrawCooldownOf", [input.account]),
		call("deallocateCooldown"),
		call("isSuspended", [input.account]),
		call("isPartyB", [input.account]),
	]);
	const decimals = Number((await read(provider, collateral[0], tokenInterface, "decimals", [], tag))[0]);
	check(decimals >= 0 && decimals <= 18, "Only collateral with 0–18 decimals is supported");
	const facetCode = Object.fromEntries(
		await Promise.all(
			[...new Set(Object.values(facets).filter(a => !same(a, ZeroAddress)))].map(async a => [a, keccak256(await provider.getCode(a, tag))]),
		),
	);
	// AccountManagement = 1 in MuonFunction. The legacy signature schema is unchanged.
	const upnlValidTime = same(facets.getMuonFunctionUpnlValidTime, ZeroAddress) ? muon[0] : (await call("getMuonFunctionUpnlValidTime", [1]))[0];
	return plain({
		blockNumber: tag,
		blockHash: block.hash,
		timestamp: block.timestamp,
		collateral: collateral[0],
		decimals,
		free: free[0],
		allocated: info[0],
		locked: info.slice(1),
		nonce: nonce[0],
		upnlValidTime: Number(upnlValidTime),
		lastDeallocation: lastDeallocation[0],
		cooldown: Number(cooldown[0]),
		withdrawableAt: Math.max(block.timestamp, Number(lastDeallocation[0] + cooldown[0])),
		suspended: suspended[0],
		isPartyB: isPartyB[0],
		accountCode,
		hasDeallocate: !same(facets.deallocate, ZeroAddress),
		hasLegacy: !same(facets.withdrawTo, ZeroAddress),
		hasClassic: ["initiateWithdraw", "finalizeWithdrawRequest", "getWithdrawRequests"].every(n => !same(facets[n], ZeroAddress)),
		legacyDeallocateDeprecated: same(facets.isLegacyDeallocateDeprecated, ZeroAddress) ? false : (await call("isLegacyDeallocateDeprecated"))[0],
		bindings: {
			coreCode: keccak256(code),
			facets,
			facetCode,
			collateral: collateral[0],
			collateralCode: keccak256(await provider.getCode(collateral[0], tag)),
			decimals,
		},
	});
}
export function buildWithdrawalPlan(input, snapshot) {
	validateWithdrawalInput(input);
	if (input.action !== "check")
		check(snapshot.accountCode === "0x", "Direct wallet accounts only; contract/AccountLayer/Safe accounts need their own caller adapter");
	if (input.action !== "check")
		check(!snapshot.isPartyB, "Party B accounts need solver-specific deallocation; this task handles Party A/direct liquidator balances");
	if (input.action !== "check") check(!snapshot.suspended, "Account is suspended");
	const free = BigInt(snapshot.free),
		allocated = BigInt(snapshot.allocated),
		scale = 10n ** BigInt(18 - snapshot.decimals);
	const available = input.action === "deallocate" ? allocated : input.action === "withdraw" ? free : free + allocated;
	let amount = input.amount === "all" ? available : parseUnits(input.amount, 18);
	if (input.action !== "deallocate") {
		if (input.amount !== "all") check(amount % scale === 0n, "Amount exceeds collateral token decimal precision");
		amount = (amount / scale) * scale;
	}
	check(amount > 0n || input.amount === "all", "Nothing to transfer");
	check(amount <= available, input.action === "withdraw" ? "Amount exceeds free balance; deallocate first" : "Amount exceeds Core balance");
	const deallocate = input.action === "withdraw" ? 0n : input.action === "deallocate" ? amount : amount > free ? amount - free : 0n;
	if (deallocate > 0n && input.action !== "check")
		check(
			snapshot.hasDeallocate && !snapshot.legacyDeallocateDeprecated,
			"Core requires a different deallocation signature/adapter; legacy deallocation unavailable",
		);
	let route = input.route === "auto" ? (snapshot.hasClassic ? "classic" : "legacy") : input.route;
	if (!["deallocate", "check"].includes(input.action) && amount > 0n)
		check(route === "classic" ? snapshot.hasClassic : snapshot.hasLegacy, `Core does not support ${route} withdrawal`);
	const withdrawInternal = input.action === "deallocate" ? 0n : amount;
	const unsigned = {
		schema: 1,
		input,
		baseline: snapshot,
		route,
		deallocate: String(deallocate),
		withdrawInternal: String(withdrawInternal),
		withdrawToken: String(withdrawInternal / scale),
		dust: String(available - amount),
	};
	return { ...unsigned, digest: digest(unsigned) };
}
export function verifyWithdrawalPlan(plan, input) {
	const { digest: hash, ...unsigned } = plan;
	check(digest(unsigned) === hash && digest(plan.input) === digest(input), "Reviewed withdrawal plan or input changed");
}
export function withdrawalReadiness(plan, snapshot, request) {
	if (request) check(Number(request.status) === 0, "Withdrawal request is not PENDING; resolve its status before continuing");
	const readyAt = Number(request?.cooldownEndTime ?? snapshot.withdrawableAt);
	return { ready: snapshot.timestamp >= readyAt, readyAt, secondsRemaining: Math.max(0, readyAt - snapshot.timestamp), route: plan.route };
}
export function mapMuonSignature(response, input, snapshot) {
	check(response?.success === true && response.result?.confirmed === true, "Muon did not return a confirmed signature");
	const r = response.result,
		d = r.data?.result;
	check(r.app === "symmio" && r.method === "uPnl_A", "Unexpected Muon app or method");
	check(
		d && String(d.chainId) === String(input.chainId) && same(d.symmio, input.core) && same(d.partyA, input.account),
		"Muon signature chain/Core/account mismatch",
	);
	check(String(d.nonce) === String(snapshot.nonce), "Muon account nonce is stale");
	check(
		Number.isSafeInteger(r.data.timestamp) &&
			r.data.timestamp <= snapshot.timestamp &&
			r.data.timestamp + snapshot.upnlValidTime >= snapshot.timestamp + 15,
		"Muon signature is expired, future-dated, or has less than 15 seconds remaining",
	);
	check(typeof d.uPnl === "string" && /^-?\d+$/.test(d.uPnl), "Invalid Muon UPNL");
	check(isHexString(r.reqId) && r.reqId !== "0x" && isHexString(r.shieldSignature, 65), "Malformed Muon request ID or gateway signature");
	const sig = r.signatures?.[0];
	check(sig && isHexString(sig.signature, 32), "Malformed Muon Schnorr signature");
	const owner = getAddress(sig.owner),
		nonce = getAddress(r.data.init.nonceAddress);
	check(owner !== ZeroAddress && nonce !== ZeroAddress, "Muon signature contains a zero signer or nonce");
	return {
		reqId: r.reqId,
		timestamp: r.data.timestamp,
		upnl: d.uPnl,
		gatewaySignature: r.shieldSignature,
		sigs: { signature: sig.signature, owner, nonce },
	};
}
export async function fetchMuon(input, fetchImpl = fetch) {
	const url = new URL(input.muonUrl);
	if (url.pathname === "/") url.pathname = "/v1/";
	for (const [k, v] of Object.entries({
		app: "symmio",
		method: "uPnl_A",
		"params[partyA]": input.account,
		"params[chainId]": input.chainId,
		"params[symmio]": input.core,
	}))
		url.searchParams.set(k, String(v));
	const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), redirect: "error" });
	check(response.ok, `Muon request failed with HTTP ${response.status}`);
	return response.json();
}
const actionFor = (input, phase, method, args) => ({
	phase,
	method,
	args,
	to: input.core,
	value: "0",
	data: coreInterface.encodeFunctionData(method, args),
});
const partsFor = plan => [[0, plan.withdrawToken, plan.input.chainId, plan.input.recipient, ZeroAddress, ZeroAddress]];
function events(receipt, address, iface, name) {
	return receipt.logs
		.filter(l => same(l.address, address))
		.flatMap(l => {
			try {
				const parsed = iface.parseLog(l);
				return parsed?.name === name ? [parsed.args] : [];
			} catch {
				return [];
			}
		});
}
export function verifyWithdrawalReceipt(plan, phase, receipt) {
	const i = plan.input;
	if (phase === "deallocate")
		check(
			events(receipt, i.core, coreInterface, "DeallocatePartyA").some(e => same(e.partyA, i.account) && e.amount === BigInt(plan.deallocate)),
			"Receipt lacks exact deallocation event",
		);
	else if (phase === "initiate") {
		const matches = events(receipt, i.core, coreInterface, "WithdrawInitiated").filter(e => same(e.user, i.account));
		check(matches.length === 1, "Receipt lacks unique withdrawal request");
		const e = matches[0],
			p = e.parts;
		check(
			p.length === 1 &&
				p[0].amount === BigInt(plan.withdrawToken) &&
				p[0].chainId === BigInt(i.chainId) &&
				same(p[0].receiver, i.recipient) &&
				same(p[0].virtualProvider, ZeroAddress) &&
				same(p[0].expressProvider, ZeroAddress) &&
				!e.speedUp &&
				e.providerData === "0x",
			"Withdrawal request differs from approved classic part",
		);
		return { id: String(e.requestId), cooldownEndTime: Number(e.cooldownEndTime) };
	} else {
		check(
			events(receipt, i.core, coreInterface, "Withdraw").some(
				e => same(e.sender, i.account) && same(e.user, i.recipient) && e.amount === BigInt(plan.withdrawToken),
			),
			"Receipt lacks exact Core withdrawal event",
		);
		check(
			events(receipt, plan.baseline.collateral, tokenInterface, "Transfer").some(
				e => same(e.from, i.core) && same(e.to, i.recipient) && e.value === BigInt(plan.withdrawToken),
			),
			"Receipt lacks collateral transfer from Core to recipient",
		);
	}
	return null;
}
async function readRequest(provider, plan, id, tag) {
	const r = (await read(provider, plan.input.core, coreInterface, "getWithdrawRequests", [plan.input.account, id], tag))[0];
	check(
		String(r.id) === String(id) &&
			same(r.user, plan.input.account) &&
			r.parts.length === 1 &&
			r.parts[0].amount === BigInt(plan.withdrawToken) &&
			same(r.parts[0].receiver, plan.input.recipient) &&
			r.parts[0].chainId === BigInt(plan.input.chainId) &&
			same(r.provider, ZeroAddress) &&
			same(r.parts[0].virtualProvider, ZeroAddress) &&
			same(r.parts[0].expressProvider, ZeroAddress) &&
			!r.speedUp,
		"On-chain withdrawal request binding differs",
	);
	return { id: String(r.id), status: Number(r.status), cooldownEndTime: Number(r.cooldownEndTime) };
}
function validateBalances(plan, snapshot, operations) {
	const done = p => operations?.[p]?.status === "confirmed";
	const deallocated = done("deallocate") ? BigInt(plan.deallocate) : 0n;
	const debited = done("initiate") || done("withdraw") ? BigInt(plan.withdrawInternal) : 0n;
	check(
		BigInt(snapshot.allocated) === BigInt(plan.baseline.allocated) - deallocated &&
			BigInt(snapshot.free) === BigInt(plan.baseline.free) + deallocated - debited,
		"Core balances changed outside the reviewed operation; reconcile before proceeding",
	);
	check(digest(snapshot.bindings) === digest(plan.baseline.bindings), "Core implementation or collateral changed after review");
	check(!snapshot.suspended && !snapshot.isPartyB && snapshot.accountCode === "0x", "Account authority or status changed");
}
export function withdrawalPreview(plan) {
	return [
		`Network: ${plan.input.network} (${plan.input.chainId})`,
		`Core: ${plan.input.core}`,
		`Signing account: ${plan.input.account}`,
		`Recipient: ${plan.input.recipient}`,
		`Collateral: ${plan.baseline.collateral} (${plan.baseline.decimals} decimals)`,
		`Free: ${formatUnits(plan.baseline.free, 18)}; allocated: ${formatUnits(plan.baseline.allocated, 18)}`,
		`Deallocate: ${formatUnits(plan.deallocate, 18)} (${plan.deallocate} internal units)`,
		`Withdraw: ${formatUnits(plan.withdrawToken, plan.baseline.decimals)} (${plan.withdrawToken} token units)`,
		`Route: ${plan.route}; withdrawal cooldown: ${plan.baseline.cooldown} seconds`,
		`Muon's short-lived signature is fetched immediately before deallocation; calldata is simulated from this signing account.`,
		`Classic: initiateWithdraw, then finalizeWithdrawRequest after cooldown. Legacy: withdrawTo after cooldown.`,
		`Amount is frozen for this run; new earnings are not swept. Left outside the requested amount: ${formatUnits(plan.dust, 18)}.`,
		`Native value: 0. No token approval needed. Plan digest: ${plan.digest}`,
	].join("\n");
}

/** Direct-wallet flow. Persistent operations are reconciled before any new signature or send. */
export async function runWithdrawalPhase({
	provider,
	input,
	report,
	phase,
	save,
	signer,
	execute = false,
	completeRequest,
	send,
	fetchImpl,
	transaction,
	onConfirmed = () => {},
	onProgress = () => {},
}) {
	validateWithdrawalInput(input);
	check(Number((await provider.getNetwork()).chainId) === input.chainId, "RPC chain ID mismatch");
	check(report.inputDigest === digest(input), "Withdrawal input/report changed");
	check(input.action !== "check" || phase === "inspect", "Check-only input cannot run transaction phases");
	if (phase === "inspect") {
		const snapshot = await readWithdrawalSnapshot(provider, input);
		report.snapshot = snapshot;
		if (!report.plan) report.plan = buildWithdrawalPlan(input, snapshot);
		verifyWithdrawalPlan(report.plan, input);
		if (input.action !== "check" && report.plan.route === "legacy" && BigInt(report.plan.withdrawInternal) > 0n) {
			try {
				await provider.call({
					from: input.account,
					to: input.core,
					data: coreInterface.encodeFunctionData("withdrawTo", [input.recipient, 0]),
					blockTag: snapshot.blockNumber,
				});
			} catch (error) {
				if (!String(error.reason || error.message).includes("Cooldown hasn't reached")) throw error;
			}
		}
		save();
		return report;
	}
	check(report.plan, "Inspect before execution");
	verifyWithdrawalPlan(report.plan, input);
	const plan = report.plan;
	const reconcile = async p => {
		const operation = report.operations[p];
		const action = report.actions[p];
		check(action, "Missing saved action for transaction");
		const receipt = await submitOperation({
			provider,
			plan: { input: { operator: input.account, chainId: input.chainId } },
			action,
			report,
			save,
			completeRequest,
			send,
			suppliedHash: phase === p ? transaction : undefined,
			label: "Core withdrawal",
			onProgress,
		});
		const req = verifyWithdrawalReceipt(plan, p, receipt);
		if (req) report.request = req;
		report.proofs ||= {};
		report.proofs[p] = { hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, eventsVerified: true };
		save();
		onConfirmed({
			...operation.journal,
			...operation.intent,
			hash: receipt.hash,
			originalHash: operation.journal?.hash,
			nonce: operation.nonce,
			status: "confirmed",
			blockNumber: receipt.blockNumber,
		});
	};
	for (const p of ["deallocate", "initiate", "withdraw"]) if (report.operations?.[p]) await reconcile(p);
	if (phase === "reconcile") return report;
	const snapshot = await readWithdrawalSnapshot(provider, input);
	report.snapshot = snapshot;
	validateBalances(plan, snapshot, report.operations);
	save();
	const done = p => report.operations?.[p]?.status === "confirmed";
	let request = report.request ? await readRequest(provider, plan, report.request.id, snapshot.blockNumber) : null;
	if (phase === "verify") {
		check(BigInt(plan.deallocate) === 0n || done("deallocate"), "Deallocation not proven");
		check(BigInt(plan.withdrawInternal) === 0n || done("withdraw"), "Withdrawal not proven");
		if (request) check(request.status === 3, "Withdrawal request not completed");
		report.completed = true;
		report.final = snapshot;
		save();
		return report;
	}
	if (phase === "ready") {
		report.readiness = withdrawalReadiness(plan, snapshot, request);
		save();
		return report;
	}
	check(["deallocate", "initiate", "withdraw"].includes(phase), "Unknown withdrawal phase");
	if (done(phase)) return report;
	if (phase === "deallocate" && BigInt(plan.deallocate) === 0n) return report;
	if (phase !== "deallocate" && BigInt(plan.withdrawInternal) === 0n) return report;
	if (phase === "initiate" && plan.route !== "classic") return report;
	if (phase !== "deallocate") check(BigInt(plan.deallocate) === 0n || done("deallocate"), "Deallocate before withdrawing");
	let action;
	if (phase === "deallocate") {
		const response = await fetchMuon(input, fetchImpl);
		const fresh = await readWithdrawalSnapshot(provider, input);
		validateBalances(plan, fresh, report.operations);
		const signature = mapMuonSignature(response, input, fresh);
		report.muon = { response, signature, expiresAt: signature.timestamp + fresh.upnlValidTime };
		save();
		action = actionFor(input, phase, "deallocate", [plan.deallocate, signature]);
	} else if (phase === "initiate") action = actionFor(input, phase, "initiateWithdraw", [partsFor(plan), false, "0x"]);
	else {
		if (plan.route === "classic") check(request, "Initiate a classic withdrawal first");
		report.readiness = withdrawalReadiness(plan, snapshot, request);
		save();
		check(report.readiness.ready, `Withdrawal cooldown ends at ${new Date(report.readiness.readyAt * 1000).toISOString()}; check again then`);
		action =
			plan.route === "classic"
				? actionFor(input, phase, "finalizeWithdrawRequest", [input.account, request.id])
				: actionFor(input, phase, "withdrawTo", [input.recipient, plan.withdrawToken]);
	}
	await provider.call({ from: input.account, to: input.core, data: action.data, value: 0n });
	report.previewAction = action;
	save();
	if (!execute) return report;
	check(report.approvedDigest === plan.digest, "Exact withdrawal plan has not been approved");
	check(signer && same(await signer.getAddress(), input.account), "Signer must be the account that owns the Core balance");
	report.actions ||= {};
	report.actions[phase] = action;
	save();
	// Adapter supplies shared gas/fee completion and write-ahead transaction journal.
	await submitOperation({
		provider,
		signer,
		plan: { input: { operator: input.account, chainId: input.chainId } },
		action,
		report,
		save,
		completeRequest,
		send,
		label: "Core withdrawal",
		onProgress,
	});
	await reconcile(phase);
	const after = await readWithdrawalSnapshot(provider, input);
	validateBalances(plan, after, report.operations);
	if (phase === "withdraw" && plan.route === "classic")
		check((await readRequest(provider, plan, report.request.id, after.blockNumber)).status === 3, "Receipt succeeded but request not completed");
	report.snapshot = after;
	save();
	return report;
}
