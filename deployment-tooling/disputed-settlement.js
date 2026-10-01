import { Contract, Interface, ZeroAddress, formatUnits, getAddress, id, keccak256, parseUnits, zeroPadValue } from "ethers";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROLE = id("CLEARING_HOUSE_ROLE");
export const POLICY = "configured-liquidation-shares-v1";
export const PHASES = ["grant", "takeover", "payment", "finalize", "cleanup"];
export const json = value => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
export const digest = value => createHash("sha256").update(json(value)).digest("hex");
export const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export const check = (condition, message) => {
	if (!condition) throw new Error(message);
};
export const plain = value => JSON.parse(json(value));
export const SOURCE_FILES = [
	"deployment-tooling/disputed-settlement.js",
	"tasks/deploy/disputedSettlement.ts",
	"tasks/deploy/governanceActions.ts",
	"tasks/deploy/executionGuard.ts",
	"tasks/deploy/tx.ts",
	"cli/tasks/disputed-settlement.js",
	"abis/symmio.json",
	"abis/accountLayer.json",
];
export const sourceDigest = root => digest(SOURCE_FILES.map(file => [file, fs.readFileSync(path.join(root, file), "utf8")]));

function inputAmount(value, label, signed = true) {
	check(
		typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value),
		`${label} must be a decimal string with at most 18 decimal places`,
	);
	const raw = parseUnits(value, 18);
	check(signed || raw >= 0n, `${label} cannot be negative`);
	return raw;
}

export function validateInput(input) {
	check(input.schema === 1 && input.policy === POLICY, "Unsupported settlement input or payout policy");
	check(Number.isSafeInteger(input.chainId) && input.chainId > 0, "Invalid chain ID");
	for (const key of ["core", "partyA", "operator", "accountLayer", "collateral"])
		check(getAddress(input[key]) !== ZeroAddress, `A non-zero ${key} is required`);
	check(
		new Set([input.core, input.partyA, input.operator, input.accountLayer].map(a => a.toLowerCase())).size === 4,
		"Core, account, signer and Account Layer must be distinct",
	);
	const shares = input.shares;
	check(shares && shares.remainder === "parent", "The input file must explicitly return the remainder to the parent account");
	for (const [name, value] of Object.entries({
		pnlBps: shares.solver?.pnlBps,
		fundingBps: shares.solver?.fundingBps,
		cvaBps: shares.solver?.cvaBps,
		liquidatorBps: shares.liquidator?.shareBps,
	}))
		check(Number.isInteger(value) && value >= 0 && value <= 10000, `${name} must be an integer from 0 to 10000 (basis points)`);
	check(["recordedLiquidationFee", "remainderAfterSolver"].includes(shares.liquidator.basis), "Choose the liquidator share basis explicitly");
	if (shares.solver.expectedAmounts !== undefined) {
		const amounts = shares.solver.expectedAmounts;
		check(
			amounts && Object.keys(amounts).length === 3 && ["pnl", "funding", "cva"].every(key => Object.hasOwn(amounts, key)),
			"Solver expectedAmounts must contain pnl, funding and cva",
		);
		for (const component of ["pnl", "funding", "cva"]) inputAmount(amounts[component], `Solver expected ${component}`, component !== "cva");
	}
	if (shares.liquidator.expectedAmount !== undefined) inputAmount(shares.liquidator.expectedAmount, "Liquidator expected amount", false);
	if (shares.liquidator.shareBps > 0) {
		const recipient = getAddress(shares.liquidator.recipient);
		check(
			recipient !== ZeroAddress && ![input.partyA, input.core, input.accountLayer].some(a => sameAddress(a, recipient)),
			"Invalid liquidator recipient",
		);
	}
}

export function contracts(provider, input, root) {
	const loupe = [
		"function facetAddress(bytes4) view returns(address)",
		"function facets() view returns((address facetAddress,bytes4[] functionSelectors)[])",
	];
	return {
		core: new Contract(input.core, [...JSON.parse(fs.readFileSync(path.join(root, "abis/symmio.json"))), ...loupe], provider),
		layer: new Contract(input.accountLayer, [...JSON.parse(fs.readFileSync(path.join(root, "abis/accountLayer.json"))), ...loupe], provider),
	};
}

