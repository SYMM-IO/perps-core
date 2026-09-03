# Arbitrum Perps Core v0.8.6 upgrade

Start this workflow from `./symmio` under **Other maintenance scripts** and select **Arbitrum Perps Core v0.8.6 upgrade**. The internal adapters are deliberately not an operator entrypoint.

The workflow is fixed to Arbitrum chain 42161, Core `0x573310dB6d160B26026B8706EBe9831c7dEF1D09`, AccountLayer `0x5733107211B2801Acd39933a54d482FE303c4907`, and governance Safe `0x89bE952790657297ac03f1954b22B668d819D3d9`. It upgrades the existing Core and AccountLayer Diamonds, deploys fresh InstantLayer and GaslessLayer contracts, and reuses the other reviewed production components. The Safe must already own both Diamonds and hold `DEFAULT_ADMIN_ROLE` on both; the workflow fails before rehearsal or deployment if that authority is absent.

## Durable input and output

Preparation writes two machine-readable artifacts under `tasks/data/42161/upgrades/<input-digest>/`:

- `input.json` uses `operations.symm.io/arbitrum-perps-upgrade-input-v2`. It binds every target address, the source commit, reviewed recipe digest, governance authorities, InstantLayer templates, GaslessLayer configuration, transaction policy, and whether the operator requires or explicitly waives the fork rehearsal.
- `report.json` uses `operations.symm.io/arbitrum-perps-upgrade-report-v1`. It records phase status, deployed addresses, selector changes, Safe actions and delivery artifacts, transaction outcomes, publication evidence, and final checks.

Both formats have JSON Schemas in `deployment-tooling/`. A resume refuses source or input drift. Contract creations also use the deployment checkpoint and write-ahead transaction journal, so a submitted or confirmed deployment is reconciled before another creation can be attempted.

Every fork invocation is an isolated attempt because a restarted Hardhat process has a new ephemeral chain. If a provider interrupts rehearsal, the task preserves that attempt's report, partial receipts, and checkpoint, then a resume starts the whole rehearsal against a fresh fork namespace. Live deployment phases keep the digest-stable checkpoint and reconcile on-chain state before continuing.

The preparation screen defaults to requiring the matching fork rehearsal. An operator may explicitly waive it by selecting the skip option and typing `SKIP FORK REHEARSAL`. The waiver is part of the input digest, the report records `stages.forkRehearsal.status` as `skipped`, and the task emits a durable warning before live authorization. A waived rehearsal is not reported as passed and does not provide fork execution evidence.

## Independent phases

The task stops and resumes at stable boundaries:

1. Compile the exact checkout and inspect live ownership and roles. Run the full flow at the inspected block on an Arbitrum fork unless the digest-bound input contains the operator's explicit rehearsal waiver.
2. Deploy or recover Core facets, AccountLayer facets, the new InstantLayer, and the new GaslessLayer; then publish every new address to Arbiscan.
3. Export or propose independent Safe batches for the Core and AccountLayer cuts, execute them through the Safe's existing Diamond ownership, and verify both selector surfaces.
4. Re-read the Safe's existing AccountLayer role-administration authority after both cuts. No prior-admin EOA or Ledger signer participates in the workflow.
5. Export or propose any remaining Safe Core authority action (currently `FEE_ADMIN_ROLE`), verify authority from chain state, then execute the new-layer wiring batch. Each continuation recomputes the remaining actions from chain state.
6. Record a successful production canary before exporting the cutover batch that revokes the old InstantLayer's Core and AccountLayer roles.
7. Add the production Safe owners and raise the threshold above 1. The task completes only after it reads the hardened Safe state and every other invariant from chain state.

Safe export or proposal is not treated as execution. The task enters `waiting_external`, names the exact artifact or proposal, and verifies the resulting contract state when continued. Cancellation never rolls back confirmed effects and remains pending while any transaction outcome is unresolved.

No new release tag is required by this flow. The standard input pins the exact source commit used to build and deploy, while the report keeps source parity, explorer publication, receipt evidence, wiring checks, and final custody/governance handover as separate proof layers.
