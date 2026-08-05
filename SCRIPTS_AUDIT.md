# SYMMIO perps-core — Script & Deploy-Path Audit

**Scope:** all of `scripts/`, `tasks/`, `utils/`, `hardhat.config.ts`, `.env.example` (~32k lines)
**Target:** greenfield v0.8.6 mainnet deployment on **Arbitrum One (42161)**, EOA/hardware signing, multi-chain support retained
**Date:** 2026-08-05 · branch `version_0.8.6`

> **Confidence marking.** Items marked **[VERIFIED]** were re-read against the source and independently confirmed.
> Items marked **[UNVERIFIED]** come from the survey pass; the adversarial verification stage did not run (see
> *Audit completeness* at the end). Treat UNVERIFIED items as strong leads, not settled fact.

---

## 0. Fixes applied (2026-08-05)

| # | Blocker | Status | Change |
|---|---|---|---|
| C1 | Unsafe `.env.example` defaults | ✅ **Fixed** | New [tasks/deploy/safety.ts](tasks/deploy/safety.ts) hard-fails `deploy:system` on 17 known mainnet chainIds when mock verifier / empty collateral / dummy affiliate / public deployer key is active. `--allow-unsafe-mainnet` is the deliberate override. `.env.example` rewritten with safe defaults. |
| C2 | `PRIVATE_KEY` never read → dummy-key fallback | ✅ **Fixed** | Guard blocks the two publicly-known deployer addresses by identity. `.env.example` now documents `NEW_DEPLOYER` (the var actually read) and drops the dead `PRIVATE_KEY` / `PRIVATE_KEYS_STR` / 11 per-chain API-key vars; adds the real `ETHERSCAN_APIKEY`. |
| C3 | Diamond resume ships incomplete Diamond | ✅ **Fixed** | [diamond.ts](tasks/deploy/diamond.ts) now compares installed vs expected **selector sets**, re-cuts only missing facets, skips `init()` when it already ran, and asserts every selector is present before recording success. |
| C4 | 36 transactions never awaited to receipt | ✅ **Fixed** | New [tasks/deploy/tx.ts](tasks/deploy/tx.ts) `send()` awaits the receipt, throws on revert/drop, and logs hash + gas. All 68 call sites routed through it. |
| C5 | `--verify` inert | ✅ **Fixed** | Now invokes `verify:all`. Both `verify:all` and `check:deployment` throw (exit non-zero) on failure instead of always exiting 0. |
| C6 | `setSymbolTypesToOne.ts` targets live Arbitrum | ✅ **Deleted** | Plus 10 more verified-orphan/broken scripts (§4). |
| — | **No TypeScript type checking at all** | ✅ **Fixed** | `tsconfig.json` paired `"module": "commonjs"` with `"moduleResolution": "node16"` — an invalid combination that made `tsc` abort before checking a single file, in an ESM repo. Set to `node16`. This had been masking ~680 real errors, including the `.address`-on-ethers-v6 bugs below. |
| — | `Initialize.ts` rotted (local dev) | ✅ **Fixed** | `.address` → `getAddress()`; `addSymbol` moved to `SymbolControlFacet`; `createRunContext`'s boolean 3rd arg was being passed an address. |
| C7 | Deployer retains `DEFAULT_ADMIN_ROLE` | ✅ **Fixed** | Confirmed: `ControlFacet.setAdmin` only sets `hasRole[user][DEFAULT_ADMIN_ROLE] = true`, and `isRoleAdmin` treats any holder as admin of every role. New step 11 `revokeDeployerPrivileges` hands control to `ADMIN_PUBLIC_KEY` and revokes the deployer's roles on the Diamond (`DEFAULT_ADMIN_ROLE`, `MUON_SETTER_ROLE`), the AccountLayer, the verifier, InstantLayer and PartyB — each preceded by an on-chain check that the admin already holds the role, and followed by an assertion that the deployer no longer does. |
| C8-1 | `--fresh` / corrupt checkpoint destroys deployment record | ✅ **Fixed** | `--fresh` archives the existing checkpoint via `clearCheckpoint`; an unreadable checkpoint is copied to `.corrupt-<ts>` before being discarded. |
| C8-3 | CREATE2 mining loops forever on any error | ✅ **Fixed** | Retries only when the predicted address actually has code; every other error rethrows. Bounded at 20 collisions. Pre-checks `getCode` before spending a transaction. |
| C8-6 | `SYMMIO_FEE_RECEIVER` silently ignored | ✅ **Fixed** | AccountLayer is initialised with the deployer as fee receiver (it must hold admin during setup); a new step sets the configured receiver via `setSymmioFeeReceiver`, taking `SETTER_ROLE` temporarily and giving it back, then asserts the new value. |
| C8-7 | SymbolManager operator grants revert when admin ≠ deployer | ✅ **Fixed** | The constructor grants `DEFAULT_ADMIN_ROLE` to `admin` only, so the deployer could never grant operator roles — this would have failed **every** production deploy. Now detected up front, with the exact command for the admin to run, instead of a raw revert at the last step. |
| C8-9 | `verify:all` reports green having verified nothing | ✅ **Fixed** | Throws when zero contracts are loaded, and explains that `tasks/data` was gitignored. |
| C8-10 | `tasks/data` gitignored → deployment records local-only | ✅ **Fixed** | Deployment records are now tracked; only the in-progress checkpoint and `verify-failed.json` are ignored. |
| C8-12 | Crashed test worker reported as ALL TESTS PASSED | ✅ **Fixed** | Confirmed: pass/fail came from regexing stdout, and the captured exit `code` was never read. A non-zero exit with no parsed failures now counts as a failure. |
| C8-13 | `run_upgrade_test.sh` strips Muon signature checks | ✅ **Deleted** | Called `scripts/upgradeTest.ts`, which does not exist, and left signature checks disabled in contract source if interrupted. Verified committed source currently has them enabled. `utils/update_sig_checks.py` is now orphaned — your call whether to keep it. |
| C8-11 | Fixed `TX_GAS_LIMIT` wrong for Arbitrum | ❌ **Refuted** | `explicitGasEnabled()` returns false unless `EXPLICIT_GAS_LIMITS` is set or the network is `coti`, so **no** `gasLimit` override is applied on Arbitrum — ethers estimates normally. Not a blocker. |
| — | Missing-flag crashes across component tasks | ✅ **Fixed** | `requireArg` in [helpers.ts](tasks/deploy/helpers.ts) names the missing flag instead of failing with "Cannot read properties of undefined (reading 'toLowerCase')". Applied across feeDistributor, instantLayer, liquidator, multiaccount, partyB, upgrade, symbolManager. |
| **NEW** | **Deployment records were not chainId-scoped** | ✅ **Fixed** | Found while checking the `.gitignore` change, and a genuine Arbitrum blocker. [tasks/utils/fs.ts](tasks/utils/fs.ts) wrote every record to one unscoped path per contract type (`tasks/data/instantlayer.json`, …) and the deploy tasks **append**. A localhost run followed by an Arbitrum run put both addresses in one file, so `verify:all --network arbitrum` would submit a localhost address to Arbiscan — and with the new fail-on-error behaviour, break the run. Checkpoints were already chainId-scoped; records now are too, via `setDataScope(chainId)`, with a read-fallback to the legacy path. Two stale localhost records were sitting in the tree, confirming this happens in practice. |
| — | `tasks/utils/gas.ts` | ✅ **Deleted** | Orphaned, imports `@ethersproject/units` which is not installed, and uses the ethers v5 API in an ethers v6 repo. |

