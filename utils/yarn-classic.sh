#!/usr/bin/env bash

set -euo pipefail

EXPECTED_YARN_VERSION="1.22.22"
YARN_BIN="$(command -v yarn || true)"

if [[ -z "$YARN_BIN" ]]; then
	echo "Yarn $EXPECTED_YARN_VERSION is required but no yarn executable was found." >&2
	echo "Enable Corepack or install the package manager pinned in package.json." >&2
	exit 1
fi

# Ignore user/parent yarn-path settings. They can otherwise redirect this v1-lockfile
# project into Yarn Berry before the repository's own configuration is even read.
ACTUAL_YARN_VERSION="$(YARN_IGNORE_PATH=1 "$YARN_BIN" --version)"
if [[ "$ACTUAL_YARN_VERSION" != "$EXPECTED_YARN_VERSION" ]]; then
	echo "This checkout requires Yarn $EXPECTED_YARN_VERSION; resolved $ACTUAL_YARN_VERSION at $YARN_BIN." >&2
	echo "Enable the packageManager pin with Corepack, then rerun this wrapper." >&2
	exit 1
fi

export YARN_IGNORE_PATH=1
exec "$YARN_BIN" "$@"
