#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
HARDHAT_BIN="${PROJECT_ROOT}/node_modules/.bin/hardhat"
RUN_LOG="${LOCAL_NODE_TEST_LOG:-${PROJECT_ROOT}/output.log}"
NODE_LOG="${LOCAL_NODE_LOG:-${PROJECT_ROOT}/hardhatNode.log}"
RPC_URL="${LOCAL_NODE_RPC_URL:-http://127.0.0.1:8545}"
RPC_READY_TIMEOUT_SECONDS="${LOCAL_NODE_READY_TIMEOUT_SECONDS:-30}"

node_pid=""

timestamp() {
	date -u "+%Y-%m-%dT%H:%M:%SZ"
}

log() {
	printf '[%s] %s\n' "$(timestamp)" "$*"
}

fail() {
	printf '[%s] ERROR: %s\n' "$(timestamp)" "$*" >&2
	exit 1
}

cleanup() {
	if [[ -n "${node_pid}" ]] && kill -0 "${node_pid}" 2>/dev/null; then
		log "Stopping Hardhat node (pid ${node_pid})"
		kill "${node_pid}" 2>/dev/null || true
		wait "${node_pid}" 2>/dev/null || true
	fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

rpc_chain_id() {
	curl --silent --show-error --max-time 2 \
		--header 'content-type: application/json' \
		--data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
		"${RPC_URL}"
}

wait_for_node() {
	local attempt response
	for ((attempt = 1; attempt <= RPC_READY_TIMEOUT_SECONDS; attempt++)); do
		if ! kill -0 "${node_pid}" 2>/dev/null; then
			printf '\nHardhat node exited before becoming ready. Last log lines:\n' >&2
			tail -n 40 "${NODE_LOG}" >&2 || true
			return 1
		fi

		response="$(rpc_chain_id 2>/dev/null || true)"
		if [[ "${response}" == *'"result":"0x7a69"'* ]]; then
			return 0
		fi

		sleep 1
	done

	printf '\nHardhat node did not report chain ID 31337 within %s seconds. Last log lines:\n' "${RPC_READY_TIMEOUT_SECONDS}" >&2
	tail -n 40 "${NODE_LOG}" >&2 || true
	return 1
}

cd "${PROJECT_ROOT}"

[[ -x "${HARDHAT_BIN}" ]] || fail "Local Hardhat binary is missing. Run './utils/pinned-yarn.sh install --frozen-lockfile' first."
command -v curl >/dev/null 2>&1 || fail "curl is required for the JSON-RPC readiness check."
[[ "${RPC_READY_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]] || fail "LOCAL_NODE_READY_TIMEOUT_SECONDS must be a positive whole number."

if rpc_chain_id >/dev/null 2>&1; then
	fail "${RPC_URL} already has a JSON-RPC service. Stop it explicitly; this script never kills unowned processes."
fi

: >"${RUN_LOG}"
: >"${NODE_LOG}"

log "Starting local Hardhat node; node log: ${NODE_LOG}"
"${HARDHAT_BIN}" node >"${NODE_LOG}" 2>&1 &
node_pid=$!
wait_for_node || fail "Local Hardhat node readiness check failed."
log "Hardhat node is ready on chain ID 31337 (pid ${node_pid})"

log "Initializing the local protocol"
"${HARDHAT_BIN}" run scripts/Initialize.ts --network localhost 2>&1 | tee -a "${RUN_LOG}"

test_command=("${HARDHAT_BIN}" test mocha --network localhost --no-compile)
if (($# > 0)); then
	test_command+=(-- "$@")
fi

log "Running tests against the initialized local node"
"${test_command[@]}" 2>&1 | tee -a "${RUN_LOG}"
log "Local-node tests completed successfully; combined log: ${RUN_LOG}"
