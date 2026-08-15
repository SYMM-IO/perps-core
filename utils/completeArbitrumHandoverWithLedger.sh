#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
HARDHAT_BIN="${PROJECT_ROOT}/node_modules/.bin/hardhat"
CAST_BIN="$(command -v cast || true)"

fail() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage:
  ./utils/completeArbitrumHandoverWithLedger.sh <expected-ledger-address>
  ./utils/completeArbitrumHandoverWithLedger.sh <expected-ledger-address> --check

The RPC endpoint is resolved from the encrypted Hardhat RPC_ARBITRUM keystore entry and is
never printed. Execute mode discovers the expected address across standard Ledger Ethereum
derivation paths, verifies the match against the connected device, and caches the matched path.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi
[[ $# -ge 1 && $# -le 2 ]] || {
	usage >&2
	fail "Expected a Ledger address and one optional --check argument."
}

EXPECTED_LEDGER_ADDRESS="$1"
MODE="execute"
case "${2:-}" in
	"") ;;
	--check) MODE="check" ;;
	*)
		usage >&2
		fail "Unknown argument: $2"
		;;
esac
[[ -x "${HARDHAT_BIN}" ]] || fail "Local Hardhat binary is missing. Install repository dependencies first."
[[ -n "${CAST_BIN}" && -x "${CAST_BIN}" ]] || fail "Foundry cast is required for Ledger signing. Install Foundry first."

cd "${PROJECT_ROOT}"
export CAST_BIN EXPECTED_LEDGER_ADDRESS HANDOVER_MODE="${MODE}"
unset RPC_ARBITRUM
exec "${HARDHAT_BIN}" \
	--config scripts/completeArbitrumHandoverWithLedger.config.ts \
	--network arbitrum \
	run --no-compile scripts/completeArbitrumHandoverWithLedger.ts
