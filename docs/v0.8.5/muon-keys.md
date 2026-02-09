# Muon Signature Verification and Key Management

SYMMIO relies on the Muon oracle network to provide off-chain data that is verified on-chain: unrealized PnL, asset prices, liquidation parameters, and settlement values. Every state-changing operation that depends on external market data passes through the Muon signature verification layer. This document covers the external `MuonSignatureVerifier` contract, how it replaced the original single-key storage fields, and the Schnorr-based verification flow that underpins every critical protocol operation.

## Why This Exists

In the original design, SYMMIO stored a single Muon public key and a single valid gateway address directly in `MuonStorage` inside the diamond. This had three problems:

1. **Single point of failure.** If the sole Muon TSS key was compromised, every signature check in the protocol was compromised. There was no way to have redundant keys.

2. **Key rotation required contract changes.** Rotating the Muon public key or gateway signer meant calling `setMuonConfig` on the diamond, coordinating the cutover, and accepting a window where either the old or new key could be invalid.

3. **No decentralized signer set.** The Muon network itself uses threshold signature schemes (TSS) where the signing committee can change over time. A single on-chain key cannot represent a rotating committee.

The `MuonSignatureVerifier` contract solves all three by externalizing key management into a standalone contract that supports multiple public keys and multiple gateway signers, with independent add/remove operations.

## Architecture Overview

```
                  +------------------+
                  |   ControlFacet   |
                  |                  |
                  | setSignature-    |
                  | VerifierAddress()|---+
                  +------------------+   |
                                         v
+-------------+    +-----------+    +---------------------------+
|  LibMuon    |--->| GlobalApp |    | MuonSignatureVerifier     |
|  verify-    |    | Storage   |    | (external contract)       |
|  TSSAnd-    |    |           |    |                           |
|  Gateway()  |    | .signature|--->| verify(hash, sign, gwSig) |
|             |    |  Verifier |    | addPublicKey(key)         |
+------+------+    +-----------+    | removePublicKey(key)      |
       ^                           | addGatewaySigner(addr)    |
       |                           | removeGatewaySigner(addr) |
       |                           +---------------------------+
       |                                       |
  Called from:                                  v
  - LibMuonAccount                    +---------------------+
  - LibMuonPartyA                     | LibMuonV04ClientBase|
  - LibMuonPartyB                     | (Schnorr verify)    |
  - LibMuonLiquidation                +---------------------+
  - LibMuonSettlement
  - LibMuonUnifiedSettlement
  - LibMuonForceActions
  - LibMuonFundingRate
  - LibMuonPartyBBatchActions
```

## The IMuonSignatureVerifier Interface

The interface defines two categories of operations -- signature verification and key management -- plus two data structures:

```solidity
// contracts/core/interfaces/IMuonSignatureVerifier.sol

interface IMuonSignatureVerifier {
    struct PublicKey {
        uint256 x;
        uint8 parity;
    }

    struct SchnorrSign {
        uint256 signature;
        address owner;
        address nonce;
    }

    // === Signature Verification ===
    function verify(bytes32 hash, SchnorrSign memory sign, bytes calldata gatewaySignature) external view;

    // === Public Key Management ===
    function addPublicKey(PublicKey memory pubKey) external;
    function removePublicKey(PublicKey memory pubKey) external;
    function getAllPublicKeys() external view returns (PublicKey[] memory);

    // === Gateway Signer Management ===
    function addGatewaySigner(address signer) external;
    function removeGatewaySigner(address signer) external;
    function getAllGatewaySigners() external view returns (address[] memory);
}
```

**PublicKey** represents a compressed secp256k1 public key. The `x` coordinate must be less than `HALF_Q` (half the group order), a constraint imposed by the Schnorr verification's use of `ecrecover`. The `parity` byte (0 or 1) indicates whether the y coordinate is even or odd.

**SchnorrSign** carries the Schnorr signature components: the `signature` scalar (called `s` in the math), the `owner` field (unused in verification but part of the Muon protocol envelope), and the `nonce` field which is the Ethereum address derived from the nonce point `k*G`.

