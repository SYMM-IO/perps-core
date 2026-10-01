import { POLICY, buildPlan } from "../../../deployment-tooling/disputed-settlement.js";
import { Interface } from "ethers";
import fs from "node:fs";

const iface = new Interface(JSON.parse(fs.readFileSync(new URL("../../../abis/symmio.json", import.meta.url))));
const address = n => `0x${n.toString(16).padStart(40, "0")}`;
export function settlementFixture() {
	const input = {
		schema: 1,
		policy: POLICY,
		network: "arbitrum",
		chainId: 42161,
		core: address(100),
		accountLayer: address(101),
		collateral: address(102),
		operator: address(103),
		partyA: address(104),
		shares: {
			solver: { pnlBps: 10000, fundingBps: 10000, cvaBps: 10000 },
			liquidator: { basis: "remainderAfterSolver", shareBps: 0, recipient: address(103) },
			remainder: "parent",
		},
	};
	const b = address(105),
		parent = address(106),
		liq = "0x1234";
	const snapshot = {
		blockNumber: 1000,
		blockHash: `0x${"12".repeat(32)}`,
		owner: input.operator,
		collateral: input.collateral,
		hook: input.accountLayer,
		admin: true,
		role: false,
		liquidated: true,
		detail: {
			liquidationId: liq,
			liquidationType: "1",
			upnl: "-2546984315113230816",
			partyAAccumulatedUpnl: "-2546984315113231762",
			involvedPartyBCounts: "1",
			disputed: true,
			liquidationFee: "579974554669832589",
		},
		takeover: { liquidationId: "0x", deallocatedPool: "0", inProgress: false },
		open: "0",
		pending: "0",
		balance: "0",
		reimbursement: "0",
		deferred: "0",
		allocated: "4022547299027307733",
		pause: { globalPaused: false, liquidationPaused: false, accountingPaused: false },
		virtual: { isExists: true, parentAccount: parent },
		parent: { isExists: true, owner: address(107), symmioCore: input.core },
		parentBalance: "123",
		parties: [
			{
				address: b,
				registered: true,
				cross: false,
				liquidated: false,
				crossLiquidated: false,
				allocation: "50",
				settlement: {
					pending: true,
					actualAmount: "-2546984315113231762",
					expectedAmount: "-2546984315113231762",
					cva: "895588429244244328",
				},
			},
		],
		logs: [
			{
				partyA: input.partyA,
				partyB: b,
				quoteId: "725",
				symbolId: "1",
				rawPnl: "1874883799468291126",
				rawFunding: "35900665296388457",
				liquidationId: liq,
			},
			{
				partyA: input.partyA,
				partyB: b,
				quoteId: "775",
				symbolId: "1",
				rawPnl: "618224370980373151",
				rawFunding: "17975479368179028",
				liquidationId: liq,
			},
		],
		quotes: [
			{
				id: "725",
				partyA: input.partyA,
				partyB: b,
				symbolId: "1",
				quoteStatus: "8",
				quantity: "10",
				closedAmount: "10",
				lockedValues: ["599957919494656000"],
			},
			{
				id: "775",
				partyA: input.partyA,
				partyB: b,
				symbolId: "1",
				quoteStatus: "8",
				quantity: "10",
				closedAmount: "10",
				lockedValues: ["295630509749588328"],
			},
		],
		fingerprints: { payment: "code-hash" },
	};
	return { input, snapshot, plan: () => buildPlan(input, snapshot, iface) };
}