// Start at the signed liquidation timestamp, including the preceding block. An incomplete
// event history cannot produce a plan: every pending bucket is reconciled below.
export async function liquidationLogs(provider, core, partyA, detail, endBlock, progress = () => {}) {
	let lo = 0,
		hi = endBlock;
	const timestamp = Number(detail.liquidationTimestamp || detail.timestamp);
	check(Number.isSafeInteger(timestamp) && timestamp > 0, "Invalid liquidation timestamp");
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2),
			block = await provider.getBlock(mid);
		check(block, "RPC cannot read historical blocks needed for liquidation discovery");
		if (block.timestamp < timestamp) lo = mid + 1;
		else hi = mid;
	}
	const result = [];
	for (let start = Math.max(0, lo - 1); start <= endBlock; start += 20_000) {
		const end = Math.min(endBlock, start + 19_999);
		progress(`Read liquidation events in blocks ${start}–${end}`);
		const logs = await provider.getLogs({
			address: core.target,
			fromBlock: start,
			toBlock: end,
			topics: [core.interface.getEvent("QuoteLiquidationFundingCalculated").topicHash, zeroPadValue(partyA, 32)],
		});
		for (const log of logs) {
			const event = core.interface.parseLog(log).args;
			if (event.liquidationId === detail.liquidationId)
				result.push(plain({ ...event.toObject(), blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.index }));
		}
	}
	return result;
}

