# InstantLayer Template Script Guide

This guide explains how to use `scripts/addSendAllocateLockOpenTemplate.ts`.

The script accepts path lists directly from env values and builds templates from those paths.

## Input Pattern

For open templates, use one of:

- `OPEN_PATH=[sendQuote,allocate,lock,open]`
- `OPEN_PATHS=[[sendQuote,allocate,lock],[sendQuote,lock]]`

Optionally define close template:

- `CLOSE_PATH=[requestClose,allocate,fillClose]`

Examples of partial paths:

- `OPEN_PATH=[sendQuote,lock,open]`
- `OPEN_PATH=[sendQuote,lock]`
- `OPEN_PATHS=[[sendQuote,allocate,lock],[sendQuote,lock,open]]`
- `CLOSE_PATH=[requestClose,fillClose]`

If neither `OPEN_PATHS` nor `OPEN_PATH` is provided, default open path is used:

- `[sendQuote,allocate,lock,open]`

If both are provided, `OPEN_PATHS` takes precedence.

## Allowed Tokens

Open path tokens (ordered subsequence of the canonical open flow):

- `sendQuote`
- `allocate`
- `lock`
- `open`

Close path tokens (ordered subsequence of the canonical close flow):

- `requestClose`
- `allocate`
- `fillClose`

Token aliases are also accepted (case-insensitive), including:

- `sendQuoteWithAffiliateAndData` -> `sendQuote`
- `lockQuote` -> `lock`
- `openPosition` -> `open`
- `requestToClosePosition` -> `requestClose`
- `fillCloseRequest` -> `fillClose`
- `allocateForPartyB` -> `allocate`

## Injection Rules

In open paths:

- `lock` receives `quoteId` injected into `arg0` from `sendQuote` result.
- `open` receives `quoteId` injected into `arg0` from `sendQuote` result.

Other steps in these presets do not use result injection.

## Prerequisites

- InstantLayer contract is deployed on the selected network.
- Executor account has `SETTER_ROLE` on InstantLayer.
- Hardhat RPC is reachable.

## Run Commands

### Dry Run (No Transaction)

```bash
DRY_RUN=true \
OPEN_PATHS='[[sendQuote,allocate,lock],[sendQuote,lock]]' \
CLOSE_PATH='[requestClose,fillClose]' \
DRY_RUN_OUTPUT_PATH=./tasks/data/my-template-dry-run.json \
INSTANT_LAYER_ADDRESS=0xYourInstantLayer \
npx hardhat run scripts/addSendAllocateLockOpenTemplate.ts --network <yourNetwork>
```

### Real Execution (Sends Transactions)

```bash
OPEN_PATHS='[[sendQuote,allocate,lock,open],[sendQuote,lock,open]]' \
CLOSE_PATH='[requestClose,allocate,fillClose]' \
INSTANT_LAYER_ADDRESS=0xYourInstantLayer \
npx hardhat run scripts/addSendAllocateLockOpenTemplate.ts --network <yourNetwork>
```

## Environment Variables

| Variable                      | Required | Default                                           | Description                                                              |
| ----------------------------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `INSTANT_LAYER_ADDRESS`       | no       | from `tasks/data/instantlayer.json`               | Target InstantLayer address                                              |
| `OPEN_PATHS`                  | no       | not set                                           | Multiple open paths, e.g. `[[sendQuote,allocate,lock],[sendQuote,lock]]` |
| `OPEN_PATH`                   | no       | `[sendQuote,allocate,lock,open]`                  | Single open path list                                                    |
| `CLOSE_PATH`                  | no       | not set                                           | Close path list                                                          |
| `TEMPLATE_NAME_PREFIX`        | no       | empty                                             | Prefix applied to generated template names                               |
| `OPEN_TEMPLATE_NAME`          | no       | auto                                              | Explicit name for open template (single open path only)                  |
| `CLOSE_TEMPLATE_NAME`         | no       | auto                                              | Explicit close template name                                             |
| `INSTANT_LAYER_TEMPLATE_NAME` | no       | empty                                             | Name override only when exactly one template is generated                |
| `ALLOW_DUPLICATE_TEMPLATE`    | no       | `false`                                           | If `true`, allows duplicate template names                               |
| `DRY_RUN`                     | no       | `false`                                           | If `true`, no transactions are sent                                      |
| `DRY_RUN_OUTPUT_PATH`         | no       | `./tasks/data/instantlayer-template-dry-run.json` | Dry-run JSON report path                                                 |

## Output

### Console Output

Startup prints:

- chain id
- latest block number (RPC health)
- executor address
- InstantLayer address
- resolved open paths
- resolved close path

Dry run prints:

- `Dry run report written to: <path>`

Real run prints:

- each template name and path
- tx hash for each submitted template
- created template id per success
- skip reason for blocked templates

### Dry-Run JSON

Dry run writes one JSON report containing:

- top-level runtime state (`chainId`, `executor`, `rpcHealth`, `contractCodePresent`)
- requested path inputs under `requestedPaths`:
    - `openPaths` (array of open path arrays)
    - `closePath` (single array or `null`)
- template decisions in `templates[]` (one entry per generated template)
- summary counts (`total`, `addable`, `blocked`)

Each `templates[]` entry includes:

- `kind` (`open` or `close`)
- `templateName`
- `description`
- `pathTokens`
- `existingTemplateId`
- `nextTemplateId`
- `predictedTemplateId`
- `wouldSubmitTransaction`
- `reason`
- `operations`
- `simulation`

## Safety Features

- RPC health pre-check (`getNetwork` + `getBlockNumber`)
- contract bytecode presence check at InstantLayer address
- duplicate-name guard by default
- per-template `addTemplate.staticCall` simulation before real send
