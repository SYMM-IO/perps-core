import {
	coreInterface,
	tokenInterface,
	digest,
	json,
	SOURCE_FILES,
	validateWithdrawalInput,
	runWithdrawalPhase,
	readWithdrawalSnapshot,
	verifyWithdrawalReceipt,
} from "./core-withdrawal.js";
import { submitOperation } from "./operation-transaction.js";
import { getAddress, ZeroAddress, formatUnits } from "ethers";
import fs from "node:fs";
import path from "node:path";

const check = (ok, message) => {
	if (!ok) throw new Error(message);
};
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const plain = value => JSON.parse(json(value));
export const BATCH_SOURCE_FILES = [
	...SOURCE_FILES,
	"deployment-tooling/batch-withdrawal.js",
	"cli/signer/index.js",
	"tasks/deploy/batchWithdrawal.ts",
	"cli/tasks/batch-withdrawal.js",
];
export const batchSourceDigest = root => digest(BATCH_SOURCE_FILES.map(file => [file, fs.readFileSync(path.join(root, file), "utf8")]));
export const REQUEST_STATUSES = ["PENDING", "PROVIDER_ACCEPTED", "PROVIDER_REJECTED", "COMPLETED", "CANCEL_REQUESTED", "CANCELLED", "SUSPENDED"];
const normalizeRequest = request =>
	plain({
		id: request.id,
		user: request.user,
		parts: request.parts.map(part => ({
			id: part.id,
			amount: part.amount,
			chainId: part.chainId,
			receiver: part.receiver,
			virtualProvider: part.virtualProvider,
			expressProvider: part.expressProvider,
		})),
		timestamp: request.timestamp,
		cooldownEndTime: request.cooldownEndTime,
		status: Number(request.status),
		speedUp: request.speedUp,
		isCooldownModified: request.isCooldownModified,
		provider: request.provider,
		isPureVirtual: request.isPureVirtual,
		providerData: request.providerData,
		totalAmount: request.totalAmount,
		totalVirtualAmount: request.totalVirtualAmount,
		advancedAmount: request.advancedAmount,
	});
export const batchAccountInput = (input, account) => ({
	schema: 1,
	network: input.network,
	chainId: input.chainId,
	core: input.core,
	account: getAddress(account),
	recipient: input.recipientMode === "self" ? getAddress(account) : input.recipient,
	amount: input.amount,
	action: "all",
	route: input.route,
	muonUrl: input.muonUrl,
});
export function validateBatchInput(input) {
	check(
		input?.schema === 1 && Array.isArray(input.accounts) && input.accounts.length > 0 && input.accounts.length <= 100,
		"Choose 1–100 accounts for the batch",
	);
	check(["self", "common"].includes(input.recipientMode), "Invalid batch recipient policy");
	const accounts = input.accounts.map(getAddress);
	check(new Set(accounts).size === accounts.length, "Batch contains duplicate accounts");
	for (const account of accounts) validateWithdrawalInput(batchAccountInput(input, account));
	check(
		Object.keys(input).every(key =>
			["schema", "network", "chainId", "core", "accounts", "recipientMode", "recipient", "amount", "route", "muonUrl"].includes(key),
		),
		"Batch input must contain public configuration only",
	);
}
export function batchPlanDigest(report) {
	return digest({
		inputDigest: report.inputDigest,
		rows: Object.entries(report.rows || {}).map(([account, row]) => [account, row.planDigest || null]),
	});
}
const binding = request =>
	plain({
		id: request.id,
		user: request.user,
		parts: request.parts,
		timestamp: request.timestamp,
		provider: request.provider,
		speedUp: request.speedUp,
		isPureVirtual: request.isPureVirtual,
		providerData: request.providerData,
		totalAmount: request.totalAmount,
		totalVirtualAmount: request.totalVirtualAmount,
		advancedAmount: request.advancedAmount,
	});
