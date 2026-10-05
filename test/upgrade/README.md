# Upgrade tests

Upgrade workflow tests live here, separately from contract behavior tests in `test/parallel` and `test/sequential` and general CLI tests in `cli/test`.

Each stage has its own test files. Shared fixtures live in `helpers`; loading a fixture does not register tests. Cross-stage runner tests live in `workflow` because they verify handoffs and continuation across the complete sequence.

| Folder         | Checks                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| `input`        | Standard input, credential references, source and baseline binding           |
| `preflight`    | Scan completeness, storage compatibility, authority and execution boundaries |
| `deployment`   | Linked manifests, contract deployment, checkpoint reconciliation             |
| `rehearsal`    | Fork requirements and rehearsal evidence                                     |
| `governance`   | Cut planning, role grants, ordered execution and partial progress            |
| `verification` | Exact receipts, preserved state and service evidence                         |
| `unpause`      | Verified cut and restoration of the intended pause flags                     |
| `recovery`     | Interrupted broadcasts, source migration and safe continuation               |
| `workflow`     | Full task ordering and handoffs between stages                               |

Reusable tests are tracked. `chain-bound/` mirrors the stage folders for local tests tied to Arbitrum/Base profiles, operator recipes, or historical chain release policy. The entire `chain-bound/` directory is ignored in Git; these files remain on this workstation and are absent from fresh clones. Contract-level UUPS and accounting behavior tests remain in the contract suites.

Use Node 22.15.0 and select the stage and component you need:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 22.15.0
npm run test:upgrade -- preflight --match Core --list
npm run test:upgrade -- preflight --match Core
npm run test:upgrade -- verification --match Core
npm run test:upgrade -- recovery --match Core
npm run test:upgrade -- input --chain-bound --match core
npm run test:upgrade -- workflow --chain-bound --match core
```

The runner requires one explicit stage, excludes contract tests and never compiles. Refresh artifacts once at the end of a source implementation stage with `npm run compile` when required. `--chain-bound` selects only the local deployment checks; without it, the runner selects only reusable tests. `--match` filters filenames and `--list` previews the exact selection. No matching files is an error, including when ignored local tests are unavailable on a fresh clone.

Account/Instant historical compatibility compilation is shared by its fixtures once per process. Run its targeted stage after preparing current artifacts. An independent stage starts its own process and must establish its own baseline proof.

`npm test` and `npm run test:cli` do not discover this directory. Run the relevant upgrade stage explicitly before releasing changes to upgrade tooling. Local mocks and mined transactions do not replace deployment-specific block-pinned fork rehearsals.
