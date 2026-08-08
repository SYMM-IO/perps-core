#!/usr/bin/env bash
#
# Deprecated alias, kept so in-flight scripts, runbooks and shell history keep working.
#
#   ./symmio <command>                  for the operator CLI (was: yarn-classic.sh cli ...)
#   ./utils/pinned-yarn.sh <args>       for package-manager operations
#
# The old name described the implementation (it once ran Yarn Classic) rather than the
# guarantee (the pinned, verified toolchain), and read like an optional shim rather than the
# safety gate it is. The checkout now pins Yarn 4; the name is kept only for compatibility.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "cli" ]]; then
	shift
	echo "yarn-classic.sh is deprecated; use ./symmio $* instead." >&2
	exec "$SCRIPT_DIR/../symmio" "$@"
fi

echo "yarn-classic.sh is deprecated; use ./utils/pinned-yarn.sh instead." >&2
exec "$SCRIPT_DIR/pinned-yarn.sh" "$@"
