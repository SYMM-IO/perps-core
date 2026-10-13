# Perps Core UI

One local browser app for this checkout, with two parts:

- **Upgrade workbench** (Workspace, Upgrade, History): inspect a deployment, compare compiled source, and prepare and execute upgrades.
- **Fuzz testing**: the live and archived reports of the randomized protocol simulation.

React + TypeScript, Vite, Mantine components, React Router, React Query and Cytoscape. Uses the docs theme and the CLI's task lock, transaction lifecycle, and recovery journal.

```sh
npm run ui                    # build and serve the app
npm run test:fuzz:dashboard   # run the simulation and watch it under Fuzz testing
```

Open the complete link printed in the terminal. The service binds to `127.0.0.1:4318` (`PERPS_CORE_UI_PORT` overrides it). The link fragment authenticates this local session; every API route, including the fuzz reports, requires it. RPC URLs remain in memory; reconnect after restarting. The last saved snapshot is restored for inspection and marked as cached. Upgrade preparation still requires a live connection.

| Folder    | Contents                                                                       |
| --------- | ------------------------------------------------------------------------------ |
| `server/` | The HTTP service: upgrade engine and workspace, fuzz report routes (`fuzz.js`) |
| `ui/`     | The React app. `ui/src/fuzz/` holds the fuzz report view                       |
| `shared/` | Pure graph model used by both the server tests and the UI                      |
| `test/`   | Server tests (`node:test`). UI tests live in `ui/test/` (Vitest)               |

## Fuzz testing

`npm run test:fuzz:dashboard` runs the continuous simulation and writes a bounded report to ignored `.fuzz-dashboard/report.json`, archiving finished runs under `.fuzz-dashboard/runs/`. The app only reads those files (`FUZZ_DASHBOARD_FILE` and `FUZZ_DASHBOARD_ARCHIVE_DIR` move them), so the simulation never runs inside the service that prepares transactions.

- If the app is already running, the command reuses it: open **Fuzz testing** in the tab you have. An app started earlier keeps the report paths it was started with.
- Otherwise the command starts the app for the length of the run and prints the link. The first Ctrl+C stops the simulation and leaves the final report up; the second closes the app.
- **View** switches between the current run and archived ones. **Pause updates** freezes the page on the report it shows. **Export JSON** saves it. The address stored in a report never contains the session token.

The report view keeps its own markup and stylesheet (`ui/src/fuzz/dashboard.{html,css,js}`) and is mounted in a shadow root by `Fuzz.tsx`, so its styles and the app's cannot affect each other. It follows the app's fonts, background and light/dark theme through CSS custom properties.

## The address book

`addresses.json` at the repository root is the app's address list. `server/addresses.js` reads it at start, and `defaultProfiles` is exactly its content. To add or correct something, edit that file and restart the app. It is formatted by prettier like the rest of the repository, so the pre-commit hook leaves it as it is.

Each thing is written once. What several deployments share sits at the top, and a deployment refers to it:

| Section          | Holds                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `checked`        | The date the file was last checked against the chain.                                                                            |
| `chains`         | One entry per chain: its id, a public RPC and its explorer. A deployment names its chain instead of repeating these.             |
| `frontends`      | Each frontend's website, once.                                                                                                   |
| `olderCoreRoles` | Role names older cores had that this checkout no longer defines, and role hashes nobody has a name for.                          |
| `roleCandidates` | Wallets to check for roles. A group lists its wallets once, the deployments to check them on, and a `label` where they have one. |
| `deployments`    | One entry each: `id`, `name`, `chain`, `environment`, `version`, its `subgraphs`, its `contracts`, and any `notes`.              |

A deployment's `subgraphs` are its indexers by purpose; `events` is the one used to find role holders. `notes` are anything worth knowing about an entry that the fields above do not say.

A deployment's `contracts` are grouped by kind. A kind holds one address when there is nothing more to say, or a list of entries. A contract's name and id are worked out from where it is listed, so they cannot drift apart:

| In the file                                             | Becomes                                         |
| ------------------------------------------------------- | ----------------------------------------------- |
| `"core": "0x…"`                                         | "Symmio", id `core`                             |
| `"partyB": [{ "owner": "PerpsHub", "address": … }, …]`  | "PerpsHub · PartyB", then "PerpsHub · PartyB 2" |
| `"feeDistributor": [{ "owner": "Vibe", "address": … }]` | "Vibe · Fee Collector"                          |
| `"external": [{ "owner": "Vibe", "name": "Hook", … }]`  | "Vibe · Hook"                                   |
| `"safe": [{ "name": "Main Multisig", "address": … }]`   | "Main Multisig"                                 |