export async function readSnapshot(provider, input, root, plan, progress = () => {}, blockTag = "latest") {
	validateInput(input);
	check(Number((await provider.getNetwork()).chainId) === input.chainId, "Connected chain differs from selected chain");
	const block = await provider.getBlock(blockTag);
	check(block?.hash, "Cannot pin settlement snapshot");
	const at = { blockTag: block.number },
		{ core, layer } = contracts(provider, input, root);
	const read = async (target, fn, ...args) => target[fn](...args, at);
	const fields = {
		owner: () => read(core, "getOwner"),
		collateral: () => read(core, "getCollateral"),
		hook: () => read(core, "getAffiliateHook", ZeroAddress),
		admin: () => read(core, "isRoleAdmin", input.operator, ROLE),
		role: () => read(core, "hasRole", input.operator, ROLE),
		liquidated: () => read(core, "isPartyALiquidated", input.partyA),
		detail: () => read(core, "getLiquidatedStateOfPartyA", input.partyA),
		takeover: () => read(core, "getPartyATakeoverDetails", input.partyA),
		allocated: () => read(core, "allocatedBalanceOfPartyA", input.partyA),
		balance: () => read(core, "balanceOf", input.partyA),
		reimbursement: () => read(core, "partyAReimbursement", input.partyA),
		deferred: () => read(core, "getPartyADeferredBalance", input.partyA),
		open: () => read(core, "partyAPositionsCount", input.partyA),
		pending: () => read(core, "partyAPendingQuotesCount", input.partyA),
		pause: () => read(core, "pauseState"),
		virtual: () => read(layer, "getVirtualAccount", input.partyA),
	};
	const snapshot = { blockNumber: block.number, blockHash: block.hash };
	await Promise.all(
		Object.entries(fields).map(async ([key, fn]) => {
			const value = await fn();
			snapshot[key] = plain(value.toObject ? value.toObject() : value);
		}),
	);
	check(sameAddress(snapshot.hook, input.accountLayer), "Core system hook is not the selected Account Layer");
	check(sameAddress(snapshot.collateral, input.collateral), "Core collateral differs from the input file");
	const parent = plan?.baseline.virtual.parentAccount || snapshot.virtual.parentAccount;
	check(parent !== ZeroAddress, "This workflow requires an existing Account Layer virtual account");
	snapshot.parent = plain((await read(layer, "getSubAccount", parent)).toObject());
	check(sameAddress(snapshot.parent.symmioCore, input.core), "Parent account belongs to a different Core");
	snapshot.parentBalance = String(await read(core, "balanceOf", parent));
	if (input.shares.liquidator.shareBps > 0) {
		const recipient = input.shares.liquidator.recipient;
		check(!sameAddress(recipient, parent), "Use the parent remainder instead of also naming the parent as fee recipient");
		snapshot.feeRecipient = {
			address: recipient,
			allocated: String(await read(core, "allocatedBalanceOfPartyA", recipient)),
			registeredB: await read(core, "isPartyB", recipient),
			liquidated: await read(core, "isPartyALiquidated", recipient),
		};
		check(
			!snapshot.feeRecipient.registeredB && !snapshot.feeRecipient.liquidated,
			"Liquidator recipient must be a non-PartyB account outside liquidation",
		);
	}
	snapshot.logs = plan?.baseline.logs || (await liquidationLogs(provider, core, input.partyA, snapshot.detail, block.number, progress));
	const parties = [...new Set(snapshot.logs.map(l => getAddress(l.partyB)))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	snapshot.parties = await Promise.all(
		parties.map(async address => {
			const [settlements, cross, registered, liquidated, crossLiquidated, allocation] = await Promise.all([
				read(core, "getSettlementStates", input.partyA, [address]),
				read(core, "isCrossPartyB", address),
				read(core, "isPartyB", address),
				read(core, "isPartyBLiquidated", address, input.partyA),
				read(core, "getPartyBCrossLiquidationStatus", address),
				read(core, "allocatedBalanceOfPartyB", address, input.partyA),
			]);
			return plain({ address, settlement: settlements[0].toObject(), cross, registered, liquidated, crossLiquidated, allocation });
		}),
	);
	snapshot.quotes =
		plan?.baseline.quotes || (await Promise.all(snapshot.logs.map(async log => plain((await read(core, "getQuote", log.quoteId)).toObject()))));
	const mutations = ["grantRole", "takeoverPartyALiquidation", "applyClearingHouseSettlement", "settlePartyATakeover", "revokeRole"];
	snapshot.fingerprints = {};
	for (const method of mutations) {
		const facet = await read(core, "facetAddress", core.interface.getFunction(method).selector);
		check(facet !== ZeroAddress, `Core does not support ${method}`);
		const code = await provider.getCode(facet, block.number);
		check(code !== "0x", `Missing ${method} facet bytecode`);
		snapshot.fingerprints[method] = { facet, codeHash: keccak256(code) };
	}
	// Bind every selector on the Account Layer and Core, including settlement hooks and view code.
	for (const [name, contract] of [
		["core", core],
		["accountLayer", layer],
	]) {
		const facets = await contract.facets(at);
		snapshot.fingerprints[name] = await Promise.all(
			facets.map(async f => ({
				address: f.facetAddress,
				selectors: [...f.functionSelectors],
				codeHash: keccak256(await provider.getCode(f.facetAddress, block.number)),
			})),
		);
	}
	check((await provider.getBlock(block.number))?.hash === block.hash, "Snapshot block changed during inspection");
	return snapshot;
}

export function buildPlan(input, s, iface) {
	validateInput(input);
	check(s.admin, "Selected signer cannot administer CLEARING_HOUSE_ROLE");
	check(s.liquidated && s.detail.disputed && !s.takeover.inProgress, "Expected a disputed liquidation without an existing takeover");
	check(
		Number(s.detail.liquidationType) === 1,
		"Only NORMAL disputed liquidation is supported; deficit settlement requires a separate reviewed policy",
	);
	check(BigInt(s.open) === 0n && BigInt(s.pending) === 0n, "Finish liquidating all open and pending quotes before using this workflow");
	check(s.virtual.isExists && s.parent.isExists, "An existing virtual account and parent are required");
	check(!s.pause.globalPaused && !s.pause.liquidationPaused && !s.pause.accountingPaused, "Core is paused for settlement or account cleanup");
	check(
		[s.reimbursement, s.deferred, s.balance, s.takeover.deallocatedPool].every(x => BigInt(x) === 0n),
		"Non-zero balance, reimbursement, deferred balance or takeover pool needs a separate settlement review",
	);
	check(s.logs.length > 0 && s.parties.length === Number(s.detail.involvedPartyBCounts), "Liquidation events do not cover every pending Party B");
	check(new Set(s.logs.map(l => l.quoteId)).size === s.logs.length, "Duplicate quote liquidation evidence");
	const rows = [],
		totals = [];
	let accumulated = 0n;
	for (const party of s.parties) {
		const st = party.settlement;
		check(
			party.registered && !party.cross && !party.liquidated && !party.crossLiquidated,
			"Only registered, solvent isolated Party Bs are supported",
		);
		check(st.pending && st.actualAmount === st.expectedAmount, "Missing or manually adjusted settlement bucket");
		const markets = new Map();
		for (const log of s.logs.filter(l => sameAddress(l.partyB, party.address))) {
			check(
				sameAddress(log.partyA, input.partyA) && log.liquidationId === s.detail.liquidationId,
				"Liquidation evidence belongs to another case",
			);
			const quote = s.quotes.find(q => q.id === log.quoteId);
			check(
				quote &&
					sameAddress(quote.partyA, input.partyA) &&
					sameAddress(quote.partyB, party.address) &&
					quote.symbolId === log.symbolId &&
					Number(quote.quoteStatus) === 8 &&
					quote.closedAmount === quote.quantity,
				"Quote is not fully liquidated for this account and market",
			);
			const market = markets.get(log.symbolId) || { pnl: 0n, funding: 0n, cva: 0n };
			market.pnl += BigInt(log.rawPnl);
			market.funding += BigInt(log.rawFunding);
			market.cva += BigInt(quote.lockedValues.cva ?? quote.lockedValues[0]);
			markets.set(log.symbolId, market);
		}
		const sum = [...markets.values()].reduce((a, b) => ({ pnl: a.pnl + b.pnl, funding: a.funding + b.funding, cva: a.cva + b.cva }), {
			pnl: 0n,
			funding: 0n,
			cva: 0n,
		});
		check(
			sum.pnl + sum.funding === -BigInt(st.actualAmount) && sum.cva === BigInt(st.cva),
			"Event PnL/funding/CVA does not reconcile with the pending settlement",
		);
		const bps = input.shares.solver;
		// Round each per-market signed component toward zero; unallocated dust stays with Party A.
		const calculated = [...markets.entries()].map(([symbolId, m]) => ({
			symbolId,
			recorded: m,
			pnl: (m.pnl * BigInt(bps.pnlBps)) / 10000n,
			funding: (m.funding * BigInt(bps.fundingBps)) / 10000n,
			cva: (m.cva * BigInt(bps.cvaBps)) / 10000n,
		}));
		const paid = calculated.reduce((a, b) => ({ pnl: a.pnl + b.pnl, funding: a.funding + b.funding, cva: a.cva + b.cva }), {
			pnl: 0n,
			funding: 0n,
			cva: 0n,
		});
		const credit = paid.pnl + paid.funding + paid.cva;
		check(credit >= 0n, "A Party B debit requires a separate solvency review");
		accumulated += BigInt(st.expectedAmount);
		totals.push(plain({ partyB: party.address, recorded: sum, markets: calculated, ...paid, credit }));
		for (const market of calculated) {
			const symbolId = market.symbolId;
			rows.push([party.address, input.partyA, symbolId, String(market.pnl + market.cva), String(market.funding), "0"]);
			rows.push([input.partyA, ZeroAddress, symbolId, String(-market.pnl - market.cva), String(-market.funding), "0"]);
		}
	}
	check(accumulated === BigInt(s.detail.partyAAccumulatedUpnl), "Pending settlements do not cover the account accumulated uPNL");
	const solverAmounts = Object.fromEntries(
		["pnl", "funding", "cva"].map(component => [component, totals.reduce((sum, t) => sum + BigInt(t[component]), 0n)]),
	);
	if (input.shares.solver.expectedAmounts !== undefined)
		for (const [component, calculated] of Object.entries(solverAmounts)) {
			const expected = input.shares.solver.expectedAmounts[component];
			check(
				calculated === inputAmount(expected, `Solver expected ${component}`),
				`Solver ${component} calculates to ${formatUnits(calculated, 18)} but the input expects ${expected}; review the amounts and percentages`,
			);
		}
	const solverTotal = totals.reduce((sum, t) => sum + BigInt(t.credit), 0n),
		available = BigInt(s.allocated) - solverTotal;
	check(available >= 0n, "Account collateral cannot cover configured solver shares; refusing to change them automatically");
	const feeBasis = input.shares.liquidator.basis === "recordedLiquidationFee" ? BigInt(s.detail.liquidationFee) : available;
	const liquidatorFee = (feeBasis * BigInt(input.shares.liquidator.shareBps)) / 10000n;
	check(liquidatorFee <= available, "Configured liquidator share exceeds the remaining collateral; review the fee basis or percentage");
	if (input.shares.liquidator.expectedAmount !== undefined)
		check(
			liquidatorFee === inputAmount(input.shares.liquidator.expectedAmount, "Liquidator expected amount", false),
			`Liquidator share calculates to ${formatUnits(liquidatorFee, 18)} but the input expects ${input.shares.liquidator.expectedAmount}; review the amount and percentage`,
		);
	if (liquidatorFee > 0n) {
		check(s.feeRecipient && !s.feeRecipient.registeredB && !s.feeRecipient.liquidated, "Invalid liquidator recipient state");
		rows.push([input.shares.liquidator.recipient, ZeroAddress, "0", "0", "0", String(liquidatorFee)]);
		rows.push([input.partyA, ZeroAddress, "0", "0", "0", String(-liquidatorFee)]);
	}
	// The contract requires contiguous account/allocation groups; combine Party A market rows.
	const grouped = new Map();
	for (const row of rows) {
		const key = row.slice(0, 3).join(":").toLowerCase(),
			previous = grouped.get(key);
		if (previous) for (let j = 3; j < 6; j++) previous[j] = String(BigInt(previous[j]) + BigInt(row[j]));
		else grouped.set(key, [...row]);
	}
	const settlements = [...grouped.values()]
		.filter(row => row.slice(3).some(x => BigInt(x) !== 0n))
		.sort((a, b) => {
			for (let i = 0; i < 3; i++) if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) < BigInt(b[i]) ? -1 : 1;
			return 0;
		});
	for (let component = 3; component < 6; component++)
		check(
			settlements.filter(r => sameAddress(r[0], input.partyA)).reduce((sum, r) => sum + BigInt(r[component]), 0n) <= 0n,
			"Configured shares would credit Party A reimbursement; this requires a separate settlement policy",
		);
	const total = solverTotal + liquidatorFee,
		residual = BigInt(s.allocated) - total;
	check(residual >= 0n, "Account collateral cannot cover the recorded solver claims; refusing a haircut");
	const action = (phase, method, args) => ({
		phase,
		method,
		args,
		from: input.operator,
		to: input.core,
		value: "0",
		data: iface.encodeFunctionData(method, args),
	});
	const actions = [
		...(!s.role ? [action("grant", "grantRole", [input.operator, ROLE])] : []),
		action("takeover", "takeoverPartyALiquidation", [input.partyA]),
		...(settlements.length ? [action("payment", "applyClearingHouseSettlement", [input.partyA, settlements])] : []),
		action("finalize", "settlePartyATakeover", [input.partyA, s.parties.map(p => p.address)]),
		...(!s.role ? [action("cleanup", "revokeRole", [input.operator, ROLE])] : []),
	];
	const plan = plain({
		schema: 1,
		input,
		baseline: s,
		liquidationId: s.detail.liquidationId,
		totals,
		solverAmounts,
		solverTotal,
		total,
		residual,
		originalLiquidatorFee: s.detail.liquidationFee,
		liquidatorBasisAmount: feeBasis,
		liquidatorFee,
		actions,
	});
	return { ...plan, digest: digest(plan) };
}