**The entire `tasks/deploy/` tree and `scripts/Initialize.ts` are now type-clean.** Repo-wide `tsc` errors went
from 680 (unmeasurable before the tsconfig fix) to 546, with the remainder in `test/` and `scripts/upgrade/`.
The safety guard has 10 passing unit assertions covering block/allow/override on both mainnet and local chainIds.

**Still open:** the remaining C8 items that are not deploy-path blockers — `diamond.ts:483` (resume drops
`MuonSignatureVerifier` from `deployed.json`), `deployAll.ts:698` (two-step ownership needs the admin to call
`acceptOwnership`, which is inherent to the pattern but undocumented), and the 546 pre-existing type errors in
`test/` and `scripts/upgrade/`. Plus the audit phases that never ran (see *Audit completeness*).

---

## 1. Executive summary

- **Do not run `deploy:system` against Arbitrum mainnet in the current state.** Following the repo's own documented
  setup produces a compromised protocol — not through an exotic edge case, but through the happy path.
- **Copying `.env.example` to `.env` and deploying yields: a signature verifier that accepts every signature, a
  permissionlessly-mintable fake token as protocol collateral, and a deployer key that is published in git.** All three
  are defaults, all three are silent, and no chainId guard stops any of them. **[VERIFIED]**
- **`PRIVATE_KEY` is never read by anything.** `.env.example` and the setup runbook both tell you to set it;
  `hardhat.config.ts` reads `NEW_DEPLOYER` / `TEAM_DEPLOYER` / keystore and otherwise falls back to a hardcoded
  `DUMMY_PRIVATE_KEY`. An operator can believe they configured their deployer and sign with a public key. **[VERIFIED]**
