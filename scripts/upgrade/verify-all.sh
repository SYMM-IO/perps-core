#!/usr/bin/env bash
# Verify all deployed contracts on block explorer.
# Usage: NETWORK=base bash scripts/upgrade/verify-all.sh
set -euo pipefail

NETWORK="${NETWORK:?Set NETWORK env var (e.g. NETWORK=base)}"

# Core Diamond address (for InstantLayer constructor arg)
DIAMOND="0x2Ecc7da3Cc98d341F987C85c3D9FC198570838B5"
PROTOCOL_ADMIN="0x0C83Ff10E8255Df41e71006eE6523A23024AAFC4"

# ============================================================================
# Core Libraries
# ============================================================================
echo "=== Core Libraries ==="

npx hardhat verify --network "$NETWORK" 0x2777D873709B926E3Dc7C429B1357006CBfb5820 || true  # LibQuoteFunding
npx hardhat verify --network "$NETWORK" 0xC3D31e27c0194832425AC45565CFa66350F23427 || true  # LibQuoteClose
npx hardhat verify --network "$NETWORK" 0x564D8Ff4539b6122f92f035Db1aB4C91fc65d473 || true  # LibForceActions
npx hardhat verify --network "$NETWORK" 0x1957dA55aaAE7C2e272eA631aE5A784c6415f875 || true  # LibSettlement

# ============================================================================
# Core Facets — no library deps
# ============================================================================
echo "=== Core Facets (no library deps) ==="

npx hardhat verify --network "$NETWORK" 0x7b8960Ad908b1835BBa983b5ff448eB67e6e5e40 || true  # AccountFacet
npx hardhat verify --network "$NETWORK" 0x3D1Fc1D171a5cE1F2BCB08b5bdAA7AEC9B1a2699 || true  # PartyBAccountFacet
npx hardhat verify --network "$NETWORK" 0x223F0EF212C86b3dcA3E8e6F9e85dE7e3BCd3646 || true  # ExternalTransferFacet
npx hardhat verify --network "$NETWORK" 0x3Bd42e2630563b44B11028eE632Efb7F4D749A21 || true  # BindingFacet
npx hardhat verify --network "$NETWORK" 0x87b01DC732a580e7C17fE94e7c73d4C84968FfD5 || true  # PledgeFacet
npx hardhat verify --network "$NETWORK" 0x091653f201137bAF4465E7C6DC10a074b3278743 || true  # MigrationFacet
npx hardhat verify --network "$NETWORK" --contract contracts/core/facets/Control/ControlFacet.sol:ControlFacet 0xF41cc9825Ce5794A04b0B2D59ec6c81b4B370D71 || true  # ControlFacet
npx hardhat verify --network "$NETWORK" 0x50bBf599cC65d6415B862eC32CF85c8883215b79 || true  # SymbolControlFacet
npx hardhat verify --network "$NETWORK" 0x2dc07E7980Df21f558532BA31A96F6E1F9E565B6 || true  # PauseControlFacet
npx hardhat verify --network "$NETWORK" 0x88ac7EF3ece192d10F3C0fB7154EEDFd022edd47 || true  # DiamondLoupeFacet
npx hardhat verify --network "$NETWORK" 0x825ae1fd2F3C1e292fC3E7450933333c3979b8a0 || true  # PartyBLiquidationFacet
npx hardhat verify --network "$NETWORK" 0xFF32d3836771117FF4a57766733e80BA98C9F765 || true  # BridgeFacet
npx hardhat verify --network "$NETWORK" --contract contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet 0x1CEafe781354A12D98598304adc74738de7CdB03 || true  # ViewFacet
npx hardhat verify --network "$NETWORK" 0x75eB02798cb154C658Ec4826956f0499a9Fe7A2b || true  # ViewFacetSymbol
npx hardhat verify --network "$NETWORK" 0x309CF3053AFb409a5DA6891F7bA99C13c18967fA || true  # ViewFacetAggregate

