#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Run supabase/schema.sql against a throwaway Postgres, twice.
#
#   tools/portal/schema-check.sh
#
# The studio has one database and no staging copy, so the only way to find out
# whether a schema change parses, applies, and applies *again* used to be to run
# it on production. This does it locally instead: a temporary cluster, the
# Supabase pieces stubbed out (tools/portal/supabase-stub.sql), then the real
# file twice in a row.
#
# The second run is the one that matters. Every statement in schema.sql is meant
# to be idempotent — that is the promise at the top of the file — and the way
# that promise breaks is a new `create table` or `insert` added without the
# guard its neighbours have. A green second run is what proves it.
#
# Exits non-zero on the first error. Needs postgresql-16 on the box; skips with
# a message rather than failing when there is none, so it can sit in front of
# the test suite without becoming a dependency for people who only touch CSS.
# ---------------------------------------------------------------------------
set -uo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
# Short on purpose: a Unix socket path is capped at 107 bytes and a temp dir
# under a session id blows straight past it.
BASE=${BASE:-/var/tmp/wo-schema-check}
PORT=${PORT:-55432}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

if [ ! -x "$PGBIN/initdb" ]; then
  echo "No Postgres at $PGBIN — skipping the schema check."
  echo "Install postgresql-16, or set PGBIN, to run it."
  exit 0
fi

# initdb refuses to run as root, which is exactly the case in a container.
AS_USER=""
if [ "$(id -u)" = "0" ]; then
  AS_USER="postgres"
  id "$AS_USER" >/dev/null 2>&1 || { echo "Running as root with no postgres user."; exit 1; }
fi

run() { if [ -n "$AS_USER" ]; then su "$AS_USER" -c "$1"; else bash -c "$1"; fi; }

cleanup() {
  run "$PGBIN/pg_ctl -D $BASE/data -m immediate stop" >/dev/null 2>&1
  rm -rf "$BASE"
}
trap cleanup EXIT

rm -rf "$BASE"
mkdir -p "$BASE/data" "$BASE/run"
[ -n "$AS_USER" ] && chown -R "$AS_USER" "$BASE"

run "$PGBIN/initdb -D $BASE/data -U postgres --auth=trust" >/dev/null 2>&1 \
  || { echo "initdb failed"; exit 1; }
run "$PGBIN/pg_ctl -D $BASE/data -o '-k $BASE/run -p $PORT -c listen_addresses=' -l $BASE/data/log start" >/dev/null 2>&1 \
  || { echo "Postgres would not start"; cat "$BASE/data/log"; exit 1; }

# pg_ctl returns before the socket is always ready on a slow box.
for _ in $(seq 1 20); do
  psql -h "$BASE/run" -p "$PORT" -U postgres -tAc "select 1" >/dev/null 2>&1 && break
  sleep 0.5
done

psql -h "$BASE/run" -p "$PORT" -U postgres -tAc "create database wo" >/dev/null || exit 1

PSQL="psql -h $BASE/run -p $PORT -U postgres -d wo -v ON_ERROR_STOP=1 -q"

$PSQL -f "$ROOT/tools/portal/supabase-stub.sql" || { echo "The Supabase stub failed."; exit 1; }

for pass in 1 2; do
  # ON_ERROR_STOP plus the exit code is the verdict. The output is only read to
  # show what went wrong, because a clean run is extremely noisy: every
  # `exception when duplicate_object` and every `drop ... if exists` raises a
  # NOTICE, and on the second pass almost all of them do.
  out=$($PSQL -f "$ROOT/supabase/schema.sql" 2>&1)
  if [ $? -ne 0 ]; then
    echo "schema.sql: pass $pass FAILED"
    echo "$out" | grep -Ei 'error|fatal' | head -20
    exit 1
  fi
  echo "schema.sql: pass $pass clean"
  echo "$out" | grep -Ei '^WARNING|^psql.*WARNING' | head -10
done

if [ -f "$ROOT/tools/portal/schema-check.sql" ]; then
  $PSQL -f "$ROOT/tools/portal/schema-check.sql" || { echo "Behaviour checks FAILED"; exit 1; }
fi

echo "Schema OK — applies twice, and the rules hold."
