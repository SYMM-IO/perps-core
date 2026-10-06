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
    FlexField[] flexFields;             // Modifiable regions in calldata (empty for standard ops)
    uint256 maxUses;                    // Max execution count (1=single-use, 0=unlimited)
    ReplayAttackHeader replayAttackHeader;
}
```

For standard operations, `flexFields` is empty and `maxUses` is `1`. See the [Flex Fields](#flex-fields) section for details on partial calldata modification.

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
    flexFields: [],
    maxUses: 1,
    replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};

// User operation still needs a signature
const userOperation = {
    signer: userAddress,
    target: symmioCoreAddress,
    callData: encodedSendQuote,
    signerAccount: { addr: userAccountAddress, isPartyB: false },
    flexFields: [],
    maxUses: 1,
    replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};

// PartyB (as msg.sender) calls executeBatch
await instantLayer.executeBatch(
    [userOperation, partyBOperation],
    [userSignature, "0x"],       // Empty signature for PartyB's own operation
    [{ values: [] }, { values: [] }],  // No flex fills
    [[], []]                     // No flex filler signatures
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
        { name: "flexFields", type: "FlexField[]" },
        { name: "maxUses", type: "uint256" },
        { name: "replayAttackHeader", type: "ReplayAttackHeader" }
    ],
    Account: [
        { name: "addr", type: "address" },
        { name: "isPartyB", type: "bool" }
    ],
    FlexField: [
        { name: "offset", type: "uint256" },
        { name: "length", type: "uint256" },
        { name: "authorizedFlexFiller", type: "address" }
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
    flexFields: [],                 // empty for standard operations
    maxUses: 1,                     // single-use
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
    bytes[] calldata signatures,
    FlexFill[] calldata fills,
    bytes[][] calldata flexFillerSignatures
) external nonReentrant onlyRole(OPERATOR_ROLE);
```

**Parameters:**
- `signedOps` / `signatures` -- operations and their EIP-712 signatures (as before)
- `fills` -- one `FlexFill` per operation. For standard operations (no flex fields), pass `{ values: [] }`
- `flexFillerSignatures` -- one `bytes[]` per operation, with one signature per flex field. Pass `[]` for standard operations or `"0x"` for fields where the flex filler is `msg.sender`

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
    bytes[] calldata signatures,
    FlexFill[] calldata fills,
    bytes[][] calldata flexFillerSignatures
) external nonReentrant onlyRole(OPERATOR_ROLE);
```

The `fills` and `flexFillerSignatures` parameters work the same as in `executeBatch`. When a template step has both flex fields and result injection, flex fills are applied first, then template result injection overwrites.

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

## Flex Fields

Flex fields allow a user to sign an operation while designating specific byte ranges of the calldata as **modifiable** by authorized parties. This enables use cases like:

- A **TPSL service** modifying the `amount` or `closePrice` parameter in a close request
- A **solver** updating the Muon signature in a `sendQuote` before execution
- A **service** choosing the exact parameters at execution time while the user constrains which function is called and which parameters are fixed

### How It Works

The user signs a `SignedOperation` where certain calldata regions are marked as flex fields. Each flex field specifies a byte offset, length, and an `authorizedFlexFiller` address -- the party allowed to fill in that region. The user's EIP-712 signature covers the calldata as-is (the placeholder values in flex regions don't matter) plus the flex field definitions, so the user explicitly commits to **which** parts are modifiable and **who** can modify them.

At execution time, the operator provides `FlexFill` values for each flex field. The contract verifies flex filler authorization and injects the fill values before executing the call.

### Data Structures

```solidity
struct FlexField {
    uint256 offset;              // Byte offset after 4-byte selector
    uint256 length;              // Bytes to replace (typically 32)
    address authorizedFlexFiller;  // Who can provide the fill value
}

struct FlexFill {
    bytes[] values;  // One entry per FlexField, each must match field.length
}
```

### Flex Filler Authorization

Each flex field has its own `authorizedFlexFiller`. Different fields can have different flex fillers, allowing multiple parties to control different parameters of the same operation.

**When flex filler == msg.sender:** No additional signature is needed. Pass `"0x"` as the flex filler signature for that field.

**When flex filler != msg.sender:** The flex filler must sign a `FlexFillAuth` message authorizing the specific fill value:

```solidity
// What the flex filler signs (EIP-712)
struct FlexFillAuth {
    bytes32 opHash;       // Hash of the SignedOperation
    uint256 fieldIndex;   // Which flex field this fill is for
    bytes value;          // The actual fill value
}
```

The flex filler's signature authorizes a specific value for a specific field of a specific operation. For multi-use operations, the same signature can be reused across executions (since the value and operation are the same). The `maxUses` cap and `deadline` provide the usage controls.

### Multi-Use Operations

All operations use the `maxUses` field uniformly for replay protection:

- `maxUses = 1` -- single-use (default for standard operations)
- `maxUses = N` (N > 1) -- can be executed up to N times
- `maxUses = 0` -- unlimited executions until deadline expires

Once signed, an operation is valid until its `maxUses` count is reached or the `deadline` passes. There is no cancellation mechanism -- if you signed it, the flex filler can use it within the agreed bounds. This ensures trust: a flex filler (e.g., a solver) can rely on the authorization without risk of it being pulled out from under them.

### Example: TPSL Service with Flex Fields

Instead of delegating the entire `requestToClosePosition` selector to a TPSL bot, the user can sign a specific close operation with the amount as a flex field:

The `requestToClosePosition` signature is:
```solidity
function requestToClosePosition(
    uint256 quoteId,            // offset 0
    uint256 closePrice,         // offset 32
    uint256 quantityToClose,    // offset 64
    OrderType orderType,        // offset 96
    uint256 deadline            // offset 128
)
```

All parameters are static, so the ABI encoding is straightforward -- each is a 32-byte slot at a fixed offset.

```javascript
// User signs: "close quote 42, but let the TPSL bot choose the amount"
const closeCallData = symmio.interface.encodeFunctionData(
    "requestToClosePosition",
    [42, triggerPrice, 0, 1, deadline]  // quantityToClose=0 is a placeholder
);

