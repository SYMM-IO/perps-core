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

# Note: Muon signature verification is now handled via MockMuonSignatureVerifier
# deployed in test initialization, no source code modification needed.

# Build the test command
if [ "$SEQUENTIAL" = true ]; then
    if [ "$COVERAGE" = true ]; then
        npx hardhat test mocha --coverage "${ARGS[@]}" -- test/Main.ts || true
    else
        npx hardhat test mocha "${ARGS[@]}" -- test/Main.ts || true
    fi
elif [ "$COVERAGE" = true ]; then
    npx hardhat test mocha --coverage "${ARGS[@]}" -- test/parallel/*.test.ts || true
else
    # Parallel mode
    node utils/parallel-test-runner.js $JOBS "${ARGS[@]}" || true
fi