# ============================================================================
# Core Facets — with library deps
# ============================================================================
echo "=== Core Facets (with library deps) ==="

# PartyAFacet: LibQuoteClose
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose:0xC3D31e27c0194832425AC45565CFa66350F23427 \
  0xEfc2bcF707098126F049B2B7B32EbAEa2dcBAa03 || true  # PartyAFacet

# PartyALiquidationFacet: LibQuoteFunding
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding:0x2777D873709B926E3Dc7C429B1357006CBfb5820 \
  0xe31De5EC3048bcD8829cc3E86889eE597Aff4C5d || true  # PartyALiquidationFacet

# ViewFacetQuote: LibQuoteFunding
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding:0x2777D873709B926E3Dc7C429B1357006CBfb5820 \
  0xFC7549B3eafbCB5c83bdf4a61318F15F7429C234 || true  # ViewFacetQuote

# FundingRateFacet: LibQuoteFunding
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding:0x2777D873709B926E3Dc7C429B1357006CBfb5820 \
  0xd3deCabD4610F4A7B20f31fe1F71FFd9616F5F53 || true  # FundingRateFacet

# ClearingHouseFacet: LibQuoteFunding
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding:0x2777D873709B926E3Dc7C429B1357006CBfb5820 \
  0x6c12a69cc5fF6943d749e14a03F66e437ebbCf93 || true  # ClearingHouseFacet

# ForceActionsFacet: LibForceActions, LibSettlement
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibForceActions.sol:LibForceActions:0x564D8Ff4539b6122f92f035Db1aB4C91fc65d473 \
  --libraries project/contracts/core/libraries/LibSettlement.sol:LibSettlement:0x1957dA55aaAE7C2e272eA631aE5A784c6415f875 \
  0xA6Af35fA6ff29af01cE52380e5c8b832bCe612E8 || true  # ForceActionsFacet

# ForceCloseStepsFacet: LibForceActions, LibSettlement
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibForceActions.sol:LibForceActions:0x564D8Ff4539b6122f92f035Db1aB4C91fc65d473 \
  --libraries project/contracts/core/libraries/LibSettlement.sol:LibSettlement:0x1957dA55aaAE7C2e272eA631aE5A784c6415f875 \
  0xcEace496FC4555bDAEc40e9d0676d17CdD1975E9 || true  # ForceCloseStepsFacet

# SettlementFacet: LibSettlement
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibSettlement.sol:LibSettlement:0x1957dA55aaAE7C2e272eA631aE5A784c6415f875 \
  0x64382f4589507605677Cc6259C68e49dBf6C1764 || true  # SettlementFacet

# PartyBPositionActionsFacet: LibQuoteClose, LibQuoteFunding
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose:0xC3D31e27c0194832425AC45565CFa66350F23427 \
  --libraries project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding:0x2777D873709B926E3Dc7C429B1357006CBfb5820 \
  0x4A27f75d9fb972F339478bbfB4a5A9a1ec634932 || true  # PartyBPositionActionsFacet

# PartyBQuoteActionsFacet: LibQuoteClose
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose:0xC3D31e27c0194832425AC45565CFa66350F23427 \
  0x93F4687E4F70A371B4d87b4Ec3EFC6E89C43E820 || true  # PartyBQuoteActionsFacet

# PartyBBatchActionsFacet: LibQuoteClose, LibQuoteFunding
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose:0xC3D31e27c0194832425AC45565CFa66350F23427 \
  --libraries project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding:0x2777D873709B926E3Dc7C429B1357006CBfb5820 \
  0xc7f8C76ffdb4c2dF4D273E4ECD0C12A7857dCa29 || true  # PartyBBatchActionsFacet

# PartyBEmergencyActionsFacet: LibQuoteClose
npx hardhat verify --network "$NETWORK" \
  --libraries project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose:0xC3D31e27c0194832425AC45565CFa66350F23427 \
  0xf69157fa10dA830207A4605E58C348A502065e50 || true  # PartyBEmergencyActionsFacet