- **The deploy is not receipt-safe.** `tasks/deploy/deployAll.ts` has **1** `.wait()` for **36** state-changing calls.
  Steps are checkpointed as complete on broadcast, not on mining. **[VERIFIED]**
- **Resume is unsound.** A mid-cut failure leaves the Diamond with 12 of 31 facets, and the resume probe then declares
  the cut complete, transfers ownership, prints a green report and clears the checkpoint. **[VERIFIED]**
- **`--verify` is a documented flag that does nothing** — the option is declared, destructured, and never used, so
  ~45 mainnet contracts ship unverified while the operator believes otherwise. **[VERIFIED]**
- **~12 root-level scripts in `scripts/` are broken, superseded, or actively dangerous**, including two that fire
  live privileged transactions at hardcoded mainnet addresses the moment they are invoked.
- **No v0.8.6 fresh-deployment runbook exists.** The only fresh-deploy document is `docs/v0.8.5/setup-task.md`, it is
  unreachable from the README, and its very first instruction is the one that causes the three defaults above.

**Bottom line:** the deploy tooling is architecturally reasonable — checkpointing, chunked cuts, component tasks — but
its **defaults are tuned for local testing while its entry point is aimed at mainnet.** That gap is the whole problem.

---

## 2. Blockers — must fix before an Arbitrum mainnet deploy

### C1. `.env.example` defaults produce a compromised mainnet protocol **[VERIFIED]**

Three separate defaults, one shared root cause. `docs/v0.8.5/setup-task.md:7` opens with *"Copy .env.example to .env"*.

| Var | Default | Effect on mainnet |
|---|---|---|
| `DEPLOY_MOCK_VERIFIER` | `"true"` ([.env.example:31](.env.example:31)) | [deployAll.ts:396](tasks/deploy/deployAll.ts:396) deploys `MockMuonSignatureVerifier`; [:855](tasks/deploy/deployAll.ts:855) wires it into the Diamond. **Every Muon price/uPnL/liquidation attestation becomes forgeable.** |
| `COLLATERAL_ADDRESS` | `""` ([.env.example:29](.env.example:29)) | [deployAll.ts:84](tasks/deploy/deployAll.ts:84) → else-branch deploys `FakeStablecoin` (permissionless `mint`), wired permanently via `setCollateral`. **Protocol denominated in a token anyone can mint.** |
| `PRIVATE_KEY` | Hardhat account #0 (`0xac0974be…`) ([.env.example:14](.env.example:14)) | Never read (see C2). |

