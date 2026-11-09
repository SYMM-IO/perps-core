// Generated from docs/annotation-decisions.json. Run node docs/check-annotations.mjs --write.
window.__DOC_ANNOTATION_RECORDS__ = {
	"deployment-guide": [],
	index: [],
	"v0.8.5/account-layer": [
		{
			id: "v085-market-default-creates-new-va",
			form: "highlight",
			sourceQuote:
				"Without Single VA Mode (the default), each sendQuote creates a new VA even if one already exists for that market. With Single VA Mode enabled, subsequent quotes for the same market route to the existing active VA. This setting can be toggled when no VAs are active on the SubAccount.",
			targetQuote: "Without Single VA Mode (the default), each sendQuote creates a new VA even if one already exists for that market.",
			sectionId: "doc-account-layer-market-one-va-per-market",
			placement: "mark",
		},
	],
	"v0.8.5/accumulated-funding": [],
	"v0.8.5/adl-close": [],
	"v0.8.5/affiliate-fees": [],
	"v0.8.5/aggregated-positions": [],
	"v0.8.5/batch-positions": [],
	"v0.8.5/clearing-house": [
		{
			id: "v085-clearinghouse-repeatable-intermediate-steps",
			form: "underline",
			sourceQuote:
				"Steps 2–5 are repeatable and can be called in any order and multiple times. The settlement step (6) requires all positions closed and the deallocated pool fully distributed.",
			targetQuote: "can be called in any order and multiple times",
			sectionId: "doc-clearing-house-lifecycle",
			placement: "mark",
		},
	],
	"v0.8.5/cross-mode-liquidation-settlement": [],
	"v0.8.5/cross-party-b": [],
	"v0.8.5/custom-quote-data": [],
	"v0.8.5/event-changelog": [],
	"v0.8.5/express-deposit": [],
	"v0.8.5/external-transfer": [],
	"v0.8.5/hook-system": [],
	"v0.8.5/index": [],
	"v0.8.5/instant-layer-overview": [
		{
			id: "v085-signed-operation-no-cancellation",
			form: "highlight",
			sourceQuote:
				"Every execution still requires current authorization, target whitelist, replay checks and downstream state guards. A fixed nonzero nonce succeeds only once, even if maxUses > 1; repeatable operations therefore use nonce zero. There is no direct operation-hash cancellation API, but delegation or role changes can invalidate execution. A zero deadline disables operation expiry.",
			targetQuote: "There is no direct operation-hash cancellation API, but delegation or role changes can invalidate execution.",
			sectionId: "doc-instant-layer-overview-multi-use-operations",
			placement: "mark",
		},
	],
	"v0.8.5/instant-layer-partyb-integration": [],
	"v0.8.5/instant-layer-service-integration": [],
	"v0.8.5/liquidation-escrow": [],
	"v0.8.5/liquidation-insurance": [],
	"v0.8.5/migration": [],
	"v0.8.5/muon-keys": [
		{
			id: "v085-muon-permissions-survive-key-removal",
			form: "underline",
			sourceQuote:
				"The publicKeyPermissions mapping uses keccak256(abi.encodePacked(pubKey.x, pubKey.parity)) as the key identifier. Permission state is independent of the key lifecycle — permissions can be set before a key is added and persist after removal.",
			targetQuote: "persist after removal",
			sectionId: "doc-muon-keys-the-muonsignatureverifier-contract",
			placement: "mark",
		},
	],
	"v0.8.5/oracle-less-trading": [],
	"v0.8.5/pledge": [],
	"v0.8.5/role-admin-system": [],
	"v0.8.5/safe-deallocate": [],
	"v0.8.5/setup-task": [],
	"v0.8.5/soft-liquidation": [],
	"v0.8.5/symbol-types": [],
	"v0.8.5/two-step-ownership": [],
	"v0.8.5/va-lifecycle-hooks": [],
	"v0.8.5/virtual-funds": [
		{
			id: "v085-virtual-deposit-event-collateral-scale",
			form: "underline",
			sourceQuote:
				"The amount parameter is in 18-decimal precision (not collateral decimals). The emitted Deposit event converts back to collateral decimals for backward compatibility and includes an isVirtual = true flag:",
			targetQuote: "converts back to collateral decimals",
			sectionId: "doc-virtual-funds-virtualdepositfor",
			placement: "mark",
		},
	],
	"v0.8.5/withdraw-system": [],
	"v0.8.6/account-layer-ownership-delegation": [
		{
			id: "v086-transfer-surviving-delegations",
			form: "highlight",
			sourceQuote: "Existing InstantLayer delegations intentionally remain active after the transfer. See the security note below.",
			targetQuote: "Existing InstantLayer delegations intentionally remain active after the transfer.",
			sectionId: "ownership-resolution",
			placement: "mark",
		},
	],
	"v0.8.6/accountlayer-behavior-changes": [],
	"v0.8.6/accountlayer-callback-liveness": [
		{
			id: "v086-callback-atomic-facet-upgrade",
			form: "highlight",
			sourceQuote:
				"Rebuild and replace CoreFacet, AffiliateFacet, MarginFacet, and SymmioHookFacet atomically. LibAccountLayerUtils and LibAccountLayerSigner are internal libraries whose changed code is inlined into those facet artifacts; they are not separately deployed. New callback code paired with old forwarding cannot identify an allowed core. New forwarding paired with old callback code still hits the original reentrancy failure.",
			targetQuote: "Rebuild and replace CoreFacet, AffiliateFacet, MarginFacet, and SymmioHookFacet atomically.",
			sectionId: "upgrade",
			placement: "mark",
		},
	],
	"v0.8.6/accountlayer-timelock": [
		{
			id: "v086-timelock-approvals-survive-policy-change",
			form: "underline",
			sourceQuote:
				"Setting up or clearing selector timelocks invalidates old schedules for the account family. It does not cancel outstanding signed approvals. An unused approval can still be submitted until its deadline. For it to satisfy a call’s timelock, its signer must still be the unlocker required by the current settings.",
			targetQuote: "does not cancel outstanding signed approvals",
			sectionId: "execute-timelock-op",
			placement: "mark",
		},
	],
	"v0.8.6/affiliate-shutdown-flow": [
		{
			id: "v086-affiliate-notice-period-not-enforced",
			form: "underline",
			sourceQuote:
				"The protocol does not decide the notice period. The affiliate chooses the timestamp, and the contract only requires it to be nonzero.",
			targetQuote: "only requires it to be nonzero",
			sectionId: "flow",
			placement: "mark",
		},
	],
	"v0.8.6/balance-change-event-cleanup": [],
	"v0.8.6/bound-mode-unified-settlement": [],
	"v0.8.6/close-settlement-netting": [
		{
			id: "v086-compare-single-and-cross-quote-netting",
			form: "note",
			sourceQuote:
				"A later quote cannot fund an earlier quote’s obligation. For example, if quote one requires PartyB to pay 80 and quote two would later pay PartyB 90, PartyB must still cover quote one’s own net when quote one executes.",
			targetQuote: "",
			sectionId: "batch-behavior",
			note: "Compare this two-quote example with the single-quote 70 / 80 / 90 case.",
			placement: "before",
			links: [
				{
					label: "single-quote 70 / 80 / 90 case",
					href: "#problem",
				},
			],
		},
	],
	"v0.8.6/close-to-liquidation": [
		{
			id: "v086-can-close-all-overshoot-solvency",
			form: "underline",
			sourceQuote:
				"The preview applies the same fallback. Its canCloseAll result means the full pending close fits within the configured allowance. With a nonzero overshoot, it does not mean PartyA remains solvent after that close.",
			targetQuote: "does not mean PartyA remains solvent after that close",
			sectionId: "fallback",
			placement: "mark",
		},
	],
	"v0.8.6/cross-partyb-liquidation-reserve": [],
	"v0.8.6/delegation-account-scope": [],
	"v0.8.6/diamond-owner-getter": [],
	"v0.8.6/diamond-role-management": [],
	"v0.8.6/explicit-clearing-house-settlements": [],
	"v0.8.6/express-deposit-removal": [],
	"v0.8.6/express-withdrawal-system-design": [
		{
			id: "v086-express-repay-affiliate-debt-only",
			form: "underline",
			sourceQuote:
				"generalBadDebt is a cumulative diagnostic counter: the current contract increments it for the unreplenished general-pool portion and exposes no function that decrements or resets it. repayCreditBadDebt applies only to an affiliate’s credit-line badDebt and credits that affiliate pool.",
			targetQuote: "only to an affiliate’s credit-line badDebt",
			sectionId: "post-payout-rollback",
			placement: "mark",
		},
	],
	"v0.8.6/force-close-request-binding": [],
	"v0.8.6/gasless-layer": [
		{
			id: "v086-gasless-core-fee-source",
			form: "highlight",
			sourceQuote:
				"source = 0: the fee is charged to payer’s balance in SYMMIO Core. This is not the ERC20 balance in the user’s browser wallet. The account also needs sufficient operational-fee allowance for GaslessLayer.",
			targetQuote: "source = 0: the fee is charged to payer’s balance in SYMMIO Core.",
			sectionId: "quote-payment-source",
			placement: "mark",
		},
		{
			id: "v086-gasless-wallet-fee-source",
			form: "highlight",
			sourceQuote:
				"source = 1: the fee is taken from collateral tokens held by the GaslessWallet at payer. The user needs those tokens at that wallet address.",
			targetQuote: "source = 1: the fee is taken from collateral tokens held by the GaslessWallet at payer.",
			sectionId: "quote-payment-source",
			placement: "mark",
		},
		{
			id: "v086-gasless-usdc-quotes-use-eighteen-decimals",
			form: "underline",
			sourceQuote:
				"Display every quote amount with formatUnits(amount, 18), including USDC fees. For example, 5000000000000000000n means 5 USDC when USDC is collateral. collateralDecimals describes the token’s raw transfer units; it does not change the quote’s 18-decimal units.",
			targetQuote: "including USDC fees",
			sectionId: "quote-payment-source",
			placement: "mark",
		},
	],
	"v0.8.6/index": [],
	"v0.8.6/instant-layer-authorization-scope": [],
	"v0.8.6/instant-layer-batch-delegation-grant": [],
	"v0.8.6/instant-layer-upgradeability": [
		{
			id: "v086-instant-diamond-initial-redeployment",
			form: "underline",
			sourceQuote:
				"InstantLayer is now an upgradeable EIP-2535 diamond so future code updates can keep the same address and existing delegations. Previously, every code update required deploying a new instance, leaving users’ delegations on the old contract and requiring them to grant permissions again. That would interrupt our take-profit and stop-loss (TP/SL) services, which rely on InstantLayer delegations, and leave users’ session keys without permissions on the replacement. Moving to the diamond still requires a one-time redeployment, so we added a MigrationFacet with migrateDelegations to let an authorized migrator copy selected active delegations from the old layer, preserving their expiry and any pending revocation ETA.",
			targetQuote: "still requires a one-time redeployment",
			sectionId: "full-document",
			placement: "mark",
		},
	],
	"v0.8.6/instant-open-gas-optimization": [
		{
			id: "v086-instant-live-reader-preset-comparison",
			form: "note",
			sourceQuote:
				"Bit 0 decides which source answers the question. When it is set, the transient word is authoritative, so a clear bit 2 means InstantOpen mode is explicitly off. When bit 0 is clear, the reader ignores the transient flags and falls back to the persistent compatibility fields. isInstantOpenMode() follows the same structure.",
			targetQuote: "",
			sectionId: "fallback",
			note: "Compare No scope with Routing only and watch the isInstantOpenMode() readout.",
			placement: "before",
			beforeSelector: '[data-word-reader-tool="live"]',
		},
	],
	"v0.8.6/lazy-accumulated-funding": [
		{
			id: "v086-lazy-funding-integer-parity",
			form: "underline",
			sourceQuote:
				"Quote flows no longer pay for symbol-state storage writes or the state log. The cumulative funding formula is unchanged, but exact integer results can differ from v0.8.5 because the lazy path avoids the weighted-average division that each roll introduced.",
			targetQuote: "but exact integer results can differ from v0.8.5",
			sectionId: "what-changed",
			placement: "mark",
		},
	],
	"v0.8.6/liquidation-dispute-resolution-guards": [],
	"v0.8.6/liquidation-funding-observability": [
		{
			id: "v086-liquidation-pnl-residual-not-scaled",
			form: "underline",
			sourceQuote:
				"Normally the final amount matches the expected amount and the scale is 1 / 1. A haircut, dispute override, or isolated-mode payout cap can reduce the final amount. When it reduces the amount without changing its direction, the scale is abs(final amount) / abs(expected amount); a zero or direction-changing override reduces funding to zero. The contract applies that scale to rawFunding, then assigns the rest of the funding/PnL settlement component to settledPnl. Thus settledFunding + settledPnl = -settleAmounts[i], excluding the separately returned CVA. The full allocation delta from this bucket settlement is cvaAmounts[i] + settledFunding + settledPnl. settledPnl is not independently scaled. Use the typed balance-change events as the storage ledger.",
			targetQuote: "is not independently scaled",
			sectionId: "aggregate-settlement-event",
			placement: "mark",
		},
	],
	"v0.8.6/liquidation-funding-snapshot-fix": [],
	"v0.8.6/liquidation-settlement-plan": [],
	"v0.8.6/market-open-fee-execution-price": [],
	"v0.8.6/muon-upnl-validity-overrides": [],
	"v0.8.6/narrower-admin-roles": [],
	"v0.8.6/notional-liquidation-fee-floor": [],
	"v0.8.6/operational-fees": [
		{
			id: "v086-operational-allowance-not-increment",
			form: "underline",
			sourceQuote:
				"Both approval methods are batch setters: each amounts[i] replaces the payer’s remaining allowance for chargers[i]; it is not an increment. Charges decrement this value. An increase applies immediately, while a reduction follows the delay explained under Timelocked reductions.",
			targetQuote: "it is not an increment",
			sectionId: "setup-api",
			placement: "mark",
		},
	],
	"v0.8.6/overview": [],
	"v0.8.6/partial-fill-fee-reservation": [],
	"v0.8.6/partya-liquidation-fee-recipient": [],
	"v0.8.6/partyb-allocation-suspension-gates": [],
	"v0.8.6/partyb-funding-nonces": [],
	"v0.8.6/pledge-token-whitelist": [],
	"v0.8.6/position-isolation-partial-fill": [],
	"v0.8.6/session-keys": [
		{
			id: "v086-session-wallet-selector-scope",
			form: "highlight",
			sourceQuote:
				"To sign operations for the owner’s GaslessWallets, the key needs WALLET_EXECUTION_SENTINEL_SELECTOR plus the selector of every call inside the wallet operation. It cannot send native currency from a wallet. Wallet permissions are checked by selector, not by target contract or wallet ID, so a granted selector works through every wallet the owner has. With the sentinel and a general token selector such as ERC-20 transfer or approve, the key could move any wallet’s tokens. See GaslessWallet operations.",
			targetQuote:
				"Wallet permissions are checked by selector, not by target contract or wallet ID, so a granted selector works through every wallet the owner has.",
			sectionId: "limits-wallets",
			placement: "mark",
		},
	],
	"v0.8.6/settlement-pause-and-deallocation-guards": [],
	"v0.8.6/single-step-partya-liquidation": [],
	"v0.8.6/solver-fees": [
		{
			id: "v086-solver-preview-full-quantity-fee-basis",
			form: "highlight",
			sourceQuote:
				"Bots can also preview the uncapped close-to-liquidation sizing before submitting the transaction. Because this existing view does not take maxFillAmount, maxSolverFee is the planned fee-list total quoted for the quote’s full pending quantityToClose, or 0 for a fee-less close. The preview uses that per-quantity rate for every candidate. At execution, quote the same rate against the chosen maxFillAmount and apply that cap to the preview result:",
			targetQuote:
				"Because this existing view does not take maxFillAmount, maxSolverFee is the planned fee-list total quoted for the quote’s full pending quantityToClose, or 0 for a fee-less close.",
			sectionId: "api-surface",
			placement: "mark",
		},
	],
	"v0.8.6/strict-deallocation": [
		{
			id: "v086-safe-removal-no-second-upnl-debit",
			form: "underline",
			sourceQuote:
				"fundingDebt is a uint256 gross liability inside the Muon-signed payload: it is the accrued funding amount owed by the party whose account is being safe-deallocated. Funding receivables are excluded. Net uPnL continues to include funding exactly as before; the debt is not subtracted from uPnL a second time. It is separately retained in raw collateral so favorable price PnL cannot mask it.",
			targetQuote: "not subtracted from uPnL a second time",
			sectionId: "scaled-floor",
			placement: "mark",
		},
	],
	"v0.8.6/symbol-adjustment": [
		{
			id: "v086-symbol-hash-upgrade-includes-untouched-symbols",
			form: "underline",
			sourceQuote:
				"Opening a window increments its epoch and sets restating = true. The flag stays true throughout abort/finalization restoration and changes to false only at completion. A later window increments the epoch again. These transitions invalidate the previous price signatures permanently, regardless of their timestamps. Changes to unrelated symbols do not invalidate a payload. Release the Muon/gateway hash update together with these contract changes: signatures over the previous hash are no longer accepted, including for symbols that have never been restated. There is no fallback to the previous hash.",
			targetQuote: "including for symbols that have never been restated",
			sectionId: "liquidation-price-signature-domain",
			placement: "mark",
		},
	],
	"v0.8.6/zero-quantity-quote-rejection": [],
};
