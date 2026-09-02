#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Parse every portal module.
#
#   tools/portal/syntax-check.sh
#
# The portal ships as plain ES modules with no build step, which is the whole
# reason it deploys by pushing to main — and also the reason a stray bracket
# reaches production as a blank screen rather than as a failed build. The unit
# tests only import the handful of files with no browser in them; this parses
# all of them.
#
# `node --check` reads a .js file as CommonJS and rejects `import`, so each file
# is linked to a .mjs name first. Checking is parse-only: nothing is executed,
# so a module that calls bootstrap() at the top level is still safe to check.
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail=0
count=0

while IFS= read -r file; do
  count=$((count + 1))
  name=$(basename "$file" .js)
  cp "$file" "$WORK/$name.mjs"
  if ! out=$(node --check "$WORK/$name.mjs" 2>&1); then
    echo "SYNTAX ERROR in ${file#"$ROOT"/}"
    echo "$out" | head -5
    fail=1
  fi
done < <(find "$ROOT/js/portal" -name '*.js' | sort)

if [ "$fail" -eq 0 ]; then
  echo "All $count portal modules parse."
else
  exit 1
fi
