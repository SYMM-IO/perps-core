# Better Instant actions through *Instant Layer*

To better understand the role of the **Instant Layer** within the **Symmio ecosystem**, it is useful to first review the **lifecycle of a Quote in Symmio**.

When a user wants to open a position, they send a quote on-chain. Then, **partyB**, upon seeing that quote, can lock it and open the position. The issue we encountered was that sometimes it took a few seconds for partyB to receive the contract events and be notified about the new quote.

The only way to address this problem was for the user to contact partyB directly off-chain and send the quote to them manually, enabling partyB to submit the quote to the contract on behalf of the user. To support this in previous versions, we introduced a **"delegateAccess"** feature, where the user could grant partyB permission to call a specific function (such as `sendQuote`) on their behalf.

However, this approach required the user to fully trust partyB, since partyB technically had the ability to misuse access and potentially steal the user's funds. In practice, this was not a major concern, as partyBs within Symmio are trusted entities—but if a partyB were to be hacked, users could still be exposed to significant risk.

With the introduction of the **Instant Layer**, we allow users to grant **one-time, specific allowances** to partyBs instead of broad, indefinite permissions. Essentially, a user can sign a specific call with defined parameters and provide that signature to partyB. PartyB can then prepare their own corresponding signature, and both signatures can be submitted together to the Instant Layer for batched execution.

Apart from signing a single `callData` and handing it over to Party B for execution, the user can also delegate access to a set of selectors to another signer if needed. This action can be performed either through a transaction or by signing a message (and then passing that message to someone for execution).

Yes, this delegation feature is somewhat similar to what we had in previous versions, but now it comes with a much cleaner API, and the user can complete it using only a signature.

Together, these improvements enable Symmio frontends to implement something powerful: during each user session, they can generate a key pair locally in the user's browser and, for example, rotate it daily. At the start of each session, the user grants access to the newly created address, allowing all subsequent actions and signatures to be performed by that key pair within the browser.

Compared to the old approach, the user no longer needs to trust Party B for this access delegation.

Apart from executing a batch of **Symmio** calls from their respective signatures using `executeBatch` method, we have also introduced **templates** in the instant layer. These templates come in handy when the execution of one operation depends on the output of a previous one.

A prime example of this in Symmio contracts is executing `sendQuote`, then `lockQuote`, and finally `openPosition` — all within a single transaction. In this flow, the quote ID (a parameter required by the second and third operations) is obtained from the result of the first operation or from a view call inserted after it to retrieve the latest quote ID.

To handle this, **partyB** places a placeholder value (such as `0`) in the `lockQuote` and `openPosition` calldata. The contract then automatically replaces these placeholders with the correct values during execution.

Only **admins** can create templates, while **operators** — possessing both user and partyB signatures — can select a template and pass the corresponding signatures for such workflows to the `executeTemplate` method.

## Technical Implementation Details

### Core Data Structures

### Account Structure

The Instant Layer uses an `Account` struct to represent both PartyA and PartyB accounts:

```solidity
struct Account {
    address addr;     // Trading account address (PartyA) or PartyB contract address
    bool isPartyB;    // true for PartyB, false for PartyA accounts
}
```

- For **PartyA accounts**: `isPartyB = false`, and `addr` is the trading account address (sub-account, virtual account, or a legacy MultiAccount account). Ownership is resolved through `AccountLayer.ownerOf(addr)`.
- For **PartyB accounts**: `isPartyB = true`, and `addr` is the PartyB contract address.

### Replay Attack Protection

Every operation includes a `ReplayAttackHeader` to prevent replay attacks:

```solidity
struct ReplayAttackHeader {
    uint256 nonce;      // 0 for salt-only, >0 for sequential execution
    uint256 deadline;   // Unix timestamp for expiration
    bytes32 salt;       // Unique salt for operation uniqueness
}
```

**Nonce Management Strategy:**

- **`nonce = 0` (Salt-only mode):**

    Operations can be executed in any order, as long as each uses a unique `salt`. No sequential tracking is performed.

- **`nonce > 0` (Sequential mode):**

    Operations must be executed in order. The contract enforces that the provided nonce equals the account's current nonce + 1.