None of these has a chainId guard, a confirmation prompt, or a dry-run. `setCollateral` is not cleanly re-runnable, so
a mistake here means discarding the entire deployment.

**Fix:** hard-fail in `getEnvConfig` when `chainId` is a known mainnet and (`deployMockVerifier` is true **or**
`collateralAddress` is empty). Flip both `.env.example` defaults to the safe value and move the permissive ones to a
separate `.env.local.example`.

### C2. `PRIVATE_KEY` is documented but never read; deploy silently falls back to a published key **[VERIFIED]**

```
$ grep -rn "PRIVATE_KEY" hardhat.config.ts tasks/ scripts/ | grep -v PRIVATE_KEYS_STR
hardhat.config.ts:13:  const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"
hardhat.config.ts:21:  process.env.NEW_DEPLOYER || process.env.TEAM_DEPLOYER || (useKeystore ? configVariable(…) : DUMMY_PRIVATE_KEY)
```

The deployer resolves from `NEW_DEPLOYER` → `TEAM_DEPLOYER` → keystore → **hardcoded key committed to this repo**.
`.env.example:14` and `docs/v0.8.5/setup-task.md:16` both instruct setting `PRIVATE_KEY`. `scripts/upgrade/docs/production-upgrade.md:512`
already documents this trap — evidence the team hit it before.

**Fix:** throw at config load if a non-simulated network resolves to `DUMMY_PRIVATE_KEY`. Delete `PRIVATE_KEY` from
`.env.example` or make it the canonical name. Duplicate constant also at [setSeiSymbolTradingFees.ts:29](scripts/setSeiSymbolTradingFees.ts:29).

### C3. Diamond-cut resume silently ships an incomplete Diamond **[VERIFIED]**

[tasks/deploy/diamond.ts:419-439](tasks/deploy/diamond.ts:419) probes `loupe.facets()` and sets
`diamondCutAlreadyDone = true` whenever `facets.length > 1`. The cut runs in chunks of 6 over 31 facets
([:448](tasks/deploy/diamond.ts:448)), and `diamondCutComplete` is only persisted after the **whole** loop
([:466](tasks/deploy/diamond.ts:466)).

`DiamondLoupeFacet` is index 10 in `FacetNames`, so it lands in chunk 2. Concretely: an RPC timeout after chunk 2
leaves 12 of 31 facets installed; the resume probe sees 12 > 1, declares the cut complete, `setupSystem` proceeds
(ControlFacet is in chunk 2, so role grants succeed), ownership transfers, the green report prints, and the
checkpoint is cleared. **19 facets are missing from a Diamond that reports success.**

**Fix:** compare the full installed selector set against the expected set from `FacetNames`, not `length > 1`.

### C4. 36 state-changing transactions, 1 `.wait()` **[VERIFIED]**

`tasks/deploy/deployAll.ts` — `grep -c "\.wait()"` returns **1**. Every privileged call is `await contract.method()`,
which in ethers v6 resolves on broadcast: `setAdmin` ([:767](tasks/deploy/deployAll.ts:767), [:771](tasks/deploy/deployAll.ts:771)),
`grantRole` ([:802](tasks/deploy/deployAll.ts:802), [:807-809](tasks/deploy/deployAll.ts:807)),
`registerHook` ([:814](tasks/deploy/deployAll.ts:814)), `setSignatureVerifierAddress` ([:856](tasks/deploy/deployAll.ts:856)),
`setMuonConfig` ([:941](tasks/deploy/deployAll.ts:941)), `transferOwnership` ([:696](tasks/deploy/deployAll.ts:696)),
`setTargetWhitelist` ([:1067](tasks/deploy/deployAll.ts:1067)), `registerPartyB` ([:1077](tasks/deploy/deployAll.ts:1077)).

