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

# Parse arguments for --coverage flag
COVERAGE=false
ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--coverage" ]; then
        COVERAGE=true
    else
        ARGS+=("$arg")
    fi
done

python3 utils/update_sig_checks.py 1

if [ "$COVERAGE" = true ]; then
    npx hardhat test mocha --coverage "${ARGS[@]}" || true
else
    npx hardhat test mocha "${ARGS[@]}" || true
fi

python3 utils/update_sig_checks.py 0