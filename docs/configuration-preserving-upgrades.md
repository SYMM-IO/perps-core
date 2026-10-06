# Configuration preservation for replacements

Replacing InstantLayer copies administrative configuration and reconnects its consumers. The replacement starts with fresh nonces, delegations, revocations and consumed-message records. Existing users must authorize the new signing domain before using it. None of those user records belong in the configuration input.

An ordinary proxy or diamond upgrade keeps the existing contract address and storage. Check its release-specific storage compatibility and preserve its configuration; do not clear or initialize its existing storage as part of replacing InstantLayer.

## Upgrade flow

1. Bind the reviewed source release, deployed baseline, chain, credential recipe, contract runtimes, configuration profiles, consumer inventory and authorities. Supply complete keys for mappings that have no enumeration views.
2. Optionally rehearse the complete reviewed upgrade on a fork in a separate run. Run it whenever needed before execution. Its source, input and block bindings identify what was rehearsed; changing them requires new evidence.
3. Deploy replacements and check linked runtime bytecode against the intended implementation. Keep explorer publication for the final stage.
4. Copy configuration, templates, flags, registries and explicitly mapped administrative roles. Verify the replacement before activating it. Prepare relayers, clients and solvers for its new address and fresh authorizations.
5. Enter maintenance and capture a final configuration and wiring checkpoint. Compare it with the reviewed snapshot before applying any cut or consumer update.
6. Apply reviewed cuts and wiring changes through each actual owner or role administrator. Preserve observed permissions, remove superseded permissions only under the explicit retirement policy, and check canonical execution receipts.
7. Verify configuration, selectors, implementations, roles and every declared consumer at the confirmed post-state. Restore the original maintenance state after application checks.
8. Publish source and ABIs on the configured scanners. Publication retries use their own checkpoints and do not repeat deployments or governance actions.

The [standard Core task](core-upgrade.md) implements optional separate rehearsal and final publication for Core. The configuration preparation task below produces read-only evidence and exact calls; it does not execute this complete dependency-upgrade flow. The older deployment-specific AccountLayer/InstantLayer task has its own targets and execution policy and must not be substituted for a reviewed generic production run.

## Prepare configuration from JSON

Select **Other maintenance scripts → Prepare configuration preservation from JSON** (`operations.prepare-configuration`) in `./symmio`. It reads only declared configuration getters at pinned blocks. It does not deploy, sign, broadcast, export user state or scan transaction history.

The request binds a clean source checkout, an existing credential recipe and a profile file. SHA-256 values use the repository's `sha256:` prefix. Keep operator inputs and credential recipes outside tracked files when they contain deployment-specific or private references; enter secrets through the keystore.

```json
{
	"schemaVersion": 1,
	"kind": "symmio.configuration-request",
	"sourceCommit": "<reviewed 40-character Git commit>",
	"credentialRecipe": "./credential-recipe.json",
	"profile": {
		"file": "./instant-configuration-profile.json",
		"sha256": "sha256:<64 hexadecimal characters>"
	},
	"sourceCheckpoint": {
		"blockNumber": 123,
		"blockHash": "<canonical block hash>"
	},
	"target": {
		"contract": {
			"address": "<deployed replacement>",
			"codeHash": "<replacement runtime keccak256>"
		},
		"checkpoint": {
			"blockNumber": 124,
			"blockHash": "<canonical block hash>"
		}
	}
}
```

Omit `target` to capture configuration before deploying a replacement. Including it also produces a migration plan. Requests reject unknown fields, including user-state inputs. The result is saved under `tasks/data/<chain[-fork]>/configuration/<run-id>/prepared-configuration.json`. Resumption rejects changes to the request, recipe, profile, source checkout or saved evidence.

To prepare administrative roles and all declared consumer reconnections in the same report, add optional file references:

```json
{
	"roles": {
		"file": "./instant-role-profile.json",
		"sha256": "sha256:<profile file hash>",
		"maxMembersPerRole": 100
	},
	"wiring": {
		"file": "./instant-consumer-profile.json",
		"sha256": "sha256:<profile file hash>",
		"dependency": "instant"
	}
}
```

Both require a deployed `target`. Role profiles bind exactly the same source and target contract records; wiring profiles bind that source and dependency on every edge. Every profile must select the same chain. Role members are enumerated automatically through `getRoleMemberCount` and `getRoleMember`, with an explicit per-role limit. An exceeded limit rejects the whole result. No member-list export is required for enumerable roles.

The report keeps configuration setters, role grants, wiring activations and old-permission retirements separate, with each call's actual authority. Preparation rejects source-setting, source-role or consumer-membership drift between the source and target checkpoints. Retirements require the execution adapter's reviewed ordering and receipt checks; the preparation task sends none of these calls.

## Muon configuration preservation

Add `"muon": { "file": "./muon-profile.json", "sha256": "sha256:<64 hexadecimal characters>" }` to a configuration request to include Muon evidence. This is also available before deploying the replacement. The profile uses `schemaVersion: 1`, `kind: "symmio.muon-upgrade-profile"`, the same `chainId`, and `core` and `verifier` records containing `{ address, codeHash }`. These records describe the preserved Core and verifier; this adapter does not replace or reconfigure the verifier.

Pinned view reads capture the Core verifier pointer, app ID, global price/UPNL windows, effective per-function UPNL windows and override flags; all enumerated verifier public keys and gateways; every current function category's capability and permission bits; and default-admin/SETTER role memberships and role administrators. False permission bits are preserved as well as true ones. A missing getter, changed runtime, exceeded enumeration limit or configuration drift rejects the result. No signature, delegation, nonce or raw storage export is needed.

The optional `policy` accepts `requiredFunctions`, `additionalVerifierRoles`, `maxRoleMembers` and `maxSigners`. Defaults cover the Core categories, the verifier's standard administrative roles and limits of 100 members/signers. Add ExpressCredit when checking its separate provider integration. ExpressCredit has no Core UPNL window; preserve and check its provider freshness policy in that component's configuration profile. Additional custom role IDs must be supplied explicitly. The ordinary Core upgrade snapshots include these Muon reads automatically; a standard Core input can supply the same policy as `muon`.

Configuration preservation proves the declared contract views and identities, not a running Muon service registration or signed payload compatibility. InstantLayer has no Muon configuration of its own: it routes calls through AccountLayer or PartyB to Core. A replacement still needs its Core/AccountLayer permissions, PartyB enrollment, templates and calldata offsets checked. The off-chain deployment identity remains `(chainId, Core address)` when only InstantLayer is replaced. Service and routed-call readiness are separate prerequisites for restoration.

## Configuration profile

A profile has `schemaVersion: 1`, `kind: "symmio.configuration-profile"`, `chainId`, `source: { address, codeHash }` and `fields`. For a proxy, bind its implementation with `implementation: { slot, address, codeHash }` on the source and target contract records. Runtime parity and implementation identity are checked separately from scanner publication.

Each field has a unique `id`, a `mode`, and `read: { signature, args }`. Use full ABI signatures including `view` and output types. Getter arguments are literal configuration keys. `targetRead` can describe a changed getter ABI; its normalized value must still match the observed source value.

| Mode        | Behavior                                                                    |
| ----------- | --------------------------------------------------------------------------- |
| `copy`      | Copy a differing scalar, array or named tuple using an explicit setter.     |
| `flag`      | Select `write.whenTrue` or `write.whenFalse` from the observed boolean.     |
| `immutable` | Reject a different constructor-bound value or preserved dependency address. |
| `derived`   | Verify a final value produced by other configuration calls.                 |
| `append`    | Create missing contiguous entries; existing entries must match exactly.     |

