#!/usr/bin/env bash
# Verify deployed upgrade contracts from the canonical deployment output files.
# Usage: NETWORK=base bash scripts/upgrade/verify-all.sh
set -euo pipefail

NETWORK="${NETWORK:?Set NETWORK env var (e.g. NETWORK=base)}"

exec npx hardhat run scripts/upgrade/verifyContracts.ts --network "$NETWORK"
