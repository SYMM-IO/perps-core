# Deployment recipes

`deployment.symm.io/v1` is the portable, reviewed public intent used by the SYMMIO Operator.
Launch the guided application with `./symmio`, then choose a deployment or patch action. The
operator starts from the reviewed profile, collects typed values, validates immediately,
writes the recipe atomically under `deployments/`, and shows the complete intent before any
execution.

Recipes explicitly bind network and chain, infrastructure secret references, execution policy, governance,
collateral, Muon configuration and permissions, protocol parameters, ordered InstantLayer
templates, and `deploy`/`reuse`/`skip` intent for Core, PartyB, SymbolManager, and
ExpressProvider.

Secrets are references only. The transaction signer is selected and hash-bound by the task
runner rather than embedded in the recipe. Hardhat keystore is the default; `env://`
references are restricted to local/fork workflows. Inline private keys, RPC URLs,
passwords, and explorer keys are invalid.

A reused Core is pinned through `core.fromReport`. The exact report bytes contribute to the
recipe digest and are rechecked on resume. An ExpressProvider `reuse` recipe with declared
sections is a patch: declared roles are authoritative and include revocations against the
last applied report, omitted sections are untouched, unauthorized mutations become Safe
actions, and removed affiliates are warning-only. `maxDebt: "0"` and `maxDebtBps: 0` mean no
limit on those axes.

The schema is [deployment-recipe.schema.json](./deployment-recipe.schema.json), and the
reviewed starter is [examples/arbitrum.v1.example.json](./examples/arbitrum.v1.example.json).
The starter intentionally contains invalid placeholders so it cannot execute without guided
review.

Low-level deployment tasks are internal adapters owned by the task registry. Operators use
only the menu application; see [the operator reference](../cli/README.md).
