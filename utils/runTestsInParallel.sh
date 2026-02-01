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

# Number of parallel jobs (default: 8)
JOBS=${PARALLEL_JOBS:-8}

# Run tests in parallel
node utils/parallel-test-runner.js $JOBS "$@"