**Important:**

Nonces are tracked **per `signerAccount.addr`**, meaning each trading account (PartyA or PartyB) maintains its own independent nonce counter. This allows different accounts belonging to the same user to sign and execute operations concurrently without interference.

### Signature Structures

### SignedOperation

The primary structure for batched operations:

```solidity
struct SignedOperation {
    address signer;                     // Address that created the signature
    address target;                     // Contract to call (must be whitelisted)
    bytes callData;                     // Encoded function call to execute
    Account signerAccount;              // Account context
    ReplayAttackHeader replayAttackHeader;
}
```

### Self-Execution (Signature Skip)

When the transaction sender (`msg.sender`) is the same as the operation's `signer`, **signature verification is skipped**. This optimization allows authorized parties to execute their own operations without needing to sign them.

**How It Works:**

1. The contract first verifies authorization:
   - For **PartyB**: Checks that the signer is a registered PartyB
   - For **PartyA**: Checks that the signer is the account owner or has a valid delegation

2. If `signer == msg.sender`, the signature check is bypassed because `msg.sender` already proves identity at the EVM level.

3. An empty signature (`"0x"` or `[]`) can be provided for self-executed operations.

**Use Cases:**

- **PartyB Direct Execution**: A PartyB operator can call `executeBatch` directly, including their own operations without signatures while still providing signatures for user operations.
- **Account Owner Execution**: An account owner can execute their own operations directly without signing.
- **Delegated Signer Execution**: A delegated signer with proper permissions can execute operations directly.

**Example:**

```javascript
// PartyB executing their own operation - no signature needed
const partyBOperation = {
    signer: partyBAddress,  // Same as msg.sender
    target: symmioCoreAddress,
    callData: encodedLockQuote,
    signerAccount: { addr: partyBAddress, isPartyB: true },
    replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};

// User operation still needs a signature
const userOperation = {
    signer: userAddress,
    target: symmioCoreAddress,
    callData: encodedSendQuote,
    signerAccount: { addr: userAccountAddress, isPartyB: false },
    replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};

// PartyB (as msg.sender) calls executeBatch
await instantLayer.executeBatch(
    [userOperation, partyBOperation],
    [userSignature, "0x"]  // Empty signature for PartyB's own operation
);
```

**Security Note:**

Authorization is still fully enforced before the signature skip:
- PartyB must be registered with InstantLayer
- PartyA signers must be account owners or have valid delegations
- Replay attack protection (salts, nonces, hashes) still applies

### Target and Whitelisting

- If `target` is the Symmio core, the call is routed through `AccountLayer._call(...)` so the core sees the correct trading account via `setSigner`.
- If `target` is not Symmio, the Instant Layer calls `target` directly. Only whitelisted targets can be called.
- For external targets, `msg.sender` is the Instant Layer contract (the signature is what authorizes the call).
- Return data from external targets will be dropped.

**What Users Should Sign:**

1. The user creates a hash of their operation using EIP-712 standard
2. The hash includes:
    - Their address as `signer`
    - The exact `target` and `callData` they want to execute
    - Their account information
    - Replay protection parameters

**Example User Signature Creation (JavaScript):**

```jsx
const domain = {
    name: "SymmioInstantLayer",
    version: "1",
    chainId: chainId,
    verifyingContract: instantLayerAddress
};

const types = {
    SignedOperation: [
        { name: "signer", type: "address" },
        { name: "target", type: "address" },
        { name: "callData", type: "bytes" },
        { name: "signerAccount", type: "Account" },
        { name: "replayAttackHeader", type: "ReplayAttackHeader" }
    ],
    Account: [
        { name: "addr", type: "address" },
        { name: "isPartyB", type: "bool" }
    ],
    ReplayAttackHeader: [
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "salt", type: "bytes32" }
    ]
};

const userOperation = {
    signer: userAddress,
    target: symmioCoreAddress,      // or a whitelisted external target
    callData: encodedSendQuote,     // e.g., symmio.sendQuote(...) encoded
    signerAccount: {
        addr: userAccountAddress,   // sub-account / virtual-account / legacy account
        isPartyB: false
    },
    replayAttackHeader: {
        nonce: 0,  // or current nonce + 1 for sequential
        deadline: Math.floor(Date.now() / 1000) + 3600,  // 1 hour expiry
        salt: ethers.utils.randomBytes(32)
    }
};

const signature = await signer._signTypedData(domain, types, userOperation);
```

