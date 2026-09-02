# Arbitrum Perps Core v0.8.6 upgrade

Start this workflow from `./symmio` under **Other maintenance scripts** and select **Arbitrum Perps Core v0.8.6 upgrade**. The internal adapters are deliberately not an operator entrypoint.

The workflow is fixed to Arbitrum chain 42161, Core `0x573310dB6d160B26026B8706EBe9831c7dEF1D09`, AccountLayer `0x5733107211B2801Acd39933a54d482FE303c4907`, and governance Safe `0x89bE952790657297ac03f1954b22B668d819D3d9`. It upgrades the existing Core and AccountLayer Diamonds, deploys fresh InstantLayer and GaslessLayer contracts, and reuses the other reviewed production components.

## Durable input and output

Preparation writes two machine-readable artifacts under `tasks/data/42161/upgrades/<input-digest>/`:

- `input.json` uses `operations.symm.io/arbitrum-perps-upgrade-input-v1`. It binds every target address, the source commit, reviewed recipe digest, governance authorities, InstantLayer templates, GaslessLayer configuration, and transaction policy.
- `report.json` uses `operations.symm.io/arbitrum-perps-upgrade-report-v1`. It records phase status, deployed addresses, selector changes, Safe actions and delivery artifacts, transaction outcomes, publication evidence, and final checks.

Both formats have JSON Schemas in `deployment-tooling/`. A resume refuses source or input drift. Contract creations also use the deployment checkpoint and write-ahead transaction journal, so a submitted or confirmed deployment is reconciled before another creation can be attempted.

## Independent phases

The task stops and resumes at stable boundaries:

1. Compile the exact checkout, inspect live ownership and roles, and run the full flow at the inspected block on an Arbitrum fork.
2. Have the prior AccountLayer administrator grant the Safe `DEFAULT_ADMIN_ROLE` and `SETTER_ROLE`.
3. Export or propose the Safe Core authority batch (`setAdmin` and `FEE_ADMIN_ROLE`) and verify the roles on-chain.
4. Deploy or recover Core facets, AccountLayer facets, the new InstantLayer, and the new GaslessLayer; then publish every new address to Arbiscan.
5. Export or propose independent Safe batches for the Core cut, AccountLayer cut, and new-layer wiring. Each continuation recomputes the remaining actions from chain state.
6. Record a successful production canary before exporting the cutover batch that revokes the old InstantLayer's Core and AccountLayer roles.
7. Add the production Safe owners and raise the threshold above 1. The task completes only after it reads the hardened Safe state and every other invariant from chain state.

Safe export or proposal is not treated as execution. The task enters `waiting_external`, names the exact artifact or proposal, and verifies the resulting contract state when continued. Cancellation never rolls back confirmed effects and remains pending while any transaction outcome is unresolved.

No new release tag is required by this flow. The standard input pins the exact source commit used to build and deploy, while the report keeps source parity, explorer publication, receipt evidence, wiring checks, and final custody/governance handover as separate proof layers.