## The MuonSignatureVerifier Contract

The concrete implementation lives at `contracts/helpers/verification/SymmioSignatureVerifier.sol` and is deployed as an independent contract (not part of the diamond). It uses OpenZeppelin's `AccessControlEnumerable` for role-based access:

```solidity
// contracts/helpers/verification/SymmioSignatureVerifier.sol

contract MuonSignatureVerifier is IMuonSignatureVerifier, AccessControlEnumerable {
    using ECDSA for bytes32;

    bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

    PublicKey[] public publicKeys;
    address[] public gatewaySigners;

    constructor(address _admin) {
        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
        _setupRole(SETTER_ROLE, _admin);
    }

    // ...
}
```

### Verification Logic

The `verify` function performs two independent checks. Both must pass or the call reverts:

```solidity
function verify(bytes32 hash, SchnorrSign memory sign, bytes memory gatewaySignature) external view {
    // 1. Verify TSS (Threshold Signature Scheme) via Schnorr
    bool verifiedTSS = false;
    for (uint256 i = 0; i < publicKeys.length; i++) {
        if (LibMuonV04ClientBase.muonVerify(uint256(hash), sign, publicKeys[i])) {
            verifiedTSS = true;
            break;
        }
    }
    require(verifiedTSS, "MuonSignatureVerifier: TSS not verified");

    // 2. Verify Gateway Signature (ECDSA)
    address signer = hash.toEthSignedMessageHash().recover(gatewaySignature);
    bool gatewayVerified = false;
    for (uint256 i = 0; i < gatewaySigners.length; i++) {
        if (signer == gatewaySigners[i]) {
            gatewayVerified = true;
            break;
        }
    }
    require(gatewayVerified, "MuonSignatureVerifier: Gateway is not valid");
}
```

**TSS check**: iterates over all registered public keys and attempts Schnorr verification against each one. If any key validates the signature, the check passes. This is what enables key rotation -- the old key and new key can coexist during a transition period.

**Gateway check**: recovers the ECDSA signer from a standard Ethereum signed message and checks it against the registered gateway signers list. The gateway is the Muon network node that relayed the TSS-signed data to the user. This second signature prevents a compromised TSS key from being exploited without also compromising a gateway node.

### Key Management Functions

All management functions require `SETTER_ROLE`:

```solidity
function addPublicKey(PublicKey memory pubKey) external onlyRole(SETTER_ROLE) {
    publicKeys.push(pubKey);
    emit PublicKeyAdded(pubKey.x, pubKey.parity);
}

function removePublicKey(PublicKey memory pubKey) external onlyRole(SETTER_ROLE) {
    for (uint256 i = 0; i < publicKeys.length; i++) {
        if (publicKeys[i].x == pubKey.x && publicKeys[i].parity == pubKey.parity) {
            publicKeys[i] = publicKeys[publicKeys.length - 1];
            publicKeys.pop();
            break;
        }
    }
    emit PublicKeyRemoved(pubKey.x, pubKey.parity);
}
```

Removal uses the swap-and-pop pattern for gas efficiency. The same pattern applies to `addGatewaySigner` / `removeGatewaySigner`.

Key rotation procedure:
1. Call `addPublicKey` with the new TSS committee's public key.
2. Both old and new keys now validate signatures -- no downtime.
3. Once all Muon nodes have switched to the new key, call `removePublicKey` on the old key.
4. Same process applies independently for gateway signers.

## How It Integrates with the Core

### Registration

The diamond stores the verifier contract address in `GlobalAppStorage.signatureVerifier`. It is set by the admin via `ControlFacet`:

```solidity
// contracts/core/facets/Control/ControlFacet.sol

function setSignatureVerifierAddress(address signatureVerifier)
    external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE)
{
    GlobalAppStorage.layout().signatureVerifier = signatureVerifier;
    emit SetSignatureVerifierAddress(signatureVerifier);
}
```

This requires `DEFAULT_ADMIN_ROLE` -- the highest privilege level in the protocol.