### Method Specifications

### executeBatch

Executes multiple operations from different signers in a single transaction.

```solidity
function executeBatch(
    SignedOperation[] calldata signedOps,
    bytes[] calldata signatures
) external nonReentrant onlyRole(OPERATOR_ROLE);
```

**Signature Requirements:**
- Each operation requires a corresponding entry in the `signatures` array
- If `signedOps[i].signer == msg.sender`, then `signatures[i]` can be empty (`"0x"`)
- Otherwise, a valid EIP-712 signature is required

### executeTemplate

Executes a predefined template with dynamic parameter replacement.

```solidity
function executeTemplate(
    uint256 templateId,
    SignedOperation[] calldata signedOps,
    bytes[] calldata signatures
) external nonReentrant onlyRole(OPERATOR_ROLE);
```

**Template Structure:**

```solidity
struct Template {
    string name;
    Operation[] operations;
    bool active;
}

struct Operation {
    uint256[] insertionPoints;
    uint256[] sourceIndices;
}
```

**Placeholder Replacement System:**
Templates support automatic value replacement using placeholders:

- Placeholders are 32-byte zero values in the callData (only 32 byte values are now supported)
- The contract replaces them with actual values from previous operation results
- Common pattern: `sendQuote` returns quoteId → `lockQuote` uses that quoteId

### Delegation System

### DelegationInfo Structure

```solidity
struct DelegationInfo {
    Account account;
    address delegatedSigner;
    bytes4[] selectors;
    uint256 expiryTimestamp;
}
```

### Creating Delegations

**Option 1: Via Transaction**

```solidity
function grantDelegation(DelegationInfo calldata info);
```

**Option 2: Via Signature (Gasless)**

```solidity
struct SignedDelegation {
    DelegationInfo delegationInfo;
    ReplayAttackHeader replayAttackHeader;
}

function grantBatchDelegationBySig(SignedDelegation calldata signedDelegation, bytes calldata signature);
```

**EIP-712 Encoding Note:**

When signing a `DelegationInfo` struct, the `bytes4[] selectors` field is encoded using a custom array hashing method. Each selector is right-padded to 32 bytes, all padded values are concatenated, and the entire concatenation is hashed once.

Formally:

```solidity
keccak256(abi.encodePacked(bytes32(selector1), bytes32(selector2), ...))
```

This is the same behavior implemented in `_hashBytes4Array` inside the contract, ensuring consistent EIP-712 signature verification.

### Security Mechanisms

### 1. Replay Protection

- **Salt mechanism**: Each operation must have a unique salt
- **Nonce mechanism**: Optional sequential execution enforcement
- **Deadline enforcement**: Operations expire after specified timestamp
- **Hash tracking**: Used operation hashes are permanently recorded

### 2. Contract Registration and Whitelists

- PartyB contracts must be registered via `registerPartyBs(...)`.
- The `AccountLayer` address must be set via `setAccountLayer(...)` (and the Instant Layer must have `INSTANT_LAYER_ROLE` on the AccountLayer to call `AccountLayer._call`).
- `target` contracts must be whitelisted via `setTargetWhitelist(...)` (Symmio is whitelisted by default).

### 3. Self-Execution Security

When `signer == msg.sender`, signature verification is skipped, but all other security checks remain:
- Authorization validation (PartyB registration or account ownership/delegation)
- Replay attack protection via hash tracking
- Nonce enforcement for sequential operations
- Deadline validation

### 4. Delegation Revoke System

For delegations, a time-delayed revocation system is implemented:

- Revocations are initiated via `initiateRevokeDelegation()`
- They become active after `revocationCooldown` seconds
- Finally, `finalizeRevokeDelegation()` permanently removes the delegation

---

## Related Documentation

For practical integration examples, see:
- [InstantLayer PartyB Integration Guide](./InstantLayer-PartyB-Integration.md) - Detailed code examples for PartyB integrators