# WithdrawFacet: no library deps
npx hardhat verify --network "$NETWORK" 0x6108a93aCD552ba20B2E4fC08790d4BF2E99DB64 || true  # WithdrawFacet

# ============================================================================
# AccountLayer Peripherals
# ============================================================================
echo "=== AccountLayer ==="

# DiamondCutFacet (no constructor args)
npx hardhat verify --network "$NETWORK" 0x6Fd57CF18B8Ae4D1339544b58147196CBC86E247 || true  # AL DiamondCutFacet

# Diamond proxy (constructor: owner, diamondCutFacet)
npx hardhat verify --network "$NETWORK" 0x5B610d26363850cCfd09f2654e31b143f85dCaaB \
  "$PROTOCOL_ADMIN" 0x6Fd57CF18B8Ae4D1339544b58147196CBC86E247 || true  # AL Diamond

# Init (no constructor args)
npx hardhat verify --network "$NETWORK" --contract contracts/accountLayer/Init.sol:Init \
  0xc7E2871A1e21FF46659bDcEb7fba2758f62eAE29 || true  # AL Init

# LibQuoteParams (no constructor args)
npx hardhat verify --network "$NETWORK" --contract contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams \
  0x98A05CF858Ca0bCcd0737aBbDf673edD3CBDe123 || true  # AL LibQuoteParams

# CoreFacet: LibQuoteParams
npx hardhat verify --network "$NETWORK" \
  --contract contracts/accountLayer/facets/Core/CoreFacet.sol:CoreFacet \
  --libraries project/contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams:0x98A05CF858Ca0bCcd0737aBbDf673edD3CBDe123 \
  0x9Be564D8AaA34fa8DeaA85A1deeB51877BBfb37E || true  # AL CoreFacet

# MarginFacet (no library deps)
npx hardhat verify --network "$NETWORK" \
  --contract contracts/accountLayer/facets/Margin/MarginFacet.sol:MarginFacet \
  0xfA4092AEACb4F5408444D276E6261460CCC482A3 || true  # AL MarginFacet

# SymmioHookFacet (no library deps)
npx hardhat verify --network "$NETWORK" \
  --contract contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet \
  0xFAb29958342BcFB32EEf76E4AECdfE17441e17bC || true  # AL SymmioHookFacet

# ControlFacet (no library deps)
npx hardhat verify --network "$NETWORK" \
  --contract contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet \
  0xe51fB907d74D0B116d44580811041BB6B6EEaB9f || true  # AL ControlFacet

# ViewFacet (no library deps)
npx hardhat verify --network "$NETWORK" \
  --contract contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet \
  0x3071CD42b4766CA00b70B2635549986F6B676Edc || true  # AL ViewFacet

# AffiliateFacet (no library deps)
npx hardhat verify --network "$NETWORK" \
  --contract contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet \
  0x396f3Ebc46205B0C2446a191Dd0F56c51A2AFF93 || true  # AL AffiliateFacet

# DiamondLoupeFacet (shared, likely already verified above)
npx hardhat verify --network "$NETWORK" 0x4545b2C75C4592A2c97194fB122D252cc27A9563 || true  # AL DiamondLoupeFacet

# ============================================================================
# InstantLayer
# ============================================================================
echo "=== InstantLayer ==="

# InstantLayer (constructor: symmio, admin)
npx hardhat verify --network "$NETWORK" 0xfca231f639A6D4220944BCB60F80e5f7F855f61c \
  "$DIAMOND" "$PROTOCOL_ADMIN" || true  # InstantLayer

# ============================================================================
# SymmioPartyB Implementation
# ============================================================================
echo "=== SymmioPartyB ==="

# SymmioPartyB (no constructor args — UUPS impl with disabled initializers)
npx hardhat verify --network "$NETWORK" 0xBC6840EfA4622602aA49EB39D710A20d403dA1e0 || true  # SymmioPartyB

echo "=== Done ==="