Each sits inside `checkpointedStep`, so **the checkpoint marks a step done when the tx is broadcast, not mined** — and
a resume then skips it. A dropped or reorged tx becomes a permanently-skipped setup step with no error anywhere.

**Fix:** a `send()` helper that does `const tx = await …; const rc = await tx.wait(N); if (!rc.status) throw`, logging
the hash and gas. Route all 36 through it. This is the single highest-value change in the report.

### C5. `deploy:system --verify` does nothing **[VERIFIED]**

Three occurrences of `verify` in the file: declared [:149](tasks/deploy/deployAll.ts:149), destructured
[:203](tasks/deploy/deployAll.ts:203), and an unrelated `setup.verifyMuonViews` [:946](tasks/deploy/deployAll.ts:946).
The flag is never acted on. Operator passes `--verify`, sees success, ships ~45 unverified contracts.

**Fix:** wire it to `verify:all`, or delete the option. Do not leave it inert.

### C6. `scripts/setSymbolTypesToOne.ts` fires at the live Arbitrum diamond **[VERIFIED]**

[Line 3](scripts/setSymbolTypesToOne.ts:3): `DIAMOND_ADDRESS = "0x8F06459f184553e5d04F07F868720BDaCAB39395"` — documented
in [copySymbols.ts:52](scripts/copySymbols.ts:52) as *"Arbitrum v0.8.4"*, i.e. **live production**. The file is
top-level `await` with no `main()` guard, no chainId check, and no dry-run: running it mass-rewrites `symbolType` on
every symbol. `symbolType` gates protocol behaviour. It sits alphabetically adjacent to `setSymbolTypes.ts` — one
stray tab-completion during the Arbitrum deploy session is enough.

**Fix:** delete (see §4). Same hazard class: [callAMethod.ts:18](scripts/callAMethod.ts:18) (live `grantRole` on run)
and [grantAdmin.ts:3](scripts/grantAdmin.ts:3) (`DEFAULT_ADMIN_ROLE` on four hardcoded contracts, exits 0 on failure).

### C7. Deployer retains `DEFAULT_ADMIN_ROLE` after deploy **[UNVERIFIED]**

[deployAll.ts:766](tasks/deploy/deployAll.ts:766) grants the deployer `DEFAULT_ADMIN_ROLE`, then [:771](tasks/deploy/deployAll.ts:771)
grants the admin. `ControlFacet.setAdmin` is reported to be purely additive — it revokes nothing. If so, the deploy hot
wallet retains full protocol admin permanently.

**Verify this first, then fix** by revoking the deployer grant as a final step and asserting the revocation on-chain.

### C8. Other blockers carried from the survey **[UNVERIFIED]**

| Finding | Location |
|---|---|
| `--fresh` / checkpoint load failure overwrites the record of already-deployed mainnet contracts | [checkpoint.ts:205](tasks/deploy/checkpoint.ts:205) |
| Resume wipes `MuonSignatureVerifier` from `deployed.json`, so `verify:all` can never verify it | [diamond.ts:483](tasks/deploy/diamond.ts:483) |
| CREATE2 mining treats every error as "salt used" → infinite loop or orphaned Diamond | [diamond.ts:135](tasks/deploy/diamond.ts:135) |
| Success reported while Diamond ownership transfer still pending | [deployAll.ts:698](tasks/deploy/deployAll.ts:698) |
| `REGISTER_DUMMY_AFFILIATE` defaults on → a real "Test Affiliate" registered on mainnet | [deployAll.ts:90](tasks/deploy/deployAll.ts:90) |
| AccountLayer permanently owned by deployer EOA; `SYMMIO_FEE_RECEIVER` ignored | [deployAll.ts:463](tasks/deploy/deployAll.ts:463) |
| SymbolManager role grants revert when `ADMIN_PUBLIC_KEY` ≠ deployer | [deployAll.ts:1140](tasks/deploy/deployAll.ts:1140) |
| `verify:all` and `check:deployment` always exit 0, even when everything fails | [verify.ts:211](tasks/deploy/verify.ts:211), [:1422](tasks/deploy/verify.ts:1422) |
| Missing deployment-log files downgraded to "skipping" → all-green summary having verified nothing | [verify.ts:110](tasks/deploy/verify.ts:110) |
| `tasks/data` is gitignored, so mainnet checkpoints and address records are local-only | [.gitignore:31](.gitignore:31) |
| Fixed `TX_GAS_LIMIT` ignores Arbitrum's L1 calldata posting component | [txOverrides.ts:63](scripts/upgrade/utils/txOverrides.ts:63) |
| `parallel-test-runner.js` ignores worker exit codes — a crashed worker reports ALL TESTS PASSED | [parallel-test-runner.js:432](utils/parallel-test-runner.js:432) |
| `run_upgrade_test.sh` strips Muon signature checks from source, then calls a nonexistent script | [run_upgrade_test.sh:2](utils/run_upgrade_test.sh:2) |

