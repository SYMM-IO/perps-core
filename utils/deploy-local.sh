#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
HARDHAT_BIN="${PROJECT_ROOT}/node_modules/.bin/hardhat"

if [[ ! -x "${HARDHAT_BIN}" ]]; then
	printf 'ERROR: local Hardhat binary is missing. Run ./utils/pinned-yarn.sh install --frozen-lockfile first.\n' >&2
	exit 1
fi

cd "${PROJECT_ROOT}"
exec "${HARDHAT_BIN}" run scripts/Initialize.ts --network localhost
