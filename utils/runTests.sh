#!/bin/bash

set -e

# Change to project root directory
cd "$(dirname "$(readlink -f -- "$0")")/.."

# Source .env file if it exists
set -a
if [ -f .env ]; then
    source .env
fi
set +a

# Activate Python venv if configured
if [ -n "${PYTHON_VENV}" ]; then
    if [ -f "${PYTHON_VENV}/bin/activate" ]; then
        source "${PYTHON_VENV}/bin/activate"
    fi
fi

export PYTHONPATH=.

# Parse arguments for --coverage and --sequential flags
COVERAGE=false
SEQUENTIAL=false
ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--coverage" ]; then
        COVERAGE=true
    elif [ "$arg" = "--sequential" ]; then
        SEQUENTIAL=true
    else
        ARGS+=("$arg")
    fi
done

python3 utils/update_sig_checks.py 1

# Number of parallel jobs
JOBS=${PARALLEL_JOBS:-8}

# Build the test command
if [ "$SEQUENTIAL" = true ]; then
    # Run original sequential tests via Main.ts
    if [ "$COVERAGE" = true ]; then
        npx hardhat test mocha --coverage "${ARGS[@]}" -- test/Main.ts || true
    else
        npx hardhat test mocha "${ARGS[@]}" -- test/Main.ts || true
    fi
else
    # Run parallel tests
    if [ "$COVERAGE" = true ]; then
        # Coverage doesn't support parallel well, run sequentially
        npx hardhat test mocha --coverage "${ARGS[@]}" -- test/parallel/*.test.ts || true
    else
        # Run parallel tests with formatted output
        node utils/parallel-test-runner.js $JOBS "${ARGS[@]}" || true
    fi
fi

python3 utils/update_sig_checks.py 0