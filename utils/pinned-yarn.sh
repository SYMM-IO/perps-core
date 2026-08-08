#!/usr/bin/env bash
#
# Runs the package manager this checkout is pinned to, refusing anything else.
#
#   ./utils/pinned-yarn.sh install --immutable
#   ./utils/pinned-yarn.sh run check:operations
#
# Why this exists: a `yarnPath` setting in a parent directory's .yarnrc.yml — or a stray
# global Yarn Classic earlier on PATH — silently resolves `yarn` to a different release
# before this repository's own configuration is ever read. A different release can resolve
# a different dependency tree, so you would install packages nobody reviewed, using tooling
# that signs mainnet transactions. Failing loudly is the only safe outcome.
#
# For the operator CLI use ./symmio, which skips the package-manager hop entirely.

set -euo pipefail

EXPECTED_YARN_VERSION="4.13.0"
YARN_BIN="$(command -v yarn || true)"

if [[ -z "$YARN_BIN" ]]; then
	echo "Yarn $EXPECTED_YARN_VERSION is required but no yarn executable was found." >&2
	echo "Enable Corepack or install the package manager pinned in package.json." >&2
	exit 1
fi

ACTUAL_YARN_VERSION="$("$YARN_BIN" --version)"
if [[ "$ACTUAL_YARN_VERSION" != "$EXPECTED_YARN_VERSION" ]]; then
	echo "This checkout requires Yarn $EXPECTED_YARN_VERSION; resolved $ACTUAL_YARN_VERSION at $YARN_BIN." >&2
	echo "Enable the packageManager pin with Corepack, then rerun this wrapper." >&2
	exit 1
fi

exec "$YARN_BIN" "$@"