export function verifyPlan(plan, input) {
	const { digest: expected, ...body } = plan;
	check(digest(body) === expected && digest(plan.input) === digest(input), "Reviewed settlement plan or input changed");
}

export function validateStage(plan, s, completed = []) {
	const b = plan.baseline,
		paid = completed.includes("payment"),
		finalized = completed.includes("finalize"),
		taken = completed.includes("takeover");
	check(
		digest(s.fingerprints) === digest(b.fingerprints) &&
			sameAddress(s.collateral, b.collateral) &&
			sameAddress(s.hook, b.hook) &&
			sameAddress(s.owner, b.owner),
		"Contract code, wiring or owner changed since review",
	);
	check(s.admin, "Operator no longer administers the clearing-house role");
	check(BigInt(s.open) === 0n && BigInt(s.pending) === 0n, "Account gained open or pending positions");
	check(!s.pause.globalPaused && !s.pause.liquidationPaused && !s.pause.accountingPaused, "Core settlement or cleanup is paused");
	check(
		s.parent.isExists && sameAddress(s.parent.owner, b.parent.owner) && sameAddress(s.parent.symmioCore, plan.input.core),
		"Parent identity changed",
	);
	if (BigInt(plan.liquidatorFee) > 0n)
		check(
			s.feeRecipient &&
				!s.feeRecipient.registeredB &&
				!s.feeRecipient.liquidated &&
				sameAddress(s.feeRecipient.address, b.feeRecipient.address),
			"Liquidator recipient identity or routing changed",
		);
	check(
		[s.balance, s.reimbursement, s.deferred, s.takeover.deallocatedPool].every(x => BigInt(x) === 0n),
		"Unexpected account funds or clearing-house pool",
	);
	check(
		s.liquidated === !finalized && s.takeover.inProgress === (taken && !finalized),
		"Liquidation/takeover differs from this task's confirmed receipts",
	);
	check(
		s.role === (completed.includes("cleanup") ? b.role : completed.includes("grant") || b.role),
		"Clearing-house role changed outside this task",
	);
	if (!finalized) {
		const expected = { ...b.detail, disputed: !taken, liquidationFee: taken ? "0" : b.detail.liquidationFee };
		check(digest(s.detail) === digest(expected), "Liquidation ID or economics changed since review");
		check(s.virtual.isExists && sameAddress(s.virtual.parentAccount, b.virtual.parentAccount), "Virtual account changed");
		if (taken) check(s.takeover.liquidationId === plan.liquidationId, "Takeover liquidation ID changed");
	} else {
		check(
			!s.detail.disputed && s.detail.liquidationId === "0x" && s.takeover.liquidationId === "0x" && !s.virtual.isExists,
			"Final liquidation state or virtual-account cleanup is incomplete",
		);
	}
	check(
		BigInt(s.allocated) === (finalized ? 0n : BigInt(b.allocated) - (paid ? BigInt(plan.total) : 0n)),
		"Party A allocation differs from confirmed settlement",
	);
	// Other users may change a solver/parent balance between transactions. The runtime
	// verifies exact transaction-local account credits and the parent transfer in receipt events.
	check(s.parties.length === b.parties.length, "Party B list changed");
	for (let i = 0; i < s.parties.length; i++) {
		const p = s.parties[i],
			before = b.parties[i];
		check(
			sameAddress(p.address, before.address) && p.registered && !p.cross && !p.liquidated && !p.crossLiquidated,
			"Party B identity or liquidation mode changed",
		);
		check(
			finalized
				? !p.settlement.pending &&
						BigInt(p.settlement.actualAmount) === 0n &&
						BigInt(p.settlement.expectedAmount) === 0n &&
						BigInt(p.settlement.cva) === 0n
				: digest(p.settlement) === digest(before.settlement),
			"Pending settlement bucket changed",
		);
	}
}