const operation = {
    signer: userAddress,
    target: symmioCoreAddress,
    callData: closeCallData,
    signerAccount: { addr: userAccount, isPartyB: false },
    flexFields: [{
        offset: 64,              // quantityToClose is the 3rd param = 2 * 32
        length: 32,
        authorizedFlexFiller: tpslBotAddress
    }],
    maxUses: 0,                  // unlimited until deadline
    replayAttackHeader: {
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400), // 24h
        salt: generateSalt()
    }
};

const userSig = await userSigner.signTypedData(domain, types, operation);
```

When the TP/SL threshold is hit, the bot provides the fill value and its flex filler signature:

```javascript
// Bot determines the close amount
const closeAmount = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256"], [quantityToClose]
);

// Bot signs the fill authorization
const opHash = await instantLayer.getOperationHash(operation);

const fillAuthSig = await botSigner.signTypedData(domain, {
    FlexFillAuth: [
        { name: "opHash", type: "bytes32" },
        { name: "fieldIndex", type: "uint256" },
        { name: "value", type: "bytes" },
    ]
}, { opHash, fieldIndex: 0, value: closeAmount });

// Operator submits
await instantLayer.executeBatch(
    [operation],
    [userSig],
    [{ values: [closeAmount] }],
    [[fillAuthSig]]
);
```

### Example: Solver Updating Muon Signature in sendQuote

The `sendQuoteWithAffiliate` signature is:
```solidity
function sendQuoteWithAffiliate(
    address[] memory partyBsWhiteList,      // offset 0   (dynamic -- offset pointer)
    uint256 symbolId,                       // offset 32
    PositionType positionType,              // offset 64
    OrderType orderType,                    // offset 96
    uint256 price,                          // offset 128
    uint256 quantity,                       // offset 160
    uint256 cva,                            // offset 192
    uint256 lf,                             // offset 224
    uint256 partyAmm,                       // offset 256
    uint256 partyBmm,                       // offset 288
    uint256 maxFundingRate,                 // offset 320
    uint256 deadline,                       // offset 352
    address affiliate,                      // offset 384
    SingleUpnlAndPriceSig memory upnlSig    // offset 416 (dynamic -- offset pointer)
)
```

The `upnlSig` is a dynamic struct (contains `bytes` fields), so offset 416 holds an **offset pointer** to the struct's actual data in the ABI tail. The struct's exact byte position and length depend on the preceding dynamic parameters (e.g., `partyBsWhiteList` array length).

For flex fields on dynamic parameters, the integrator must calculate the exact byte range of the encoded struct data in the specific calldata being signed. Since both the user and solver see the full calldata, this is straightforward to compute off-chain:

```javascript
// Encode the full sendQuote calldata with a placeholder Muon sig
const callData = partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
    partyBsWhiteList, symbolId, positionType, orderType,
    price, quantity, cva, lf, partyAmm, partyBmm,
    maxFundingRate, deadline, affiliate, placeholderUpnlSig
]);

// Calculate where the upnlSig data actually starts in the encoded calldata.
// The offset pointer at byte 416 (after selector) contains the start position.
// Read it from the encoded calldata:
const upnlSigOffsetPointer = 416;
const upnlSigDataStart = Number(
    ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256"],
        "0x" + callData.slice(2 + 8 + upnlSigOffsetPointer * 2, 2 + 8 + (upnlSigOffsetPointer + 32) * 2)
    )[0]
);
const upnlSigDataLength = callData.length / 2 - 4 - upnlSigDataStart; // rest of calldata

const operation = {
    signer: userAddress,
    target: symmioCoreAddress,
    callData: callData,
    signerAccount: { addr: userAccount, isPartyB: false },
    flexFields: [{
        offset: upnlSigDataStart,
        length: upnlSigDataLength,
        authorizedFlexFiller: solverAddress
    }],
    maxUses: 1,
    replayAttackHeader: { nonce: 0n, deadline: 0n, salt: generateSalt() }
};
```

The solver encodes a fresh Muon signature with the **same byte length** and provides it as the fill value. All other quote parameters remain exactly as the user signed them.

> **Important:** The replacement value must have the exact same byte length as the original. For `SingleUpnlAndPriceSig`, this means the fresh Muon sig must produce the same ABI-encoded length (same `reqId` and `gatewaySignature` byte lengths).

---

## Related Documentation

For practical integration examples, see:
- [InstantLayer PartyB Integration Guide](./InstantLayer-PartyB-Integration.md) -- Detailed code examples for PartyB integrators
- [InstantLayer Service Integration Guide](./instant-layer-service-integration.md) -- TPSL, Trigger Market, and Session Key integration