---

## 3. The deploy path as it exists today

```
npx hardhat deploy:system --network arbitrum
```

| # | Step | Gap |
|---|---|---|
| 0 | Read env via `getEnvConfig` ([:76](tasks/deploy/deployAll.ts:76)) | **No validation.** No chainId guard. Unsafe defaults (C1). |
| 1 | Collateral — existing or `FakeStablecoin` ([:309](tasks/deploy/deployAll.ts:309)) | Silent fake-token branch (C1). |
| 2 | Signature verifier — real or Mock ([:387](tasks/deploy/deployAll.ts:387)) | Mock is the shipped default (C1). |
| 3 | Diamond + 31 facets, chunks of 6 ([diamond.ts:448](tasks/deploy/diamond.ts:448)) | Unsound resume (C3). |
| 4 | AccountLayer diamond ([:463](tasks/deploy/deployAll.ts:463)) | Stays owned by deployer EOA. |
| 5 | InstantLayer, PartyB, SymbolManager, Multicall | Template setup non-idempotent — a retry duplicates every template. |
| 6 | `setupSystem` — 36 privileged txs ([:750-1140](tasks/deploy/deployAll.ts:750)) | **None awaited to receipt** (C4). |
| 7 | Ownership transfer ([:696](tasks/deploy/deployAll.ts:696)) | Not awaited; success printed while pending. |
| 8 | Report + clear checkpoint | Prints green regardless of 1–7. |
| 9 | `--verify` | **Inert** (C5). Must run `verify:all` separately. |

**Missing entirely:** preflight (balance / chainId / nonce — `scripts/upgrade/utils/preflight.ts` and `rpcCheck.ts`
exist but are used only by the upgrade path), post-deploy assertion that all 31 selectors are installed, role-hygiene
assertion, and any dry-run or confirmation gate.

---

## 4. Cleanup plan

Policy agreed: **delete outright**, keep multi-chain support, git history is the archive.

### DELETE — broken, unrunnable, or dangerous (12)