export function verifyOperationEvents(plan, action, receipt, iface) {
	check(Number(receipt.status) === 1, "Settlement transaction reverted");
	const events = receipt.logs
		.filter(l => sameAddress(l.address, plan.input.core))
		.flatMap(l => {
			try {
				const e = iface.parseLog(l);
				return e ? [e] : [];
			} catch {
				return [];
			}
		});
	const matching = name => events.filter(e => e.name === name);
	if (["grant", "cleanup"].includes(action.phase)) {
		check(
			matching(action.phase === "grant" ? "RoleGranted" : "RoleRevoked").some(
				e => e.args.role === ROLE && sameAddress(e.args.user, plan.input.operator),
			),
			"Role receipt lacks the exact operator/role event",
		);
	} else if (action.phase === "payment") {
		const rows = matching("ClearingHouseSettlementComponent").map(e => [
			e.args.account,
			e.args.allocationKey,
			String(e.args.symbolId),
			String(e.args.realizedPnl),
			String(e.args.funding),
			String(e.args.platformFee),
		]);
		check(
			matching("ClearingHouseSettlementComponent").every(e => sameAddress(e.args.subject, plan.input.partyA)) &&
				json(rows).toLowerCase() === json(action.args[1]).toLowerCase(),
			"Receipt settlement components differ from the reviewed payment",
		);
		const expected = new Map();
		for (const row of action.args[1]) {
			const key = `${row[0]}:${row[1]}`.toLowerCase();
			expected.set(key, (expected.get(key) || 0n) + BigInt(row[3]) + BigInt(row[4]) + BigInt(row[5]));
		}
		const accounts = matching("ClearingHouseAccountSettlement");
		check(accounts.length === expected.size, "Receipt is missing account settlement totals");
		for (const event of accounts) {
			const key = `${event.args.account}:${event.args.allocationKey}`.toLowerCase();
			check(
				sameAddress(event.args.subject, plan.input.partyA) && expected.get(key) === event.args.amount,
				"Receipt account credit differs from reviewed shares",
			);
			expected.delete(key);
		}
		check(expected.size === 0, "Receipt duplicated an account settlement");
	} else {
		const name = action.phase === "takeover" ? "TakeoverPartyALiquidation" : "SettlePartyATakeover";
		check(
			matching(name).length === 1 &&
				sameAddress(matching(name)[0].args.partyA, plan.input.partyA) &&
				matching(name)[0].args.liquidationId === plan.liquidationId,
			"Receipt lacks the exact liquidation event",
		);
		if (action.phase === "finalize" && BigInt(plan.residual) > 0n)
			check(
				matching("InternalTransferToBalance").some(
					e =>
						sameAddress(e.args.sender, plan.input.partyA) &&
						sameAddress(e.args.user, plan.baseline.virtual.parentAccount) &&
						e.args.amount === BigInt(plan.residual),
				),
				"Receipt lacks the exact remainder transfer to the parent",
			);
	}
}