- The kind alone is enough for the contracts a deployment has one of: `core`, `token` (the collateral), `accountLayer`, `instantLayer`, `gasless`, `express`, `verifier`, `symbolManager`, `liquidator`. A second one of those needs a `name` to tell the two apart.
- `owner` is the solver or frontend a contract belongs to, spelled one way throughout ("IntentX", "Based"), with a variant in brackets ("Rasa (No Hedge)"). Under `partyB`, `multiAccount`, `affiliate` or `feeDistributor` the kind supplies the rest of the name, and several of the same are numbered in the order they are written.
- `name` is only for kinds that do not say what the contract is: `safe`, `timelock`, `authority`, `external`. `aliases` are other labels a contract goes by, which the map's search also matches.
- Ids are the names in lower case with dashes, except the standard kinds, which keep the ids the app's rules refer to.

Contracts are listed in full under each deployment, including the few that two deployments on one chain share (the collateral, a multisig). An address is only one contract on one chain: the same address on two chains is two different contracts, so those are never merged.

The loader refuses, with the entry's name in the message: a malformed address, a duplicated deployment id, a deployment naming a chain that is not listed, a role-candidate group naming a deployment that is not in the file, a kind the app does not know, a contract whose kind needs a name, and two names that come to the same id. `test/addresses.test.js` holds the file to the rules above: no deployment repeats its chain's details, no wallet is listed twice under one label or listed where it is already a contract, and no contract carries an id or repeats its kind in a name.

The file stands on its own: it does not say where an address was copied from and links to no internal document. A test fails if either is added.

The repository ignores other files called `addresses.json`, because deploy scripts write scratch files with that name into their output directories; only the one at the root is tracked.

## Where the data comes from

**Sources** on the deployment card says this for the snapshot on screen. The inspection behind it works in three layers:

| Layer        | Source                                                            | Role                                                                                  |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Address list | `addresses.json` at the repository root, read when the app starts | Names the contracts to start from.                                                    |
| Indexer      | The deployment's **Events** subgraph, listed in the same file     | Says where to look: every address that was ever granted a role, with the transaction. |
| Chain        | JSON-RPC, at one pinned block                                     | The only source of facts. Every connection, role and pointer shown was read here.     |

The chain is the judge and the subgraph is the scout. A Diamond's roles cannot be listed from the chain, and public RPC endpoints usually refuse a full event scan, so without an indexer a role holder missing from the address list stays invisible. `server/sources/subgraph.js` reads `roleGranteds` and `roleRevokeds`, replays them to the current holders, and `inspectRoleConnections` then asks the chain `hasRole` for each one at the pinned block. A holder the subgraph names but the chain denies is simply not shown, and a role connection the subgraph knew about carries its grant transaction. When a profile lists no events subgraph, or it cannot be reached, the inspection falls back to scanning events through the RPC and says how much of the history it could not read.

Only public `https` endpoints are contacted, with fixed query text, and nothing but the query is sent.

Reads are bundled. `server/sources/multicall.js` wraps the provider so that reads issued together travel in one `eth_call` to Multicall3, each keeping its own answer or revert. The Arbitrum inspection issues about 8,600 reads in about 400 requests and finishes in about three minutes on the public endpoint. A chain without Multicall3 is read call by call as before.

Each snapshot records its own provenance under `sources`: the address book entry and the date the file was last checked, the RPC host and block, the subgraph and how far behind the chain read it was, how many holders it named, which role events fell on contracts outside the address list, and the read counts. Issues are a comparison, not a chain fact: required grants come from rules in `server/roles.js`, and pointers are compared with the address list.

## Upgrade workbench

### Start with the deployment

**Arbitrum / Vibe / Enigma** is the deployment the app opens on, read from `addresses.json`. Click **Inspect live**. Reads use one pinned block; supplied addresses are not presented as verified wiring before inspection.

