# InstantLayer PartyB Integration Guide

This document explains how PartyB integrators can sign operations for the InstantLayer system.

For a high-level architectural overview, see the [InstantLayer Overview](./instant-layer-overview.md).

## Overview

InstantLayer allows PartyB to sign operations off-chain that can be executed by anyone on-chain. This enables batched execution and delegated transaction submission.

**New: Self-Execution Mode** - When PartyB is the transaction sender (`msg.sender`), signature verification is skipped for their own operations. This means PartyB can execute their operations directly without signing, while still providing user signatures for user operations in the same batch.

## What PartyB Needs to Sign

PartyB signs a `SignedOperation` struct using EIP-712 typed data signing.

### SignedOperation Structure

```typescript
interface SignedOperation {
  signer: string;           // PartyB contract address
  target: string;           // Symmio contract address
  callData: string;         // Encoded function call (e.g., lockQuote, openPosition)
  signerAccount: {
    addr: string;           // PartyB contract address (must match signer)
    isPartyB: boolean;      // Must be true for PartyB
  };
  flexFields: FlexField[];  // Modifiable calldata regions (empty for standard ops)
  maxUses: number;           // Max execution count (1 for standard ops)
  replayAttackHeader: {
    nonce: bigint;          // Sequential nonce (0 for salt-only mode)
    deadline: bigint;       // Unix timestamp expiry (0 for no deadline)
    salt: string;           // Unique 32-byte hex string
  };
}

interface FlexField {
  offset: number;            // Byte offset after 4-byte selector
  length: number;            // Number of bytes (typically 32)
  authorizedFlexFiller: string; // Address authorized to fill this field
}
```

