#!/usr/bin/env bash
# Run every post-deployment verification gate and return a failing status if any gate fails.
# Usage: NETWORK=base RPC_URL=https://... bash scripts/upgrade/verify-all.sh
set -uo pipefail

NETWORK="${NETWORK:?Set NETWORK env var (for example NETWORK=base)}"
RPC_URL="${RPC_URL:?Set RPC_URL env var for bytecode verification}"
if [[ ! "${NETWORK}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
	echo "NETWORK must contain only lowercase letters, digits, and hyphens" >&2
	exit 2
fi
HARDHAT_BIN="./node_modules/.bin/hardhat"
if [[ ! -x "${HARDHAT_BIN}" ]]; then
	echo "Missing ${HARDHAT_BIN}; run ./utils/pinned-yarn.sh install --frozen-lockfile first" >&2
	exit 2
fi

# Bind every gate to exactly the same endpoint. This override deliberately wins over
# RPC_<NETWORK> and keystore RPC values inside hardhat.config.ts for this harness only.
SYMMIO_RPC_URL_OVERRIDE="${RPC_URL}"
export NETWORK RPC_URL SYMMIO_RPC_URL_OVERRIDE

RPC_FINGERPRINT="$(node -e 'const c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(process.argv[1]).digest("hex").slice(0,16))' "${RPC_URL}")"
if ! RPC_CHAIN_ID="$(node --input-type=module -e '
const response = await fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const body = await response.json();
if (body.error || !/^0x[0-9a-f]+$/i.test(body.result ?? "")) throw new Error(body.error?.message ?? "invalid eth_chainId response");
process.stdout.write(BigInt(body.result).toString());
' "${RPC_URL}")"; then
	echo "Failed to read eth_chainId from the bound RPC endpoint" >&2
	exit 2
fi
echo "Bound RPC: chainId ${RPC_CHAIN_ID}, endpoint fingerprint ${RPC_FINGERPRINT}"

trap 'echo; echo "Verification interrupted." >&2; exit 130' INT TERM

declare -a GATE_NAMES=()
declare -a GATE_RESULTS=()
OVERALL_STATUS=0

run_gate() {
	local name="$1"
	shift

	echo
	echo "================================================================================"
	echo "GATE: ${name}"
	echo "================================================================================"

	GATE_NAMES+=("${name}")
	if "$@"; then
		GATE_RESULTS+=("PASS")
	else
		local status=$?
		GATE_RESULTS+=("FAIL (exit ${status})")
		OVERALL_STATUS=1
	fi
}

run_gate "Core facet bytecode" \
	node --import tsx scripts/upgrade/verifyCoreBytecode.ts
run_gate "Peripheral bytecode" \
	node --import tsx scripts/upgrade/verifyPeripheralBytecode.ts
run_gate "Core diamond selectors" \
	"${HARDHAT_BIN}" run scripts/upgrade/verifyDiamondSelectors.ts --network "${NETWORK}"
run_gate "Peripheral wiring and state" \
	"${HARDHAT_BIN}" run scripts/upgrade/verifyPeripheralWiring.ts --network "${NETWORK}"
run_gate "Block-explorer source publication" \
	"${HARDHAT_BIN}" run scripts/upgrade/verifyBlockExplorer.ts --network "${NETWORK}"

echo
echo "================================================================================"
echo "POST-DEPLOYMENT VERIFICATION SUMMARY"
echo "================================================================================"
for index in "${!GATE_NAMES[@]}"; do
	printf "%-38s %s\n" "${GATE_NAMES[$index]}" "${GATE_RESULTS[$index]}"
done

if (( OVERALL_STATUS != 0 )); then
	echo
	echo "One or more deployment gates failed. Do not treat this deployment as complete."
else
	echo
	echo "All deployment gates passed."
fi

exit "${OVERALL_STATUS}"
