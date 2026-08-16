#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
HARDHAT_BIN="${PROJECT_ROOT}/node_modules/.bin/hardhat"

fail() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

[[ -x "${HARDHAT_BIN}" ]] || fail "Local Hardhat binary is missing. Install the repository dependencies first."

cd "${PROJECT_ROOT}"

# The isolated config resolves only RPC_ARBITRUM from the encrypted Hardhat keystore.
# It does not load .env, deployment tasks, signer keys, or the repository's build artifacts.
unset RPC_ARBITRUM
exec "${HARDHAT_BIN}" --config scripts/checkArbitrumRpc.config.ts --network arbitrum run --no-compile scripts/checkArbitrumRpc.ts