Write modes declare `authority: { address, read: { signature, args } }`. The owner/role getter must prove that specific authority at the target checkpoint. The deployment wallet is not assumed to be the administrator. Setters use `{ "ref": "observed" }`, optionally with `path` selecting a named tuple or multi-output component. Integer values are decimal strings, preserving full Solidity precision.

For example, a cooldown field reads `function revocationCooldown() view returns(uint256)` and writes `function setRevocationCooldown(uint256)` with `args: [{ "ref": "observed" }]`. A selector-fee getter returning `(bool configured,uint256 amount)` maps those names to two setter arguments. Outputs and tuple components require unique names when more than one value is returned.

An append field additionally declares `cursor: { read, index }`, where `index` is a decimal string and `read` returns `uint256`. `afterWrite` can reproduce flags after creating an entry. Keep an entry's creation and follow-up calls atomic, or use an execution journal that checks the confirmed prefix before recovery; rerunning preparation is not a substitute for reconciling a partially executed append.

Declare setter side effects through `dependsOn` on a later `copy` or `flag` field. For example, the AccountLayer whitelist field depends on the account-address field: setting the account address automatically enables its whitelist, so a source whitelist value of `false` must be written afterward even when the replacement initially returned `false`. Dependencies must name earlier fields; cycles and forward references are rejected. The extra setter is included only when a dependency has planned calls. Release adapters must account for all cross-field effects and implicit role grants when ordering configuration and administrative changes.

Snapshot preparation checks expected input values when supplied, source/runtime identity and canonical block hashes. Planning rereads both the pinned source and source configuration at the target checkpoint, rejecting altered snapshots and configuration drift. It emits target/value/calldata/authority for each required setter, plus final getter expectations and a digest. Existing matching settings produce no calls. Verification checks the plan digest, target runtime/implementation, final getters and canonical block again. `verifyPreparedConfiguration` verifies the configuration, roles and consumers together, against the saved reviewed evidence digest; it produces post-state evidence and does not replace transaction-receipt verification.

## Coverage and non-enumerable keys

Release adapters must declare their configuration coverage. For this upgrade that includes InstantLayer references, cooldown, transient-storage setting, whitelist, registered PartyBs, templates and administrative roles; Gasless references, base fees, selector fees and relayer permissions; and AccountLayer, Core and solver consumers of InstantLayer.

Provide complete InstantLayer whitelist and registered PartyB/solver address lists. Standard role IDs come from the reviewed release; include any additional role IDs only if extra roles were configured. Template counts and enumerable role memberships can be checked through their views. A view can validate each supplied mapping key but cannot prove that a non-enumerable list omitted nothing. Do not describe a partial key list as complete. No archive/debug storage export is required for this configuration-only scope.

Gasless function-specific fee overrides use bytes4 function selectors as keys. Upgrading its existing proxy keeps those mapping entries in storage, so exporting every selector is not required to copy them. Supplied selectors can provide additional post-upgrade checks. Replacing Gasless with a new contract would require a complete selector inventory and a different reviewed policy.

`deployment-tooling/operations/wiring-migration.js` captures declared address pointers and memberships with consumer runtime and authority bindings. It migrates active memberships, preserves inactive ones and checks retirement and post-state. Declare every consumer; the planner cannot discover unknown integrations.

`deployment-tooling/operations/role-migration.js` uses explicit `sourceRole → targetRole` transitions and an `exact-source-members` policy. It proves enumerable source member counts and each positive membership, verifies both source and target role administrators, and grants only missing members. `sourceAdminRole` defaults to the declared target `adminRole`; supply it explicitly for a reviewed administrator-role transition. Extra target members are rejected. Bootstrap authority handover or removal needs a separate reviewed policy. For the older InstantLayer release, moving template administration from `SETTER_ROLE` to `TEMPLATE_MANAGER_ROLE` is an explicit release transition, not an inferred new permission.

Prepared calls, a successful local test, a fork rehearsal, a Safe export and explorer publication are different evidence. Production completion requires the reviewed complete configuration inventory, actual authorities, executed canonical receipts and verified post-state.
