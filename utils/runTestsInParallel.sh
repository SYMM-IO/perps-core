#!/usr/bin/env bash

set -euo pipefail

# Resolve the project root portably on macOS and Linux. Hardhat loads the
# project's environment itself; do not shell-source .env here.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "${SCRIPT_DIR}/.."

# Number of parallel jobs (default: 8)
JOBS="${PARALLEL_JOBS:-8}"
if [[ ! "${JOBS}" =~ ^[0-9]+$ ]] || (( JOBS < 1 || JOBS > 64 )); then
	echo "PARALLEL_JOBS must be an integer between 1 and 64; received '${JOBS}'" >&2
	exit 2
fi

# Run tests in parallel
exec node utils/parallel-test-runner.js "${JOBS}" "$@"