For standard PartyB operations, `flexFields` is always `[]` and `maxUses` is `1`. See the [InstantLayer Overview](./instant-layer-overview.md#flex-fields) for flex field details.

## EIP-712 Configuration

### Domain

```typescript
const domain = {
  name: "SymmioInstantLayer",
  version: "1",
  chainId: <network_chain_id>,
  verifyingContract: <instant_layer_address>
};
```

### HyperEVM v0.8.5 Deployment

For the current HyperEVM v0.8.5 deployment, use the Instant Layer address as the EIP-712 `verifyingContract` and the Symmio address as the `target` for Symmio core calls:

| Contract | Address |
|----------|---------|
| Symmio | `0x57331038c21982116EE9b0906E4a5c5cB52dcE2e` |
| Collateral | `0xb88339CB7199b77E23DB6E890353E22632Ba630f` |
| Account Layer | `0x46493c376758Da47823D7E3Ae5d417eA6546eEB3` |
| Instant Layer | `0x72DBF07457b2712b160F67A85D338F860c1CA620` |
| Muon Signature Verifier | `0xcFEedF3C16f59d19eEE5F18C708cf8e84A9340b0` |
| Create2 Factory | `0x93a457232a3376E1F94f368A85D0b8BC469ead00` |
| Symbol Manager | `0xe877d634D5Fe44172B983cBd5900E30169a7A6Ce` |
| Main MultiSig | `0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9` |
| Signature Verifier | `0xaD97EdE10D84BD797a3240864Ca7898cf666A784` |
| Instant Withdraw | `0xb1b12E91E456D02184E4B934Bd8dD0c443962015` |
| Liquidator | `0x97EDFA4Be38Bfd934E08D4D1222c2Cf976b2969a` |

```typescript
const HYPEREVM_CHAIN_ID = 999n;
const INSTANT_LAYER_ADDRESS = "0x72DBF07457b2712b160F67A85D338F860c1CA620";
const SYMMIO_ADDRESS = "0x57331038c21982116EE9b0906E4a5c5cB52dcE2e";
const ACCOUNT_LAYER_ADDRESS = "0x46493c376758Da47823D7E3Ae5d417eA6546eEB3";
```

### Types

```typescript
const types = {
  Account: [
    { name: "addr", type: "address" },
    { name: "isPartyB", type: "bool" },
  ],
  FlexField: [
    { name: "offset", type: "uint256" },
    { name: "length", type: "uint256" },
    { name: "authorizedFlexFiller", type: "address" },
  ],
  ReplayAttackHeader: [
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
  SignedOperation: [
    { name: "signer", type: "address" },
    { name: "target", type: "address" },
    { name: "callData", type: "bytes" },
    { name: "signerAccount", type: "Account" },
    { name: "flexFields", type: "FlexField[]" },
    { name: "maxUses", type: "uint256" },
    { name: "replayAttackHeader", type: "ReplayAttackHeader" },
  ],
};
```

## Code Examples

### Complete Signing Example (ethers.js v6)

```typescript
import { ethers } from "ethers";
import { randomBytes } from "crypto";

// Configuration
const INSTANT_LAYER_ADDRESS = "0x..."; // InstantLayer contract address
const SYMMIO_ADDRESS = "0x...";        // Symmio contract address
const PARTY_B_ADDRESS = "0x...";       // Your PartyB contract address

// EIP-712 Domain
async function getDomain(provider: ethers.Provider) {
  const network = await provider.getNetwork();
  return {
    name: "SymmioInstantLayer",
    version: "1",
    chainId: network.chainId,
    verifyingContract: INSTANT_LAYER_ADDRESS,
  };
}

// EIP-712 Types
const types = {
  Account: [
    { name: "addr", type: "address" },
    { name: "isPartyB", type: "bool" },
  ],
  FlexField: [
    { name: "offset", type: "uint256" },
    { name: "length", type: "uint256" },
    { name: "authorizedFlexFiller", type: "address" },
  ],
  ReplayAttackHeader: [
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
  SignedOperation: [
    { name: "signer", type: "address" },
    { name: "target", type: "address" },
    { name: "callData", type: "bytes" },
    { name: "signerAccount", type: "Account" },
    { name: "flexFields", type: "FlexField[]" },
    { name: "maxUses", type: "uint256" },
    { name: "replayAttackHeader", type: "ReplayAttackHeader" },
  ],
};

// Generate unique salt
function generateSalt(): string {
  return "0x" + randomBytes(32).toString("hex");
}

// Create and sign an operation
async function signPartyBOperation(
  signer: ethers.Wallet,
  callData: string,
  nonce: bigint = 0n,
  deadlineSeconds: number = 300 // 5 minutes default
) {
  const provider = signer.provider!;
  const domain = await getDomain(provider);

  const block = await provider.getBlock("latest");
  const deadline = deadlineSeconds > 0
    ? BigInt(block!.timestamp) + BigInt(deadlineSeconds)
    : 0n;

  const operation = {
    signer: PARTY_B_ADDRESS,
    target: SYMMIO_ADDRESS,
    callData: callData,
    signerAccount: {
      addr: PARTY_B_ADDRESS,
      isPartyB: true,
    },
    flexFields: [],
    maxUses: 1,
    replayAttackHeader: {
      nonce: nonce,
      deadline: deadline,
      salt: generateSalt(),
    },
  };

  const signature = await signer.signTypedData(domain, types, operation);

  return { operation, signature };
}
```

### Example: Sign a lockQuote Operation

```typescript
// Encode the lockQuote function call
const symmioInterface = new ethers.Interface([
  "function lockQuote(uint256 quoteId, uint256 upnl, int256 price, bytes memory upnlSig, bytes memory priceSig)"
]);

const callData = symmioInterface.encodeFunctionData("lockQuote", [
  quoteId,
  upnl,
  price,
  upnlSig,
  priceSig
]);

// Sign the operation
const { operation, signature } = await signPartyBOperation(
  hedgerSigner,  // The signer configured in your PartyB contract
  callData,
  0n,            // nonce: 0 for salt-only mode
  300            // deadline: 5 minutes
);

// Submit to InstantLayer (can be done by anyone)
await instantLayer.executeBatch([operation], [signature], [[]], [[]]);
```

### Example: Sign an openPosition Operation

```typescript
const symmioInterface = new ethers.Interface([
  "function openPosition(uint256 quoteId, uint256 filledAmount, uint256 openedPrice, uint256 upnl, int256 price, bytes memory upnlSig, bytes memory priceSig)"
]);

const callData = symmioInterface.encodeFunctionData("openPosition", [
  quoteId,
  filledAmount,
  openedPrice,
  upnl,
  price,
  upnlSig,
  priceSig
]);

const { operation, signature } = await signPartyBOperation(
  hedgerSigner,
  callData
);
```

### Example: Batch Multiple Operations

```typescript
// Create multiple operations
const lockOp = await signPartyBOperation(hedgerSigner, lockQuoteCallData, 1n, 300);
const openOp = await signPartyBOperation(hedgerSigner, openPositionCallData, 2n, 300);

// Execute as batch
await instantLayer.executeBatch(
  [lockOp.operation, openOp.operation],
  [lockOp.signature, openOp.signature],
  [[], []],
  [[], []]
);
```

### Template Execution

Use `executeBatch` when every operation can be encoded independently. Use `executeTemplate` when a later operation needs a value returned by an earlier operation, such as a `quoteId` returned by a user quote operation and then consumed by PartyB `lockQuote` and `openPosition`.

The signature still covers the original `SignedOperation.callData`. For templated PartyB calls, encode placeholder 32-byte values in the positions that the template will replace. InstantLayer verifies the operation signature first, then applies flex fills, then injects template results into the calldata.

```solidity
function executeTemplate(
    uint256 templateId,
    SignedOperation[] calldata signedOps,
    bytes[] calldata signatures,
    bytes[][] calldata fills,
    bytes[][] calldata flexFillerSignatures
) external returns (bytes[] memory results);
```

The array rules are the same as `executeBatch`:

- `signedOps.length == signatures.length == fills.length == flexFillerSignatures.length`
- `signedOps.length` must also match the number of operations in the selected template
- pass `[]` for `fills[i]` and `flexFillerSignatures[i]` when the operation has no flex fields
- pass `"0x"` for a PartyB signature only when PartyB is the transaction sender for its own operation

Template injection uses three arrays per operation:

| Field | Meaning |
|-------|---------|
| `insertionPoints` | ABI argument offsets after the 4-byte function selector where a 32-byte result should be inserted |
| `sourceIndices` | Previous operation indexes whose return data should be read |
| `sourceOffsets` | 32-byte slot offsets inside the source return data |

For example, if op 1 returns a `quoteId` as its first return value, an operation with `insertionPoints: [0]`, `sourceIndices: [1]`, and `sourceOffsets: [0]` replaces its first ABI argument with that `quoteId`.

#### HyperEVM v0.8.5 Templates

The current HyperEVM v0.8.5 Instant Layer has the standard template set registered in this order:

| Template ID | Name | Operations | PartyB relevance |
|-------------|------|------------|------------------|
| `0` | `InstantOpen` | 4 | User quote flow followed by PartyB `lockQuote` and `openPosition`; the quote ID returned by the quote operation is injected into both PartyB calls. `instantOpenMode` is enabled for this template. |
| `1` | `InstantClose` | 2 | User close request followed by PartyB close fill. No result injection is configured. |
| `2` | `InstantCloseWithAllocation` | 3 | Close flow with an additional allocation/deallocation step. No result injection is configured. |

Admins can add, disable, or update template modes, so production clients should read the current state before relying on hardcoded IDs:

```typescript
const nextTemplateId = await instantLayer.getNextTemplateId();
const instantOpen = await instantLayer.getTemplate(0);
const instantOpenMode = await instantLayer.templateInstantOpenMode(0);
```

#### Example: Execute The HyperEVM InstantOpen Template

For `InstantOpen`, the PartyB operations should be signed with placeholder `quoteId` values. The template injects the quote ID returned by the quote operation before executing `lockQuote` and `openPosition`.

```typescript
const templateId = 0n; // InstantOpen on the HyperEVM v0.8.5 deployment

const lockQuoteCallData = symmioInterface.encodeFunctionData("lockQuote", [
  0n,       // quoteId placeholder; replaced by the template
  upnlSig,
]);

const openPositionCallData = symmioInterface.encodeFunctionData("openPosition", [
  0n,       // quoteId placeholder; replaced by the template
  filledAmount,
  openedPrice,
  upnlSig,
]);

const lockOp = await signPartyBOperation(hedgerSigner, lockQuoteCallData, 1n, 300);
const openOp = await signPartyBOperation(hedgerSigner, openPositionCallData, 2n, 300);

await instantLayer.executeTemplate(
  templateId,
  [userMarginOrQuoteOp, userQuoteOp, lockOp.operation, openOp.operation],
  [userMarginOrQuoteSig, userQuoteSig, lockOp.signature, openOp.signature],
  [[], [], [], []],
  [[], [], [], []]
);
```

If PartyB is submitting the transaction itself and its registered PartyB contract has `OPERATOR_ROLE`, the PartyB entries can use empty signatures:

```typescript
await instantLayer.connect(partyB).executeTemplate(
  0n,
  [userMarginOrQuoteOp, userQuoteOp, lockOp.operation, openOp.operation],
  [userMarginOrQuoteSig, userQuoteSig, "0x", "0x"],
  [[], [], [], []],
  [[], [], [], []]
);
```
## Self-Execution Mode (No Signature Required)

When PartyB is the transaction sender (`msg.sender`), signature verification is automatically skipped for operations where `signer == msg.sender`. This allows PartyB to execute operations directly without signing them.

### How It Works

1. The contract verifies that the signer is a registered PartyB
2. If `signer == msg.sender`, signature verification is bypassed
3. An empty signature (`"0x"`) can be provided for self-executed operations
4. All other security checks (replay protection, nonce, deadline) still apply

### Example: PartyB Self-Execution

```typescript
// PartyB executing their own operation - no signature needed
function createSelfOperation(callData: string): SignedOperation {
  return {
    signer: PARTY_B_ADDRESS,        // Same as msg.sender when PartyB calls
    target: SYMMIO_ADDRESS,
    callData: callData,
    signerAccount: {
      addr: PARTY_B_ADDRESS,
      isPartyB: true,
    },
    flexFields: [],
    maxUses: 1,
    replayAttackHeader: {
      nonce: 0n,
      deadline: 0n,                  // No deadline needed
      salt: generateSalt(),
    },
  };
}

// Execute directly as PartyB - empty signature
const operation = createSelfOperation(lockQuoteCallData);
await instantLayer.executeBatch([operation], ["0x"], [[]], [[]]);
```

### Example: Mixed Batch (User Signed + PartyB Self-Execution)

This is the most common pattern - combining user-signed operations with PartyB self-executed operations:

```typescript
// User's sendQuote operation - requires signature
const userOperation = {
  signer: userAddress,
  target: SYMMIO_ADDRESS,
  callData: encodedSendQuote,
  signerAccount: { addr: userAccountAddress, isPartyB: false },
  flexFields: [],
  maxUses: 1,
  replayAttackHeader: { nonce: 0n, deadline: deadline, salt: generateSalt() }
};
const userSignature = await userSigner.signTypedData(domain, types, userOperation);

// PartyB's lockQuote operation - no signature needed when PartyB is msg.sender
const partyBOperation = {
  signer: PARTY_B_ADDRESS,
  target: SYMMIO_ADDRESS,
  callData: encodedLockQuote,
  signerAccount: { addr: PARTY_B_ADDRESS, isPartyB: true },
  flexFields: [],
  maxUses: 1,
  replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};

// PartyB calls executeBatch directly
await instantLayer.executeBatch(
  [userOperation, partyBOperation],
  [userSignature, "0x"],               // User signature + empty for PartyB
  [[], []],                            // No flex fills
  [[], []]                             // No flex filler signatures
);
```

### When to Use Self-Execution

| Scenario | Signature Required? |
|----------|---------------------|
| PartyB calls directly, executing own operation | No (empty `"0x"`) |
| PartyB calls directly, executing user operation | Yes (user signature) |
| Operator calls, executing PartyB operation | Yes (PartyB signature) |
| Operator calls, executing user operation | Yes (user signature) |

## Nonce Modes

### Salt-Only Mode (nonce = 0)
- Operations can be executed in any order
- Each operation must have a unique salt
- Recommended for independent operations

### Sequential Mode (nonce > 0)
- Operations must be executed in order
- Next nonce must be `currentNonce + 1`
- Query current nonce: `instantLayer.nonces(partyBAddress)`

```typescript
// Get current nonce for your PartyB
const currentNonce = await instantLayer.nonces(PARTY_B_ADDRESS);
const nextNonce = currentNonce + 1n;
```

## PartyB Contract Setup

Your PartyB contract must:

1. **Be registered** with InstantLayer:
```solidity
// Called by InstantLayer admin
instantLayer.registerPartyBs([partyBAddress]);
```

2. **Have a signer configured** (for ERC-1271 signature verification):
```solidity
// In your PartyB contract
function setSigner(address _signer) external onlyRole(SETTER_ROLE) {
    signer = _signer;
}
```

3. **Implement ERC-1271** (already implemented in SymmioPartyB):
```solidity
function isValidSignature(bytes32 hash, bytes memory signature)
    external view returns (bytes4)
{
    return SignatureChecker.isValidSignatureNow(signer, hash, signature)
        ? bytes4(0x1626ba7e)
        : bytes4(0xffffffff);
}
```

## Validation Rules

Your operations must satisfy:

| Rule | Description |
|------|-------------|
| `signer == signerAccount.addr` | Signer must match account address |
| `signerAccount.isPartyB == true` | Must be true for PartyB operations |
| `deadline == 0 OR deadline > block.timestamp` | Valid deadline |
| `nonce == 0 OR nonce == currentNonce + 1` | Valid nonce |
| `callData.length >= 4` | Must include function selector |
| Unique salt | Salt must not have been used before |
| Valid signature OR self-execution | Signature required unless `signer == msg.sender` |

## Error Reference

| Error | Cause |
|-------|-------|
| `InstantLayerInvalidCallDataLength` | callData is less than 4 bytes |
| `InstantLayerOperationExpired` | Deadline has passed |
| `InstantLayerTargetNotWhitelisted` | Target contract not whitelisted |
| `InstantLayerInvalidOperationSignature` | Signature verification failed (skipped if `signer == msg.sender`) |
| `InstantLayerInvalidNonce` | Nonce is not sequential (when > 0) |
| `InstantLayerOperationAlreadyUsed` | Salt/operation already executed |
| `InstantLayerSignerMismatch` | Signer doesn't match signerAccount.addr |
| `InstantLayerInvalidPartyB` | PartyB is not registered |

## Quick Reference

```typescript
// Option 1: Signed operation (when executed by a third-party operator)
const operation = {
  signer: PARTY_B_ADDRESS,
  target: SYMMIO_ADDRESS,
  callData: encodedFunctionCall,
  signerAccount: { addr: PARTY_B_ADDRESS, isPartyB: true },
  flexFields: [],
  maxUses: 1,
  replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};
const signature = await signer.signTypedData(domain, types, operation);
await instantLayer.connect(operator).executeBatch(
  [operation], [signature], [[]], [[]]
);

// Option 2: Self-execution (when PartyB calls directly)
const operation = {
  signer: PARTY_B_ADDRESS,
  target: SYMMIO_ADDRESS,
  callData: encodedFunctionCall,
  signerAccount: { addr: PARTY_B_ADDRESS, isPartyB: true },
  flexFields: [],
  maxUses: 1,
  replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};
await instantLayer.connect(partyB).executeBatch(
  [operation], ["0x"], [[]], [[]]
); // Empty signature
```

---

## Related Documentation

- [InstantLayer Overview](./instant-layer-overview.md) - High-level architecture and concepts