### The Central Verification Funnel

Every Muon signature in the protocol flows through a single function in `LibMuon`:

```solidity
// contracts/core/libraries/muon/LibMuon.sol

function verifyTSSAndGateway(
    bytes32 hash,
    IMuonSignatureVerifier.SchnorrSign memory sign,
    bytes memory gatewaySignature
) internal view {
    IMuonSignatureVerifier(GlobalAppStorage.layout().signatureVerifier)
        .verify(hash, sign, gatewaySignature);
}
```

This is the single chokepoint. Every domain-specific Muon library calls this function after constructing the appropriate hash from the signature payload:

| Library | What It Verifies | Called By |
|---------|-----------------|-----------|
| `LibMuon` | PartyB UPNL (single) | Deallocate, funding rate, liquidation |
| `LibMuonAccount` | PartyA UPNL, PartyA UPNL + pending balance | Allocate, deallocate |
| `LibMuonPartyA` | PartyA UPNL + price | Open position, close position |
| `LibMuonPartyB` | Pair UPNL + prices | Open position, fill close |
| `LibMuonLiquidation` | Liquidation sig, deferred liquidation sig, quote prices | All liquidation flows |
| `LibMuonSettlement` | Settlement data | UPNL settlement |
| `LibMuonUnifiedSettlement` | Unified settlement data | Cross partyB settlement |
| `LibMuonForceActions` | High/low price sig | Force close |
| `LibMuonFundingRate` | Funding rate sig | Charge funding rate |
| `LibMuonPartyBBatchActions` | Pair UPNL + prices | Batch open/close |

### Signature Structs

Every Muon signature type in the protocol carries a `SchnorrSign sigs` field and a `bytes gatewaySignature` field. These are defined in `MuonStorage.sol`. There are 12 distinct signature struct types:

- `SingleUpnlSig` -- single party UPNL
- `SingleUpnlWithPendingBalanceSig` -- UPNL plus pending balance
- `SingleUpnlAndPriceSig` -- UPNL plus a price
- `PairUpnlSig` -- two-party UPNL (partyA + partyB)
- `PairUpnlAndPriceSig` -- pair UPNL plus one price
- `PairUpnlAndPricesSig` -- pair UPNL plus multiple prices
- `LiquidationSig` -- liquidation parameters
- `DeferredLiquidationSig` -- deferred liquidation with block context
- `QuotePriceSig` -- prices for specific quotes
- `HighLowPriceSig` -- high/low/average price window for force close
- `SettlementSig` -- UPNL settlement data
- `UnifiedSettlementSig` -- cross partyB unified settlement

All 12 flow through the same `verifyTSSAndGateway` -> `MuonSignatureVerifier.verify` path.

## The Schnorr Signature Verification Flow

The cryptographic core lives in `LibMuonV04ClientBase`. It implements a modified Schnorr signature scheme over secp256k1, using `ecrecover` as a gas-efficient shortcut for elliptic curve multiplication.

### Mathematical Background

Standard Schnorr verification checks: `s*G + e*PK == R`, where:
- `s` is the signature scalar
- `G` is the secp256k1 generator
- `e` is the challenge hash `H(PKx || PKyp || msgHash || R_address)`
- `PK` is the public key
- `R = k*G` is the nonce point (only its Ethereum address is transmitted)

The implementation uses `ecrecover` to perform `e*PK + s*G` in a single precompile call, then checks that the resulting address matches the transmitted nonce address:

```solidity
// contracts/helpers/verification/LibMuonV04ClientBase.sol

function verifySignature(
    uint256 signingPubKeyX,
    uint8 pubKeyYParity,
    uint256 signature,
    uint256 msgHash,
    address nonceTimesGeneratorAddress
) public pure returns (bool) {
    require(signingPubKeyX < HALF_Q, "Public-key x >= HALF_Q");
    require(signature < Q, "signature must be reduced modulo Q");
    require(
        nonceTimesGeneratorAddress != address(0) &&
        signingPubKeyX > 0 && signature > 0 && msgHash > 0,
        "no zero inputs allowed"
    );

    uint256 msgChallenge = uint256(keccak256(abi.encodePacked(
        signingPubKeyX, pubKeyYParity, msgHash, nonceTimesGeneratorAddress
    )));

    // ecrecover trick: recovers address of e*PK + s*G
    address recoveredAddress = ecrecover(
        bytes32(Q - mulmod(signingPubKeyX, signature, Q)),
        (pubKeyYParity == 0) ? 27 : 28,
        bytes32(signingPubKeyX),
        bytes32(mulmod(msgChallenge, signingPubKeyX, Q))
    );
    return nonceTimesGeneratorAddress == recoveredAddress;
}
```

The `ecrecover` precompile is being repurposed here. Normally it recovers an ECDSA signer, but by carefully choosing the inputs (`-s*r` as the hash, `r` as the public key x, `e*r` as the s-value), the precompile computes `(1/r) * (e*r*PK - (-s*r)*G) = e*PK + s*G`, which is exactly the Schnorr verification equation. This costs only 3000 gas (the `ecrecover` precompile cost) versus the tens of thousands that explicit EC arithmetic would require.

### Security Constraints

**`HALF_Q` constraint**: The public key's x coordinate must be less than half the group order. This is because `ecrecover` rejects `s` values above `HALF_Q` (an ECDSA malleability defense from EIP-2). Since the public key x is placed in `ecrecover`'s `s` parameter position, this constraint transfers to the public key.

**Non-zero inputs**: All inputs must be non-zero to prevent trivial forgeries. If `nonceTimesGeneratorAddress` were `address(0)`, an attacker could construct a valid-looking signature because `ecrecover` returns `address(0)` for invalid inputs.

**Modular reduction**: The signature scalar must be less than `Q` (the group order) to prevent signature malleability from multiple representations of the same element in the quotient group.

### The Wrapper

`LibMuonV04ClientBase.muonVerify` bridges the `IMuonSignatureVerifier` types to the raw verification function:

```solidity
function muonVerify(
    uint256 hash,
    IMuonSignatureVerifier.SchnorrSign memory signature,
    IMuonSignatureVerifier.PublicKey memory pubKey
) internal pure returns (bool) {
    if (!verifySignature(pubKey.x, pubKey.parity, signature.signature, hash, signature.nonce)) {
        return false;
    }
    return true;
}
```

## Migration from Single-Key Storage

The original `MuonStorage.Layout` had two fields for signature verification:

```solidity
// contracts/core/storages/MuonStorage.sol (deprecated fields)

/// @notice DEPRECATED - Public key now managed by external signatureVerifier
IMuonSignatureVerifier.PublicKey muonPublicKey;

/// @notice DEPRECATED - Gateway validation now handled by external signatureVerifier
address validGateway;
```

These fields are kept in the storage layout for slot compatibility (removing them would shift all subsequent storage slots and corrupt on-chain state), but they are no longer read by any verification logic. The original `verifyTSSAndGateway` used to read these directly:

```solidity
// OLD (removed):
// bool verified = LibMuonV04ClientBase.muonVerify(hash, sign, muonLayout.muonPublicKey);
// require(verified, "LibMuon: TSS not verified");
// address gatewayRecovered = hash.toEthSignedMessageHash().recover(gatewaySignature);
// require(gatewayRecovered == muonLayout.validGateway, "LibMuon: Gateway is not valid");

// NEW:
IMuonSignatureVerifier(GlobalAppStorage.layout().signatureVerifier)
    .verify(hash, sign, gatewaySignature);
```

The migration path:
1. Deploy `MuonSignatureVerifier` with the admin address.
2. Call `addPublicKey` with the existing Muon TSS public key.
3. Call `addGatewaySigner` with the existing gateway address.
4. Call `ControlFacet.setSignatureVerifierAddress` pointing to the new contract.
5. From this point, all verification is delegated to the external contract.

## The Mock for Testing

Because generating real Muon Schnorr signatures in a test environment is impractical, a `MockMuonSignatureVerifier` exists at `contracts/core/test/MockMuonSignatureVerifier.sol`. Its `verify` function is an intentional no-op:

```solidity
// contracts/core/test/MockMuonSignatureVerifier.sol

contract MockMuonSignatureVerifier is IMuonSignatureVerifier {
    /// @notice Accepts any signature without verification
    function verify(bytes32, SchnorrSign memory, bytes calldata) external pure override {
        // Intentionally empty - accepts all signatures for testing
    }
    // ... key management stubs
}
```

This contract must never be deployed in production. The test suite sets `signatureVerifier` to this mock address so that all Muon-dependent operations can run without real oracle signatures.

## Security Considerations

**This is the most security-critical subsystem in the protocol.** Every financial operation that depends on external data -- opening positions, closing positions, deallocating funds, liquidations, settlements, force closes, funding rate charges -- passes through `verifyTSSAndGateway`. A compromise here means an attacker can fabricate arbitrary UPNL values, trigger false liquidations, or prevent legitimate ones.

**Dual-signature requirement.** Both the TSS Schnorr signature AND the gateway ECDSA signature must validate. Compromising one is not sufficient -- an attacker needs to compromise both the Muon TSS committee and a registered gateway node.

**Key management access control.** Adding or removing public keys and gateway signers requires `SETTER_ROLE` on the verifier contract. Setting the verifier address itself requires `DEFAULT_ADMIN_ROLE` on the diamond. These are separate access control domains with separate admin hierarchies.

**No key count enforcement.** The contract does not enforce a minimum number of public keys or gateway signers. Removing all keys would cause every signature check to fail (the `for` loop would never set `verified = true`), effectively bricking all Muon-dependent operations. Removing all gateway signers has the same effect. Operators must ensure at least one valid key and one valid gateway signer exist at all times.

**Array iteration gas cost.** Verification iterates over all registered keys/signers linearly. With a very large number of registered keys, the gas cost of `verify` increases. In practice, the number of active keys is expected to be small (2--4 during rotation windows, 1 in steady state).

## Files Involved

| File | Role |
|------|------|
| `contracts/core/interfaces/IMuonSignatureVerifier.sol` | Interface for the verifier contract |
| `contracts/helpers/verification/SymmioSignatureVerifier.sol` | Production implementation (`MuonSignatureVerifier` contract) |
| `contracts/helpers/verification/LibMuonV04ClientBase.sol` | Schnorr signature verification library |
| `contracts/core/storages/MuonStorage.sol` | Signature struct definitions, deprecated key fields |
| `contracts/core/storages/GlobalAppStorage.sol` | Stores `signatureVerifier` address |
| `contracts/core/libraries/muon/LibMuon.sol` | Central `verifyTSSAndGateway` funnel |
| `contracts/core/libraries/muon/LibMuonAccount.sol` | PartyA UPNL verification |
| `contracts/core/libraries/muon/LibMuonPartyA.sol` | PartyA UPNL + price verification |
| `contracts/core/libraries/muon/LibMuonPartyB.sol` | Pair UPNL + prices verification |
| `contracts/core/libraries/muon/LibMuonLiquidation.sol` | Liquidation signature verification |
| `contracts/core/libraries/muon/LibMuonSettlement.sol` | Settlement signature verification |
| `contracts/core/libraries/muon/LibMuonUnifiedSettlement.sol` | Cross partyB settlement verification |
| `contracts/core/libraries/muon/LibMuonForceActions.sol` | Force close price verification |
| `contracts/core/libraries/muon/LibMuonFundingRate.sol` | Funding rate signature verification |
| `contracts/core/libraries/muon/LibMuonPartyBBatchActions.sol` | Batch action signature verification |
| `contracts/core/facets/Control/ControlFacet.sol` | `setSignatureVerifierAddress` admin function |
| `contracts/core/facets/ViewFacet/ViewFacet.sol` | `getSignatureVerifier` read function, `verifyMuonTSSAndGateway` helper |
| `contracts/core/test/MockMuonSignatureVerifier.sol` | Test mock (no-op verification) |