| File | Reason |
|---|---|
| ~~`scripts/setSymbolTypesToOne.ts`~~ | ✅ **DELETED 2026-08-05** — one-time script; fired at live Arbitrum diamond, no guards (C6) **[VERIFIED]** |
| `scripts/callAMethod.ts` | Live `grantRole` at hardcoded diamond on invocation |
| `scripts/grantAdmin.ts` | `DEFAULT_ADMIN_ROLE` on 4 hardcoded contracts, no network check, exits 0 on failure |
| `scripts/deploy.ts` | Documents a FACET/ACTION/SELECTORS interface it does not implement; deploys `Multicall3` **[VERIFIED]** |
| `scripts/Initialize.ts` | Unrunnable — `.address` on ethers Contracts; `addSymbol` no longer on ControlFacet |
| `scripts/deploySignatureVerifier.ts` | Deploys a debug helper, not `MuonSignatureVerifier` |
| `scripts/deployFeeDistributor.ts` | Hardcoded empty `symmioShare` / `symmioShareReceiver` — cannot run |
| `scripts/deployTimelock.ts` | Empty `multiSig` used as proposer/executor/canceller — cannot run |
| `scripts/deployMultiAccount.ts` | Writes `undefined` as address; superseded by `deploy:multiAccount` |
| `scripts/deployPartyB.ts` | Same `undefined` bug; superseded by `deploy:symmioPartyB` |
| `scripts/deployAndSetupAccountLayer.ts` | Breaks on its own documented `SYMMIO_FEE_RECEIVER`; superseded by `deploy:accountLayer` |
| `scripts/configureVerifierKey.ts` | Reports success while doing nothing; swallows failures |

✅ **All 11 deleted on 2026-08-05** (staged, not yet committed). `scripts/` root went from 24 `.ts` files to 15.

`Initialize.ts` was the one exception — it appeared on the delete list but turned out to be **referenced** by
[utils/deploy-local.sh](utils/deploy-local.sh) and [utils/runTestsWithLocalNode.sh](utils/runTestsWithLocalNode.sh),
and it seeds test symbols that `deploy:system` does not. It was repaired instead of deleted.

Each deletion was confirmed orphaned by grep (no inbound imports, no shell/npm/doc references) before removal.

### RESOLVE — orphan

- `tasks/deploy/expressWithdrawLayerDiamond.ts` — on disk but **not imported** by [tasks/deploy/index.ts](tasks/deploy/index.ts),
  so no task can invoke it. **[VERIFIED]** Either register it or delete it; do not leave it ambiguous.

### KEEP

Everything under `scripts/upgrade/` (serves live-chain v0.8.6 upgrades), all per-chain JSON configs, all chain-specific
scripts for live chains (`fundHyperEVM.ts`, `setSeiSymbolTradingFees.ts` — but strip its duplicated `DUMMY_PRIVATE_KEY`),
and the whole `tasks/deploy/` tree.

### MERGE — deferred, not a blocker

Ten `verify*` entry points exist (`tasks/deploy/verify.ts`, `scripts/verifyAll.ts`, and eight in `scripts/upgrade/`),
and 13 near-identical `generate*SafeBatch.ts` generators. Both clusters are consolidation candidates, but with EOA
signing on Arbitrum the Safe generators are off your critical path. **The redundancy-map analysis did not complete —
re-run before acting on this section.**

---

## 5. Logging & observability

- **No tx hashes are logged** for the 36 setup transactions, and no receipts are awaited (C4) — a failed mainnet
  step leaves nothing to investigate with.
- **Exit codes are meaningless** in the verification path: `verify:all` ([verify.ts:211](tasks/deploy/verify.ts:211))
  and `check:deployment` ([:1422](tasks/deploy/verify.ts:1422)) both exit 0 on total failure. CI cannot gate on them.
- **Absent output masquerades as success**: missing deployment logs are downgraded to "skipping" and summarised green
  ([verify.ts:110](tasks/deploy/verify.ts:110)).
- **Three competing logging systems**: `tasks/deploy/logger.ts` (`DEPLOY_LOG_LEVEL`), `scripts/upgrade/utils/log.ts`,
  `scripts/upgrade/utils/stepReporter.ts`, plus raw `console.log`. Pick one for the deploy path.
- **No gas accounting** and **no durable per-network deploy record** — `tasks/data` is gitignored ([.gitignore:31](.gitignore:31)).

> The dedicated logging-audit pass did not complete; this section is the subset visible from the other agents.

---

## 6. Documentation drift

