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

# Number of parallel jobs
JOBS=${PARALLEL_JOBS:-8}

# Build the test command
if [ "$SEQUENTIAL" = true ]; then
    # Sequential mode: handle Muon signatures manually
    python3 utils/update_sig_checks.py 1
    if [ "$COVERAGE" = true ]; then
        npx hardhat test mocha --coverage "${ARGS[@]}" -- test/Main.ts || true
    else
        npx hardhat test mocha "${ARGS[@]}" -- test/Main.ts || true
    fi
    python3 utils/update_sig_checks.py 0
elif [ "$COVERAGE" = true ]; then
    # Coverage mode: handle Muon signatures manually
    python3 utils/update_sig_checks.py 1
    npx hardhat test mocha --coverage "${ARGS[@]}" -- test/parallel/*.test.ts || true
    python3 utils/update_sig_checks.py 0
else
    # Parallel mode: the runner handles Muon signatures internally
    node utils/parallel-test-runner.js $JOBS "${ARGS[@]}" || true
fi