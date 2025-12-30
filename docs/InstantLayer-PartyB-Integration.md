# InstantLayer PartyB Integration Guide

This document explains how PartyB integrators can sign operations for the InstantLayer system.

## Overview

InstantLayer allows PartyB to sign operations off-chain that can be executed by anyone on-chain. This enables batched execution and delegated transaction submission.

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
  replayAttackHeader: {
    nonce: bigint;          // Sequential nonce (0 for salt-only mode)
    deadline: bigint;       // Unix timestamp expiry (0 for no deadline)
    salt: string;           // Unique 32-byte hex string
  };
}
```

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

### Types

```typescript
const types = {
  Account: [
    { name: "addr", type: "address" },
    { name: "isPartyB", type: "bool" },
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
await instantLayer.executeBatch([operation], [signature]);
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
  [lockOp.signature, openOp.signature]
);
```

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

Your signed operations must satisfy:

| Rule | Description |
|------|-------------|
| `signer == signerAccount.addr` | Signer must match account address |
| `signerAccount.isPartyB == true` | Must be true for PartyB operations |
| `deadline == 0 OR deadline > block.timestamp` | Valid deadline |
| `nonce == 0 OR nonce == currentNonce + 1` | Valid nonce |
| `callData.length >= 4` | Must include function selector |
| Unique salt | Salt must not have been used before |

## Error Reference

| Error | Cause |
|-------|-------|
| `InstantLayerInvalidCallDataLength` | callData is less than 4 bytes |
| `InstantLayerOperationExpired` | Deadline has passed |
| `InstantLayerTargetNotWhitelisted` | Target contract not whitelisted |
| `InstantLayerInvalidOperationSignature` | Signature verification failed |
| `InstantLayerInvalidNonce` | Nonce is not sequential (when > 0) |
| `InstantLayerOperationAlreadyUsed` | Salt/operation already executed |
| `InstantLayerSignerMismatch` | Signer doesn't match signerAccount.addr |
| `InstantLayerInvalidPartyB` | PartyB is not registered |

## Quick Reference

```typescript
// Minimal signing example
const operation = {
  signer: PARTY_B_ADDRESS,
  target: SYMMIO_ADDRESS,
  callData: encodedFunctionCall,
  signerAccount: { addr: PARTY_B_ADDRESS, isPartyB: true },
  replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};

const signature = await signer.signTypedData(domain, types, operation);
```
