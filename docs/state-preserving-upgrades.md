# State-preserving upgrades

The live workflow is inspect, deploy replacements, prepare consumers, freeze and checkpoint, apply the reviewed migration and wiring, verify state, restore service, then publish sources and implementation ABIs. Fork rehearsal is a separate optional run. Runtime parity, authority, receipts and post-state checks are mandatory regardless of rehearsal or explorer publication.

Deployment profiles supply addresses, authorities, dependency edges and policies. Release adapters describe supported baselines, storage compatibility, initialization and any explicit state transformations. Unsupported transitions fail validation. The deployment signer, migration authority, upgrade authority and operational roles are separate inputs.

## Complete replacement state

Event logs and lists of known users cannot establish all hash-key replay counters or deleted mapping keys. `deployment-tooling/operations/storage-snapshot.js` therefore rebuilds the complete secure Ethereum storage trie from raw slot/value entries and compares its root to the source account proof. Missing or invented nonzero entries fail the root check. Zero values are absent trie entries; duplicate slots are rejected.

`readStorageSnapshot` obtains the chain, canonical block hash, state root, account proof and runtime code from one explicit historical checkpoint. It verifies the account proof and code hash, then reconstructs the storage root. Providers must support historical `eth_getProof`; supplying a root in JSON does not prove canonical block provenance. A raw storage inventory with slot preimages is required. RPC support and complete inventory availability must be checked for each deployment before scheduling a migration.

`buildStorageImport` revalidates a saved snapshot and creates a deterministic Merkle commitment with a proof for each indexed raw slot/value. The import commitment also records a digest of the source checkpoint and account proof. A migration authority approves that commitment after checking the source evidence. Merkle import proofs authenticate approved values; they do not authenticate a chain header on-chain.

`StorageMigration` is a temporary implementation behind a fresh transparent proxy. Chunks must follow the committed, strictly sorted slot order. Progress is kept in a reserved ERC-7201 namespace; ERC-1967 proxy slots cannot be imported. Invalid chunks revert atomically, and a retry starts at the on-chain next index. Sealing requires every entry. `StorageMigrationCoordinator` prevents activation before sealing, upgrades to its bound implementation, then hands the standard ProxyAdmin to the configured upgrade authority. Operational source roles come from imported state, not the deployment wallet.

Raw import is permitted only for a release adapter that proves storage compatibility, excludes proxy and migration metadata slots, and specifies any necessary transformations. Source immutables, constructors and signature domains require separate checks: copying storage alone is insufficient.

## InstantLayer replacement

The deployed direct InstantLayer has nonenumerable authorization and replay mappings. Core pause alone does not freeze its grant and revoke entry points. The cutover must establish a source-state freeze or equivalent enforced write barrier before taking the final complete snapshot. A stale snapshot cannot preserve subsequent user writes.

A replacement should use a stable upgradeable address for future releases. Existing grants, pending revocation timestamps, ordered nonces and salt usage counters must be preserved. A new address changes the EIP-712 signing domain, so pending signatures need to be recreated. Release-specific replay-key compatibility must preserve previously consumed operation and delegation identifiers even when their signing domain changes. This requires contract support and tests in addition to the complete snapshot mechanism.

The current Core-only task preserves existing dependency addresses. It does not yet perform a direct InstantLayer user-state replacement. Do not use the older AccountLayer/InstantLayer configuration-copy task as evidence that user replay state is migrated.