- **Needs attention:** every missing grant or mismatched pointer is listed above the tabs. Selecting one opens the map on the contract that owns it, with the failing connection selected and its read and expected values shown.
- **Wiring map:** Cytoscape.js renders one node per contract and one line per ordered contract pair. A node's tone and outline say what the contract is to the protocol: the core, a protocol contract, a solver's PartyB, a frontend's contracts, governance and wallets (pill-shaped), the token, an outside address, or code (facets and libraries, with cut corners). The icon inside says which contract of that family it is. The key in the map's corner lists the families drawn, and choosing one lights its contracts. Addresses that are wired identically are drawn as one stack, with their number where a contract has its icon: five relayers holding the same role, or four listed operators that hold nothing, are one node each. Nothing is merged away: the stack's panel lists its addresses, and its links say whose each connection is. Double-clicking a stack, or **Show them separately** in its panel, opens it; the **Stack look-alikes** chip turns stacking off. A contract that is selected is never inside a stack. The number beside a line is how many connections it carries; a thicker line carries more. Selecting a line lists every individual grant, pointer and administrator on it in the side panel, failing ones first, so no connection is merged away. Green means set, dashed red means the pair has a missing or mismatched connection, and dotted gray means a read was unavailable. Lines run from the holder to the contract granting access. The map opens fitted on one contract's neighborhood. A switch above it chooses between **Whole system** and **One contract**; in the second case a picker labelled **Around** names the contract, with every contract listed under the same headings the map uses. Double-clicking a contract does the same. Dragging moves the map wherever the press starts, on a contract or between them; the **Arrange** toggle in the toolbar switches dragging to moving contracts instead. Scrolling zooms towards the pointer, a sideways scroll moves the map, and a pinch or ⌘-scroll always zooms. The **Scroll** switch beside the zoom buttons makes scrolling move the map instead, and the choice is remembered. Nothing depends on guessing the pointing device, so the same scroll always does the same thing. The map cannot be moved out of sight, and its height is measured to fill the window so the page does not scroll under it. Clicking a contract lights up it and everything it touches while the rest steps back; a label in the corner offers **Show only this** to redraw around it. Filter chips switch each kind of connection on or off (integration roles, admin grants, role admins, owners and signers, pointers and hooks). Each chip shows how many it controls, and hiding a kind keeps every contract in place. **Issues only** and **Facets & libraries** are chips too, and the search finds a contract by name or address as well as a role or getter. A contract's panel can ask two questions of the map: **What it can change** and **Who can change it**. The answer counts three things, and only where the chain confirmed them: a role held, a role the address administers (an admin can grant that role to anyone, itself included), and ownership. It continues through Safes, timelocks and proxy admins to whoever controls them, and lists what is reached directly before what is reached through one of those. The map lights the contracts and lines in the answer, and each row opens the connection behind it. When the previous inspection differs from this one in its wiring, a **Changes** chip appears: it marks new and altered contracts and connections in amber and draws what has gone as dashed ghosts, with counters and other moving state left to the Changes tab. The list of changes is kept beside the snapshot in `.symmio/workbench/system/`, so it is still there after a restart. Reset the layout, fit, and expand to fullscreen from the toolbar. The panel beside the map is arranged by what is asked of a contract, and says each thing once: who can change it (by address, or turned round by role), what it can change, what it points to and what refers to it, its facets, and its settings. An address that is drawn on the map is shown as a connection and not repeated as a setting; values the code fixes, such as typehashes, sit under Technical details with the code hash and read errors, and the raw read is one click further. Values whose names say they are lengths of time are also given as time. Every row in those sections is a button, which gives keyboard access to the same lines the map draws.
- **Contracts:** searchable inventory with type, full copyable address, on-chain state and upgrade path. An address with no runtime is marked as having no contract code, not assumed to be a broken contract. The Checkout column appears after Compare source.
- **Changes:** compile the checkout and compare current facets/implementations; inspect added functions and selectors absent from the desired ABI. Separately see configuration changes since the previous inspection. Runtime comparison for constructor-based contracts excludes immutable bytes and is informational; rehearsal verifies the exact deployment runtime.
- **History:** saved Diamond and peripheral plans for the selected deployment's chain, with their contract family, address and execution state. Plans from other deployments are one checkbox away.

Use the settings button beside **Compare source** to change RPC or import another profile. The schema is the same as the supplied JSON: `id`, `name`, `chainId`, and `nodes` with unique IDs, kinds and addresses. `core` is required. Do not infer completeness from an empty wiring warning count: only explicitly probed relationships are checked.

Role inspection checks local and verified-ABI role catalogs, enumerable members, the holders named by the events subgraph (or by an RPC event scan when there is none) and supplied inventory. See “Workspace catalogue and graph discovery” below for coverage and limitations. Expected integration grants require contract authorization checks; the unused AccountLayer `INSTANT_LAYER_ROLE` is excluded.

### Supported upgrade paths