| Claim | Reality |
|---|---|
| `docs/v0.8.5/setup-task.md:16` — set `PRIVATE_KEY` | Never read (C2) **[VERIFIED]** |
| `.env.example:8` — per-chain explorer keys (`ARBITRUM_API_KEY`…) | Nothing reads them; `hardhat.config.ts` reads `ETHERSCAN_APIKEY`, which `.env.example` omits |
| `README.md:84` — `npx hardhat test mocha` runs all tests | Runs `test/sequential/Main.ts`; omits 16 of 51 suites |
| `README.md` — 29 core facets | `constants.ts` lists 31 `FacetNames` |
| `production-upgrade.md:964` — 13 `npx ts-node` commands | Fail immediately in this ESM repo |
| Fresh-deploy runbook | Only `docs/v0.8.5/setup-task.md`; version-stale and unreachable from README |

Also: `arbitrum` is **absent from the `customChains` array** in `hardhat.config.ts` while 14 other chains are listed.
The `arbitrum` network ([:325](hardhat.config.ts:325)) and `fork-arbitrum` ([:338](hardhat.config.ts:338)) both exist.
**[VERIFIED]** — confirm Arbiscan verification resolves via hardhat-verify's built-ins before relying on it.

---

## 7. Recommended order of work

| # | Item | Why first | Effort |
|---|---|---|---|
| 1 | Mainnet guard in `getEnvConfig`: reject mock verifier, empty collateral, dummy key, dummy affiliate on known mainnet chainIds | Removes C1+C2 — the highest-severity items — in one place | S |
| 2 | `send()` helper awaiting receipts + logging hashes; route all 36 calls through it | Fixes C4; makes checkpoints trustworthy | M |
| 3 | Selector-set comparison in the diamond resume probe | Fixes C3 | S |
| 4 | Wire or delete `--verify`; make `verify:all` / `check:deployment` exit non-zero on failure | Fixes C5; makes CI gating possible | S |
| 5 | Delete the 12 files in §4; resolve the `expressWithdrawLayer` orphan | Removes C6-class footguns from the deploy session | S |
| 6 | Verify + fix C7 (deployer role retention); add a post-deploy role-hygiene assertion | Last privileged-access gap | M |
| 7 | Rewrite `.env.example`; add a v0.8.6 Arbitrum runbook linked from README | Closes the doc trap that causes C1 | M |
| 8 | **Full dress rehearsal on `fork-arbitrum`** end to end, including verification | Only way to prove 1–7 | M |
| 9 | Re-run the incomplete audit phases (below) | Coverage | — |
| 10 | Consolidate the verify\* and Safe-batch clusters | Pure tidiness; off critical path | L |

Step 8 is the real gate. `fork-arbitrum` ([hardhat.config.ts:338](hardhat.config.ts:338)) is already configured at
chainId 42161 — the rehearsal costs nothing but time and is the only thing that proves the path end to end.

---

## Audit completeness

Run `wf_c41ccead-47d` — 83 agents, 2.4M tokens, ~31 min. It hit an API session limit mid-run.

| Phase | Status |
|---|---|
| Survey (10 areas) | **8 of 10 completed** — `upgrade-verification` and `config-and-env` died mid-response |
| CrossCut (4) | **0 of 4** — redundancy map, logging audit, Arbitrum readiness, safety/keys all lost |
| Verify (68 adversarial refuters) | **0 of 68** — every critical/high finding is UNVERIFIED except the 7 confirmed by hand here |
| Synthesize | Failed; this report was written by hand from the recovered journal |

176 raw findings were recovered from the run journal (14 critical, 57 high, 67 medium, 38 low). The workflow's own
summary reported `highSeveritySurvived: 0` — that is an artifact of every verifier erroring out, **not** of findings
being refuted.

**Not yet covered:** the file-by-file redundancy/orphan map, a systematic logging audit, the dedicated Arbitrum-readiness
sweep (decimals handling for 6-decimal USDC, CREATE2 factory per-network config, Muon config application), the key-handling
sweep, and deep reads of `scripts/upgrade/verify*` and the full config/env diff.