// An uncertain send is never retried. Reconciliation needs the original/replacement hash
// and proves the entire transaction intent, nonce, receipt and canonical block.
export async function submitOperation({ provider, signer, plan, action, report, save, completeRequest, send, suppliedHash }) {
	const from = plan.input.operator,
		intent = { from, to: action.to, data: action.data, value: action.value, chainId: plan.input.chainId };
	report.operations ||= {};
	let operation = report.operations[action.phase];
	if (operation) check(digest(operation.intent) === digest(intent), "Saved transaction intent changed");
	else {
		check(signer && sameAddress(await signer.getAddress(), from), "Connected signer differs from the reviewed operator");
		const request = await completeRequest(provider, { from, to: action.to, data: action.data, value: BigInt(action.value) });
		operation = report.operations[action.phase] = { intent, nonce: await provider.getTransactionCount(from, "pending"), status: "prepared" };
		save();
		let response;
		try {
			response = await signer.sendTransaction({ ...request, nonce: operation.nonce, chainId: plan.input.chainId });
		} catch (error) {
			// An explicit device rejection did not submit. Other errors retain the intent.
			if (error.code === "ACTION_REJECTED") {
				delete report.operations[action.phase];
				save();
			}
			throw error;
		}
		operation.hash = response.hash;
		operation.status = "submitted";
		save();
		const receipt = await send(Promise.resolve(response), `disputed settlement ${action.phase}`, 1, {
			onSubmitted: record => {
				operation.journal = record;
				save();
			},
		});
		operation.hash = receipt.hash;
		save();
	}
	const hash = suppliedHash || operation.hash;
	check(
		/^0x[0-9a-fA-F]{64}$/.test(hash || ""),
		`Interrupted ${action.phase} at nonce ${operation.nonce}: provide the original or replacement transaction hash; no automatic resend`,
	);
	const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
	check(
		tx &&
			sameAddress(tx.from, from) &&
			sameAddress(tx.to, intent.to) &&
			tx.data.toLowerCase() === intent.data.toLowerCase() &&
			BigInt(tx.value) === BigInt(intent.value) &&
			tx.nonce === operation.nonce &&
			Number(tx.chainId) === intent.chainId,
		"Reconciliation transaction does not match the reviewed intent and nonce",
	);
	check(receipt && Number(receipt.status) === 1, "Transaction is pending, missing or reverted; resolve it before continuing");
	check((await provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash, "Receipt is not on the canonical chain");
	Object.assign(operation, { hash, status: "confirmed", blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
	if (operation.journal) {
		operation.journal.status = "confirmed";
		operation.journal.replacementHash = hash === operation.journal.hash ? undefined : hash;
	}
	save();
	return receipt;
}