| Contract           | Preparation and execution                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SYMMIO Core        | Select facet changes, include linked libraries, rehearse an atomic Diamond cut, execute and verify complete routing/runtime.                                                                                        |
| AccountLayer       | Same Diamond workflow using its own facet/library catalog and baseline scope.                                                                                                                                       |
| PartyB             | Deploy a new implementation, call `upgradeToAndCall` with empty initializer data, verify implementation slot and preserved Core/signer/pause state.                                                                 |
| InstantLayer       | Deploy replacement; copy templates, execution flags, cooldown, reviewed whitelist/PartyB inventory and roles; update Core permissions, PartyB trust and GaslessLayer pointer; retire old Core/PartyB authorization. |
| Signature verifier | Deploy replacement; copy every public key, gateway signer, all 256 permission IDs and admin/setter roles; switch Core's verifier pointer; verify copied configuration.                                              |

Express Provider, hooks, managers, the liquidator and other supplied addresses provide deployment context. They do not have upgrade adapters in this workbench.

#### Diamond workflow

Choose **Prepare upgrade** from a contract or source comparison, or pick a contract under **Upgrade**. Changed facets are preselected when a comparison exists. **Inspect & compile** reads the target and compiles its contract family. It uses the connection made by **Inspect live**; with only a saved snapshot it uses the profile's RPC. **Change target or RPC** overrides either. Patch mode retains every omitted selector, including functions removed from a facet ABI. Removals require explicit selection. Reconcile mode requires acknowledgement of the full removal set.

If the desired build no longer identifies every live facet/library, import the original deployed build bundle. Export builds before changing source. Baselines are scoped to Core or AccountLayer; unknown baselines and changed storage-related sources block execution. The second rehearsal uses the actual deployed replacement addresses before generating the final cut.

#### Peripheral workflow

Choose the contract, deployment EOA and configuration/upgrade authority. The authority can be an EOA or a Safe that holds the required roles. Review the before/after summary and ordered deployment, configuration, cutover and retirement transactions. Each call has decoded arguments, exact calldata, target and signer.

The deployment address is derived from the deployment signer's pending nonce. A changed nonce invalidates the plan. The build must match current source. PartyB requires either an exact recognized implementation or a matching deployed baseline with unchanged storage definitions; a matching constructor-masked runtime alone never authorizes a transaction.

For InstantLayer, review additional PartyBs/whitelisted targets and acknowledge the migration inventory and client cutover. The supplied contracts and enumerable role holders are checked automatically. Non-enumerable mappings cannot be exhaustively discovered this way. User nonces, delegations and operation-usage mappings are not migrated; the new contract has a different EIP-712 domain and users must reauthorize. External integrations beyond the reviewed inventory need separate cutover work.

Run the complete fork rehearsal. It executes every action and checks the exact replacement runtime and post-state. Then either export the reviewed transaction bundle or use **Execute** → **Start upgrade**.

#### Signing and Safe

Browser-wallet transactions require separate signatures. Ledger signs on the machine running the service; its selected path applies to every Ledger transaction in the run.

For a Safe authority, deploy with an EOA wallet/Ledger first. The task then waits. **Export Safe calls** succeeds only when the reviewed replacement runtime exists at the expected address. Import that batch into Safe and execute it in order, then **Continue task** to verify the result. Export is not execution. Safe-service proposals and signature collection happen outside the app.

### Recovery

All upgrade adapters and `./symmio` share one active-task lock. Resume workbench tasks in their originating GUI. After a restart, inspect the same deployment to reconnect, open the saved plan and continue.

An intent is persisted before opening the wallet and can be claimed only once. If its response is lost, select **Stop waiting and recover**, then attach the wallet's transaction hash. Recovery binds sender, nonce, chain, target, value and calldata. An unknown outcome blocks both retries and cancellation. Explicit wallet rejection clears the unbroadcast intent; ambiguous provider errors do not. Do not delete task state to bypass an unresolved outcome.

Cancellation preserves confirmed work. It cannot undo deployments or a mined upgrade. If source or chain state changes unexpectedly, reconcile pending transactions, cancel, inspect again and prepare a new plan.

Plans, snapshots, receipts and review evidence live in ignored `.symmio/workbench/`. Profile RPC credentials are stripped before snapshot persistence.

### Verification boundaries

- Rehearsal impersonates authorities and funds fork accounts. It does not prove real wallet funding, Safe guards/modules/signatures, or trading/liquidation/accounting invariants. It uses Cancun execution rules; chain-specific differences need additional validation.
- Storage checking compares state declarations/inheritance and conservatively hashes sources containing structs, enums, assembly and explicit slots. It is not a general layout analyzer. Some harmless edits are blocked; storage-changing migrations and initializers need a dedicated reviewed adapter.
- Safe detection uses interface checks, not an audited-code allowlist. Local checkout, compiler configuration and imported baseline files are trusted operator inputs.
- One receipt confirmation is used. Explorer verification, finality tracking and automatic rollback are not implemented. Another operator can race an ordinary EOA or external Safe transaction after its last preflight; there is no on-chain snapshot guard.
- Tests use real local Diamonds, InstantLayer, PartyB and verifier contracts, plus a Safe-shaped fixture and a local wallet adapter. Physical Ledger, real browser extensions and production Safe execution are not proven by these tests.