async function read(provider, input, name, args, tag) {
	return coreInterface.decodeFunctionResult(
		name,
		await provider.call({ to: input.core, data: coreInterface.encodeFunctionData(name, args), blockTag: tag }),
	);
}
export async function readBatchRequests(provider, input, snapshot) {
	if (!snapshot.hasClassic) return [];
	const tag = snapshot.blockNumber;
	const installed = async name =>
		!same((await read(provider, input, "facetAddress", [coreInterface.getFunction(name).selector], tag))[0], ZeroAddress);
	check(
		await installed("getLastWithdrawRequestId"),
		"Core request counter is unavailable; investigate request history before creating another request",
	);
	const last = (await read(provider, input, "getLastWithdrawRequestId", [input.account], tag))[0];
	check(last <= 10000n, "Request history exceeds 10,000 IDs; inspect it separately before proceeding");
	const batch = await installed("getWithdrawRequestsBatch"),
		requests = [];
	for (let start = 1n; start <= last; start += 50n) {
		const size = last - start + 1n < 50n ? last - start + 1n : 50n;
		if (batch) requests.push(...(await read(provider, input, "getWithdrawRequestsBatch", [input.account, start, size], tag))[0]);
		else
			for (let id = start; id < start + size; id++)
				requests.push((await read(provider, input, "getWithdrawRequests", [input.account, id], tag))[0]);
	}
	check(BigInt(requests.length) === last, "Incomplete withdrawal request history");
	for (let index = 0; index < requests.length; index++)
		check(
			requests[index].id === BigInt(index + 1) && same(requests[index].user, input.account),
			"Request history returned another user or incorrect ID",
		);
	return requests.map(normalizeRequest);
}
function supportedRequest(request, input) {
	const part = request.parts?.[0];
	return (
		request.parts?.length === 1 &&
		same(request.provider, ZeroAddress) &&
		!request.isPureVirtual &&
		!request.speedUp &&
		request.providerData === "0x" &&
		BigInt(request.totalVirtualAmount) === 0n &&
		BigInt(request.advancedAmount) === 0n &&
		part &&
		BigInt(part.amount) > 0n &&
		BigInt(part.amount) === BigInt(request.totalAmount) &&
		BigInt(part.chainId) === BigInt(input.chainId) &&
		same(part.receiver, input.recipient) &&
		same(part.virtualProvider, ZeroAddress) &&
		same(part.expressProvider, ZeroAddress)
	);
}
function rowDigest(row) {
	return digest({
		input: row.input,
		freshPlan: row.fresh.plan.digest,
		requestCount: row.history?.length,
		requests: Object.values(row.requests).map(item => item.binding),
		issues: row.issues,
	});
}
export function unresolvedBatchOperations(report) {
	const unresolved = [];
	for (const row of Object.values(report.rows || {})) {
		for (const [scope, child] of [["fresh", row.fresh], ...Object.entries(row.requests || {})])
			for (const [phase, operation] of Object.entries(child?.operations || {}))
				if (operation.status !== "confirmed")
					unresolved.push({
						account: row.input.account,
						phase: scope === "fresh" ? phase : `request-${scope}`,
						hash: operation.hash || null,
						nonce: operation.nonce,
					});
	}
	return unresolved;
}
function requestState(request, timestamp) {
	if (Number(request.status) === 3) return "completed_elsewhere";
	if ([2, 5].includes(Number(request.status))) return "closed_elsewhere";
	if (Number(request.status) !== 0) return "needs_investigation";
	return timestamp >= Number(request.cooldownEndTime) ? "ready" : "waiting_cooldown";
}
export async function runBatchAccount(options) {
	const { provider, input, report, account, phase, save, execute = false, signer, onConfirmed = () => {}, onProgress = () => {} } = options;
	validateBatchInput(input);
	const address = getAddress(account),
		key = address.toLowerCase(),
		value = batchAccountInput(input, address);
	check(
		input.accounts.some(a => same(a, address)),
		"Account is outside this batch",
	);
	check(report.inputDigest === digest(input), "Batch input changed");
	check(["inspect", "recheck", "process", "withdraw-ready", "reconcile"].includes(phase), "Unknown batch withdrawal phase");
	check(!execute || ["process", "withdraw-ready"].includes(phase), "Inspection and reconciliation cannot execute transactions");
	report.rows ||= {};
	let row = report.rows[key];
	if (!row) {
		check(phase === "inspect", "Inspect this account before processing");
		row = report.rows[key] = {
			input: value,
			status: "inspecting",
			issues: [],
			requests: {},
			fresh: { schema: 1, inputDigest: digest(value), operations: {}, actions: {} },
		};
	}
	check(digest(row.input) === digest(value), "Saved account configuration changed");
	const fresh = async (p, sendEnabled = false) =>
		runWithdrawalPhase({
			...options,
			input: value,
			report: row.fresh,
			phase: p,
			execute: sendEnabled,
			save,
			signer,
			onConfirmed,
			onProgress,
			transaction: options.transactionPhase === p ? options.transaction : undefined,
		});
	try {
		if (phase === "inspect") {
			if (!row.planDigest) {
				await fresh("inspect");
				row.history = await readBatchRequests(provider, value, row.fresh.snapshot);
				for (const request of row.history.filter(r => ![2, 3, 5].includes(Number(r.status)))) {
					if (Number(request.status) === 0 && supportedRequest(request, value)) {
						row.requests[request.id] = { binding: binding(request), current: request, operations: {}, actions: {} };
					} else
						row.issues.push(
							`Request ${request.id}: ${REQUEST_STATUSES[request.status] || "unknown status"}; provider or recipient requires investigation`,
						);
				}
				row.planDigest = rowDigest(row);
			}
		} else {
			check(row.planDigest && row.planDigest === rowDigest(row), "Account plan changed after inspection");
			if (execute) check(report.approvedDigest === batchPlanDigest(report), "Exact batch plan has not been approved");
			if (options.transaction && ["deallocate", "initiate", "withdraw"].includes(options.transactionPhase)) {
				check(row.fresh.operations[options.transactionPhase], "No saved operation for the supplied transaction phase");
				await fresh(options.transactionPhase);
			} else await fresh("reconcile");
		}
		for (const item of Object.values(row.requests)) {
			const action = item.actions.finalize;
			if (item.operations.finalize) {
				check(action, "Missing saved finalization action");
				const receipt = await submitOperation({
					...options,
					report: item,
					action,
					plan: { input: { operator: address, chainId: input.chainId } },
					signer: undefined,
					suppliedHash: options.transactionPhase === `request-${item.binding.id}` ? options.transaction : undefined,
					save,
					label: `Batch request ${item.binding.id}`,
				});
				verifyWithdrawalReceipt(
					{ input: value, route: "classic", withdrawToken: item.binding.totalAmount, baseline: row.fresh.plan.baseline },
					"withdraw",
					receipt,
				);
				check(
					receipt.logs.some(log => {
						try {
							const event = coreInterface.parseLog(log);
							return (
								same(log.address, input.core) &&
								event?.name === "WithdrawFinalized" &&
								String(event.args.requestId) === item.binding.id &&
								same(event.args.user, address)
							);
						} catch {
							return false;
						}
					}),
					"Receipt lacks exact request finalization event",
				);
				item.proof = { hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, eventsVerified: true };
				onConfirmed({
					...item.operations.finalize.journal,
					...item.operations.finalize.intent,
					hash: receipt.hash,
					originalHash: item.operations.finalize.journal?.hash,
					status: "confirmed",
					blockNumber: receipt.blockNumber,
				});
			}
		}
		if (phase === "reconcile") {
			save();
			return report;
		}
		let snapshot = await readWithdrawalSnapshot(provider, value);
		check(digest(snapshot.bindings) === digest(row.fresh.plan.baseline.bindings), "Core implementation or collateral changed after review");
		check(!snapshot.suspended && !snapshot.isPartyB && snapshot.accountCode === "0x", "Account authority or status needs investigation");
		if (snapshot.hasClassic) {
			const last = (await read(provider, value, "getLastWithdrawRequestId", [address], snapshot.blockNumber))[0];
			const known = BigInt(row.fresh.request?.id || row.history.length);
			check(last === known, "Withdrawal request history changed outside this batch; investigate before processing more funds");
		}
		for (const item of Object.values(row.requests)) {
			item.current = normalizeRequest(
				(await read(provider, value, "getWithdrawRequests", [address, item.binding.id], snapshot.blockNumber))[0],
			);
			check(digest(binding(item.current)) === digest(item.binding), "Existing withdrawal request changed its reviewed binding");
			item.status = item.proof ? "completed" : requestState(item.current, snapshot.timestamp);
			item.readyAt = Number(item.current.cooldownEndTime);
			item.remainingSeconds = Math.max(0, item.readyAt - snapshot.timestamp);
			if (item.proof) check(Number(item.current.status) === 3, "Finalized request is no longer completed");
		}
		row.snapshot = snapshot;
		delete row.error;
		if (row.issues.length || Object.values(row.requests).some(item => ["needs_investigation", "closed_elsewhere"].includes(item.status))) {
			row.status = "needs_investigation";
			save();
			return report;
		}
		if (execute) {
			check(signer && same(await signer.getAddress(), address), "Signer does not own this batch account");
			// Existing obligations are handled before creating a request for additional funds.
			for (const item of Object.values(row.requests).filter(item => item.status === "ready")) {
				const action = {
					phase: "finalize",
					to: input.core,
					value: "0",
					data: coreInterface.encodeFunctionData("finalizeWithdrawRequest", [address, item.binding.id]),
				};
				await provider.call({ from: address, to: input.core, data: action.data, value: 0n });
				item.actions.finalize = action;
				save();
				await submitOperation({
					...options,
					report: item,
					action,
					plan: { input: { operator: address, chainId: input.chainId } },
					save,
					label: `Batch request ${item.binding.id}`,
				});
				// Reconciliation verifies event, transfer, request ID and final storage.
				await runBatchAccount({ ...options, phase: "recheck", execute: false, signer: undefined });
			}
			row.fresh.approvedDigest = row.fresh.plan.digest;
			save();
			if (phase === "process") {
				if (BigInt(row.fresh.plan.deallocate) > 0n) await fresh("deallocate", true);
				if (row.fresh.plan.route === "classic" && BigInt(row.fresh.plan.withdrawToken) > 0n) await fresh("initiate", true);
			} else if (
				row.fresh.plan.route === "classic" &&
				!row.fresh.operations.initiate &&
				BigInt(row.fresh.plan.withdrawToken) > 0n &&
				(BigInt(row.fresh.plan.deallocate) === 0n || row.fresh.operations.deallocate?.status === "confirmed") &&
				snapshot.timestamp >= snapshot.withdrawableAt
			) {
				await fresh("initiate", true);
			}
		}
		const freshStarted = BigInt(row.fresh.plan.deallocate) === 0n || row.fresh.operations.deallocate?.status === "confirmed";
		const requestCreated =
			row.fresh.plan.route !== "classic" ||
			BigInt(row.fresh.plan.withdrawToken) === 0n ||
			row.fresh.operations.initiate?.status === "confirmed";
		if (row.fresh.operations.withdraw?.status === "confirmed" || BigInt(row.fresh.plan.withdrawToken) === 0n) await fresh("verify");
		else if (freshStarted && requestCreated) {
			await fresh("ready");
			if (execute && row.fresh.readiness.ready) {
				await fresh("withdraw", true);
				await fresh("verify");
			}
		} else if (freshStarted) {
			row.fresh.readiness = {
				ready: snapshot.timestamp >= snapshot.withdrawableAt,
				readyAt: snapshot.withdrawableAt,
				route: row.fresh.plan.route,
			};
		}
		snapshot = row.fresh.snapshot;
		const waiting = Object.values(row.requests).filter(item => item.status === "waiting_cooldown");
		if (!row.fresh.completed && row.fresh.readiness?.ready === false) waiting.push({ readyAt: row.fresh.readiness.readyAt });
		row.readyAt = waiting.length ? Math.min(...waiting.map(item => item.readyAt)) : null;
		const ready =
			Object.values(row.requests).some(item => item.status === "ready") || (!row.fresh.completed && row.fresh.readiness?.ready === true);
		row.status = ready
			? "ready"
			: waiting.length
				? "waiting_cooldown"
				: row.fresh.completed
					? BigInt(row.fresh.plan.withdrawToken) === 0n && Object.keys(row.requests).length === 0
						? "empty"
						: "completed"
					: "planned";
		row.snapshot = snapshot;
		save();
		return report;
	} catch (error) {
		row.status = "needs_investigation";
		row.error = error.message;
		save();
		throw error;
	}
}
export function batchSummary(report) {
	const rows = Object.values(report.rows || {}),
		totals = { planned: 0n, withdrawn: 0n, settled_elsewhere: 0n, waiting: 0n, ready: 0n, investigate: 0n, unprocessed: 0n };
	const decimals = rows.find(row => row.fresh?.plan)?.fresh.plan.baseline.decimals;
	const lines = rows.map(row => {
		const plan = row.fresh?.plan;
		const compatible =
			!plan ||
			(plan.baseline.decimals === decimals && same(plan.baseline.collateral, rows.find(r => r.fresh?.plan)?.fresh.plan.baseline.collateral));
		check(compatible, "Batch contains different collateral configurations; inspect each account separately");
		let planned = BigInt(plan?.withdrawToken || 0),
			withdrawn = row.fresh?.completed ? planned : 0n;
		const bucket = amount => {
			if (row.status === "needs_investigation") totals.investigate += amount;
			else if (row.fresh?.readiness?.ready === false) totals.waiting += amount;
			else if (row.fresh?.readiness?.ready === true) totals.ready += amount;
			else totals.unprocessed += amount;
		};
		if (!row.fresh?.completed) bucket(planned);
		for (const item of Object.values(row.requests || {})) {
			planned += BigInt(item.binding.totalAmount);
			const amount = BigInt(item.binding.totalAmount);
			if (item.proof) withdrawn += amount;
			else if (item.status === "completed_elsewhere") totals.settled_elsewhere += amount;
			else if (row.status === "needs_investigation" || ["needs_investigation", "closed_elsewhere"].includes(item.status))
				totals.investigate += amount;
			else if (item.status === "waiting_cooldown") totals.waiting += amount;
			else if (item.status === "ready") totals.ready += amount;
			else totals.unprocessed += amount;
		}
		totals.planned += planned;
		totals.withdrawn += withdrawn;
		const requests = Object.values(row.requests || {}).map(
			item =>
				`  Existing request ${item.binding.id} | ${item.status || "reviewed"} | amount ${formatUnits(item.binding.totalAmount, decimals)} | recipient ${item.binding.parts[0].receiver} | cooldown ${new Date(item.readyAt * 1000).toISOString()} | remaining ${item.remainingSeconds} seconds`,
		);
		if (row.fresh?.request)
			requests.push(
				`  New request ${row.fresh.request.id} | ${row.fresh.completed ? "completed" : row.fresh.readiness?.ready ? "ready" : "waiting_cooldown"} | cooldown ${new Date((row.fresh.readiness?.readyAt || row.fresh.request.cooldownEndTime) * 1000).toISOString()}`,
			);
		return [
			`${row.input.account} | ${row.status} | free ${formatUnits(plan?.baseline.free || 0, 18)} | allocated ${formatUnits(plan?.baseline.allocated || 0, 18)} | deallocate ${formatUnits(plan?.deallocate || 0, 18)} | requested ${decimals === undefined ? "unknown" : formatUnits(planned, decimals)} | recipient ${row.input.recipient} | ${row.readyAt ? new Date(row.readyAt * 1000).toISOString() : "—"}${row.error || row.issues?.length ? ` | ${row.error || row.issues.join("; ")}` : ""}`,
			...requests,
		].join("\n");
	});
	return [
		"Account | Status | Core balances and deallocation | Requested collateral | Recipient | Next cooldown end UTC",
		...lines,
		`TOTAL (${decimals ?? "unknown"} token decimals): ${Object.entries(totals)
			.map(([key, value]) => `${key} ${decimals === undefined ? "unknown" : formatUnits(value, decimals)}`)
			.join("; ")}`,
		"Completed elsewhere is reported from Core state; only verified batch transfers contribute to withdrawn totals.",
	].join("\n");
}