## Demo and checks

```sh
npm run upgrade:demo      # Disposable Core at 127.0.0.1:8547; prints its addresses
npm run test:ui           # Server tests; includes compilation and real-contract integration tests
npm run test:ui:web       # React component tests
npm run test:cli
npm run lint
```

The demo installs Core routing but does not initialize a trading system. It uses public development accounts and resets when stopped. System integration tests separately exercise the remaining upgrade adapters on disposable local chains.

### Workspace catalogue and graph discovery

The workspace picker lists all 26 deployments in `addresses.json`, last checked against the chain on that file's `checked` date. Production, staging, test/development and deprecated deployments remain distinct. Role candidates are only addresses to check: live reads establish the current grants.

The default System view shows contracts and their operational connections. Facets, implementations and linked libraries appear only in the dedicated Facets & libraries view. Each connection is kept as its own record: role grants, effective role administrators, owners, Safe signers, pointer getters, registrations, allowlists, affiliate hooks and selector permissions, proxy implementations/admins, Diamond facets and exactly identified linked libraries. The canvas draws them as one line per contract pair and lists them individually when the line is selected. Filters and contract focus reduce the visible set without dropping connections from that list. Fullscreen keeps the filters, zoom, inspector and selected connection details in the graph workspace; Escape closes it. The whole-system layout uses deterministic lanes: governance on the left, then execution, Core/accounts, services, and affiliates/external contracts on the right. A single contract's neighborhood groups those lanes into three columns around Core so it fits at a readable size. Facet view arranges contracts, implementations/facets, then libraries. Nodes can still be dragged manually. Green means every connection on the line is set; red means a required connection is missing or mismatched; gray means unavailable or optional unset. The unused AccountLayer `INSTANT_LAYER_ROLE` is never a required grant.

Reads use one pinned block. Discovery combines local ABIs with public verified deployment/implementation/facet ABIs from Sourcify, enumerable roles, a bounded adaptive event scan, and supplied inventory. RPC range limits are reported as incomplete history. Contract inspectors show every role queried, unavailable reads, and library-identification coverage. External ABIs may be unavailable; arbitrary non-enumerable mapping keys cannot be inferred without events or inventory. A successful inspection therefore does **not** certify universal coverage. Custom profiles can supply `roleCandidates`, hash-based `observedRoles`, and explicit `expectedRoles` to cover deployment-specific integrations. No absent optional role is automatically treated as a setup defect.

Switching workspaces clears the live RPC, comparison, build baseline and selected plan, and loads that deployment's saved snapshot if one exists. Executable peripheral plans must match the inspected chain and Core address. A deployment's `version` is a label, not an assertion about live code. The inspector verifies the RPC chain before reading contracts.

## Frontend development

`npm run ui` builds the React app and serves it with the authenticated API (`npm run upgrade:gui` is kept as an alias). For hot reload, keep the API server running and start `npm run ui:dev`; open `http://127.0.0.1:4319/#<session-token>` using the same fragment printed by the API server. The Vite proxy forwards only API and docs assets.

```sh
npm run ui:typecheck
npm run test:ui:web
npm run ui:build
```

The visual language is flat and tonal, in the manner of Material: rounded cards, pill controls, and depth expressed only as the step between two solid fills. There is no blur, translucency, glow or shadow, and cards carry no outline. Surfaces are neutral grey; coral is reserved for the primary action, the brand mark and the Core contract. `ui/src/styles.css` defines the roles (`--panel`, `--panel-soft`, `--raise` for surfaces; `--primary`, `--primary-container`, `--secondary-container`, `--error-container` and their `--on-*` text colours; `--r-card`, `--r-inner`, `--r-pill` for shape). `main.tsx` sets the matching Mantine radii and greys; `lib/graph-styles.ts` and the fuzz stylesheet mirror the colours, since neither can read the app's CSS variables. New screens should use those roles, not fixed colours, and should fill the available width.

React source lives in `perps-core-ui/ui/src/`. `api.tsx` manages authenticated queries and operations; the workspace, inspector, preparation and signing screens are separate components. URL state retains navigation and graph filters. Session drafts are isolated by chain, contract, scope and build; execution confirmations are never retained. The server serves the generated `perps-core-ui/dist/` assets, not a separate legacy frontend.
