#!/usr/bin/env bash
#
# SQL regression suite for
#   supabase/migrations/20261105000000_categories_access_and_supplier_order_number.sql
#
# For each of three schema shapes it creates a throwaway database named
# medinv_test_<shape>_<pid>_<epoch> on a LOCAL PostgreSQL server, loads the
# shape, seeds synthetic data, runs the migration with assertions before and
# after, and drops the database again (also on failure and on Ctrl-C):
#
#   live         the deployed Health Center shape: uuid ids, row level security
#                (RLS) enabled on categories with NO policy, no supplier column
#   repo_legacy  bigint ids, provisioned from the PREVIOUS schema.sql + rls.sql
#                (no supplier column, no categories policies): the upgrade path
#   repo_fresh   bigint ids, provisioned from the CURRENT schema.sql then rls.sql
#
# Around the three shapes it also runs:
#   - static checks on the text of the migration, rls.sql and the two blocks the
#     migration header documents (<rollback-sql>, <precheck-sql>);
#   - scenarios that need a database of their own: a second session holding a
#     lock (the migration must give up within seconds and leave nothing behind),
#     a supplier_order_number column that already exists with another type (the
#     migration must stop and change nothing), and anon privileges the migration
#     does not grant (the documented read-only pre-check must see them).
# supabase/tests/selftest.sh proves this suite can fail: it feeds it deliberately
# broken copies of the migration and runs it from a path that contains spaces.
#
# Usage       bash supabase/tests/run.sh
# Settings    TEST_PGHOST   (default 127.0.0.1)   must be a local address: a numeric
#                                                 loopback address (127.x.y.z), localhost, ::1,
#                                                 or the directory of a unix socket (a path that
#                                                 starts with /). A DNS name that merely starts
#                                                 with "127." (127.attacker.example) is refused.
#             TEST_PGPORT   (default 54329)
#             TEST_PGUSER   (default postgres)    must be a superuser; a password,
#                                                 if needed, comes from PGPASSWORD
#             TEST_QUIET=1  print failures and the summary only
#             TEST_REQUIRE_DB=1  a run that cannot happen (no psql, no local server, a
#                           server that is too old) is a failure, not a skip: it prints
#                           the usual SKIPPED lines, then exits 2 instead of 0. Use it
#                           where "the SQL tests passed" must be true (CI, a release
#                           check); without it a machine that has no PostgreSQL skips
#                           the suite quietly. Default: off.
#             TEST_MIGRATION_FILE=<path>  test another file instead of the real
#                           migration (selftest.sh uses it to confirm the suite
#                           can fail)
# Needs       psql, and a PostgreSQL 13+ server. If either is missing or the
#             server cannot be reached, it prints SKIPPED and exits 0 (exits 2
#             when TEST_REQUIRE_DB=1).
# Side effects  The standard Supabase roles anon, authenticated and service_role
#             are created if missing and left in place (they are cluster-wide).
#             Only databases whose names start with medinv_test_ are ever
#             created or dropped. The lock scenario starts one background psql
#             session (application_name medinv_blocker_*) for a few seconds; it
#             is ended with its database. If a run is killed with SIGKILL,
#             remove any leftovers with:
#               psql -h 127.0.0.1 -p 54329 -U postgres -d postgres -Atc \
#                 "select 'drop database \"'||datname||'\";' from pg_database where datname like 'medinv\_test\_%'"
# Exit code   0 every check passed (or SKIPPED), 1 a check failed or a script
#             errored, 2 refused to run (non-local host, not a superuser) or
#             could not run with TEST_REQUIRE_DB=1.

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SQL="$HERE/sql"
FIX="$HERE/fixtures"
MIGRATION="${TEST_MIGRATION_FILE:-$REPO/supabase/migrations/20261105000000_categories_access_and_supplier_order_number.sql}"
SCHEMA_SQL="$REPO/supabase/schema.sql"
RLS_SQL="$REPO/supabase/rls.sql"

HOST="${TEST_PGHOST:-127.0.0.1}"
PORT="${TEST_PGPORT:-54329}"
DBUSER="${TEST_PGUSER:-postgres}"
QUIET="${TEST_QUIET:-0}"

# Keep the caller's environment from redirecting or altering our connections.
unset PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGHOSTADDR
export PGCONNECT_TIMEOUT=5

# ── Safety: never anything but a local server ────────────────────────────────
# Only a numeric loopback address, localhost, ::1 or a unix socket directory. A glob such as 127.* would also let through DNS
# names like 127.attacker.example, which can point anywhere.
is_local_host() {
  local h="$1" octet
  if [[ "$h" =~ ^127(\.[0-9]{1,3}){3}$ ]]; then
    for octet in ${h//./ }; do
      [ "$((10#$octet))" -le 255 ] || return 1
    done
    return 0
  fi
  case "$h" in
    localhost|::1|/*) return 0 ;;
  esac
  return 1
}

if ! is_local_host "$HOST"; then
  echo "REFUSED: TEST_PGHOST=$HOST is not a local address." >&2
  echo "This suite creates and drops databases and roles. It must only run against a throwaway local PostgreSQL, never a real Supabase project." >&2
  echo "Allowed: a numeric 127.x.y.z address, localhost, ::1, or the directory of a unix socket (a path starting with /)." >&2
  exit 2
fi

# ── Skip cleanly when the tooling or server is not there ─────────────────────
# Every "cannot run here" exit goes through skip_exit: a clean exit 0 by default, so a machine without PostgreSQL does not fail
# a check that has nothing to check; exit 2 when TEST_REQUIRE_DB=1, because a suite that did not run has not passed.
skip_exit() {
  if [ "${TEST_REQUIRE_DB:-0}" = 1 ]; then
    echo "REQUIRED: TEST_REQUIRE_DB=1 is set, so not being able to run the SQL tests is a failure here (exit 2)." >&2
    exit 2
  fi
  exit 0
}

if ! command -v psql >/dev/null 2>&1; then
  echo "SKIPPED: psql was not found on PATH. Install the PostgreSQL client to run the SQL tests."
  skip_exit
fi

psql_major="$(psql --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
if [ "${psql_major:-0}" -lt 13 ] 2>/dev/null; then
  echo "SKIPPED: the psql client is version ${psql_major:-unknown}; the SQL test files need psql 13 or newer (\\if and :{?variable})."
  skip_exit
fi

ADMIN_DB=""
conn_err=""
for candidate in postgres template1; do
  if conn_err="$(psql -X -q -At -h "$HOST" -p "$PORT" -U "$DBUSER" -d "$candidate" -c 'select 1' 2>&1 >/dev/null)"; then
    ADMIN_DB="$candidate"; break
  fi
done
if [ -z "$ADMIN_DB" ]; then
  echo "SKIPPED: no PostgreSQL server reachable at $HOST:$PORT as $DBUSER (set TEST_PGHOST / TEST_PGPORT / TEST_PGUSER)."
  echo "         psql said: $(printf '%s' "$conn_err" | head -n 2 | tr '\n' ' ')"
  skip_exit
fi

psql_admin() { psql -X -q -At -v ON_ERROR_STOP=1 -h "$HOST" -p "$PORT" -U "$DBUSER" -d "$ADMIN_DB" "$@"; }
psql_db()    { local db="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$HOST" -p "$PORT" -U "$DBUSER" -d "$db" "$@"; }

server_version_num="$(psql_admin -c 'show server_version_num' 2>/dev/null || echo 0)"
server_version="$(psql_admin -c 'show server_version' 2>/dev/null || echo unknown)"
if [ "${server_version_num:-0}" -lt 130000 ] 2>/dev/null; then
  echo "SKIPPED: PostgreSQL $server_version is too old; the suite needs 13 or newer."
  skip_exit
fi
if [ "$(psql_admin -c "select rolsuper from pg_roles where rolname = current_user" 2>/dev/null)" != "t" ]; then
  echo "REFUSED: $DBUSER is not a superuser. The suite needs CREATE DATABASE, CREATE ROLE and SET ROLE." >&2
  exit 2
fi
for f in "$MIGRATION" "$SCHEMA_SQL" "$RLS_SQL" "$FIX/live-replica.sql" "$FIX/supabase-defaults.sql" "$FIX/seed.sql" \
         "$SQL/00-helpers.sql" "$SQL/01-shape.sql" "$SQL/10-before-migration.sql" "$SQL/20-after-first-apply.sql" \
         "$SQL/25-after-second-apply.sql" "$SQL/30-categories-flow.sql" "$SQL/31-supplier-order-number.sql" \
         "$SQL/32-stock-operations.sql" "$SQL/33-access-boundaries.sql" "$SQL/34-rls-sql-section.sql" "$SQL/40-rollback.sql"; do
  if [ ! -f "$f" ]; then echo "ERROR: missing file $f" >&2; exit 2; fi
done

# ── Workspace and guaranteed cleanup ─────────────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/medinv-sqltest.XXXXXX")"
RUN_ID="$$_$(date +%s)"
CREATED_DBS=()
CLEANED=0
BLOCKER_PID=""   # background session of the lock scenario, while one is running
BLOCKER_APP=""

drop_db() {
  local db="$1"
  case "$db" in medinv_test_*) ;; *) echo "refusing to drop non-test database $db" >&2; return 1 ;; esac
  psql_admin -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()" >/dev/null 2>&1
  psql_admin -c "drop database if exists \"$db\"" >/dev/null 2>&1
}

cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  local db dropped=0 failed=0
  for db in ${CREATED_DBS[@]+"${CREATED_DBS[@]}"}; do
    if drop_db "$db"; then dropped=$((dropped + 1)); else failed=$((failed + 1)); fi
  done
  # The lock scenario's background session ends with its database; reap it.
  if [ -n "$BLOCKER_PID" ]; then wait "$BLOCKER_PID" 2>/dev/null; BLOCKER_PID=""; fi
  rm -rf "$WORK"
  if [ "$failed" -gt 0 ]; then
    echo "WARNING: could not drop $failed throwaway database(s); list them with: select datname from pg_database where datname like 'medinv\\_test\\_%'" >&2
  elif [ "$dropped" -gt 0 ]; then
    echo "cleanup: dropped $dropped throwaway database(s)"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# The documented rollback block, taken from the migration header.
ROLLBACK_SQL="$WORK/rollback.sql"
sed -n '/^-- <rollback-sql>$/,/^-- <\/rollback-sql>$/p' "$MIGRATION" | sed '1d;$d' | sed -E 's/^--[[:space:]]?//' > "$ROLLBACK_SQL"
HAVE_ROLLBACK=1
if ! grep -qi 'drop column' "$ROLLBACK_SQL"; then HAVE_ROLLBACK=0; fi

# The categories section of rls.sql (section 4, up to the heading of section 5).
RLS_CATEGORIES_SQL="$WORK/rls-categories.sql"
sed -n '/^-- .* 4\. categories policies/,/^-- .* 5\. RPC function execute permission/p' "$RLS_SQL" | sed '$d' > "$RLS_CATEGORIES_SQL"
HAVE_RLS_SECTION=1
if ! grep -q 'CREATE POLICY "anon: read categories"' "$RLS_CATEGORIES_SQL" || ! grep -q 'CREATE POLICY "anon: insert categories"' "$RLS_CATEGORIES_SQL"; then HAVE_RLS_SECTION=0; fi

# The read-only pre-check the migration header tells the operator to run first.
PRECHECK_SQL="$WORK/precheck.sql"
sed -n '/^-- <precheck-sql>$/,/^-- <\/precheck-sql>$/p' "$MIGRATION" | sed '1d;$d' | sed -E 's/^--[[:space:]]?//' > "$PRECHECK_SQL"
HAVE_PRECHECK=1
if ! grep -qi 'has_table_privilege' "$PRECHECK_SQL"; then HAVE_PRECHECK=0; fi

psql_admin <<'SQL' >/dev/null
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      if r = 'service_role' then execute format('create role %I nologin noinherit bypassrls', r);
      else execute format('create role %I nologin noinherit', r); end if;
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
SQL

echo "medinv SQL tests - PostgreSQL $server_version at $HOST:$PORT as $DBUSER"
echo "migration under test: ${MIGRATION#"$REPO"/}"

# ── One shape ────────────────────────────────────────────────────────────────
TOTAL_PASS=0
TOTAL_FAIL=0
SHAPES_FAILED=0
SUMMARY_LINES=()

record_failure() { SHAPES_FAILED=$((SHAPES_FAILED + 1)); }

# One quiet, unaligned query helper, and the same with the session forced
# read-only (a write fails with SQLSTATE 25006), used to prove the documented
# pre-check cannot change anything.
sql_at() { local db="$1"; shift; psql_db "$db" -At "$@"; }
psql_ro() { local db="$1"; shift; env PGOPTIONS='-c default_transaction_read_only=on' psql -X -q -At -v ON_ERROR_STOP=1 -h "$HOST" -p "$PORT" -U "$DBUSER" -d "$db" "$@"; }

# psql prefixes every notice with "psql:<file>:<line>: ". <file> is whatever path
# psql was given and may hold spaces or colons (a checkout under "Jane Doe", or
# C:\Users\...), so cut at the first ": <SEVERITY>:  " instead of guessing where
# the path ends.
strip_psql_prefix() {
  awk '{ if (substr($0, 1, 5) == "psql:" && match($0, /: (NOTICE|WARNING|ERROR|FATAL|INFO|LOG):  /)) $0 = substr($0, RSTART + 2); print }' "$1" > "$1.stripped" \
    && mv "$1.stripped" "$1"
}

# How many NOTIFY pgrst notifications psql printed on stdout strictly between
# "@@APPLY-BEGIN <label>" and "@@APPLY-END <label>" (echoed by the sql files
# around one application of the migration or of the rollback block). Prints
# "missing" when either marker is absent.
notifications_in() { # label stdout-file
  awk -v label="$1" '
    $0 == "@@APPLY-BEGIN " label { begun = 1; inside = 1; next }
    $0 == "@@APPLY-END " label   { ended = 1; inside = 0; next }
    inside && index($0, "Asynchronous notification \"pgrst\" with payload \"reload schema\"") == 1 { n++ }
    END { if (begun && ended) print n + 0; else print "missing" }' "$2"
}

# Creates database $2 and loads the shape $1 into it (see the header). Returns 0
# when it is ready, 1 when the database could not be created, 2 when the shape
# could not be loaded; the reason is in the log file $3.
build_shape_db() { # shape db log
  local shape="$1" db="$2" setup_log="$3" setup_ok=1
  CREATED_DBS+=("$db")
  psql_admin -c "create database \"$db\" template template0 encoding 'UTF8'" >"$setup_log" 2>&1 || return 1

  psql_db "$db" -f "$FIX/supabase-defaults.sql" >>"$setup_log" 2>&1 || setup_ok=0
  if [ "$setup_ok" = 1 ]; then
    case "$shape" in
      live)
        psql_db "$db" -f "$FIX/live-replica.sql" >>"$setup_log" 2>&1 || setup_ok=0 ;;
      repo_legacy|repo_fresh)
        psql_db "$db" -f "$SCHEMA_SQL" >>"$setup_log" 2>&1 || setup_ok=0
        [ "$setup_ok" = 1 ] && { psql_db "$db" -f "$RLS_SQL" >>"$setup_log" 2>&1 || setup_ok=0; }
        if [ "$setup_ok" = 1 ] && [ "$shape" = repo_legacy ]; then
          # Make the database look like one provisioned before this change.
          psql_db "$db" \
            -c 'alter table public.medications drop column supplier_order_number' \
            -c 'drop policy "anon: read categories" on public.categories' \
            -c 'drop policy "anon: insert categories" on public.categories' >>"$setup_log" 2>&1 || setup_ok=0
        fi ;;
    esac
  fi
  [ "$setup_ok" = 1 ] || return 2
  return 0
}

run_shape() {
  local shape="$1" title="$2" with_rollback="$3"
  local db="medinv_test_${shape}_${RUN_ID}"
  local setup_log="$WORK/$shape.setup.log" out="$WORK/$shape.out" err="$WORK/$shape.err"
  local pass=0 fail=0 rc=0 problems=0 built=0

  echo
  echo "== $shape: $title"

  build_shape_db "$shape" "$db" "$setup_log"; built=$?
  if [ "$built" = 1 ]; then
    echo "  SETUP FAILED: could not create the database"; sed 's/^/    /' "$setup_log"
    SUMMARY_LINES+=("$(printf '%-12s %s' "$shape" 'SETUP FAILED')"); record_failure; return
  elif [ "$built" != 0 ]; then
    echo "  SETUP FAILED while loading the $shape shape:"; grep -E 'ERROR|FATAL' "$setup_log" | head -n 5 | sed 's/^/    /'
    SUMMARY_LINES+=("$(printf '%-12s %s' "$shape" 'SETUP FAILED')"); record_failure; return
  fi

  # The query the migration header tells the operator to run first. Run
  # read-only on the shape as it is before the migration.
  local pc_pass=0 pc_fail=0 pc_want pc_got
  if [ "$HAVE_PRECHECK" = 1 ]; then
    case "$shape" in live) pc_want='t|t|t|' ;; *) pc_want='f|t|t|t' ;; esac
    pc_got="$(psql_ro "$db" -f "$PRECHECK_SQL" 2>&1)"
    if [ "$pc_got" = "$pc_want" ]; then
      [ "$QUIET" = 1 ] || echo "  PASS  pre-check: the documented read-only query returns rls_enabled|anon_can_select|anon_can_insert|anon_can_use_id_sequence = $pc_want before the migration"
      pc_pass=1
    else
      echo "  FAIL  pre-check: the documented read-only query returned '$pc_got' before the migration, expected '$pc_want'"
      pc_fail=1
    fi
  fi

  local files=("$SQL/00-helpers.sql" "$SQL/01-shape.sql" "$FIX/seed.sql" "$SQL/10-before-migration.sql"
               "$SQL/20-after-first-apply.sql" "$SQL/25-after-second-apply.sql" "$SQL/30-categories-flow.sql"
               "$SQL/31-supplier-order-number.sql" "$SQL/32-stock-operations.sql" "$SQL/33-access-boundaries.sql"
               "$SQL/34-rls-sql-section.sql")
  local stages="shape before-migration after-first-apply after-second-apply categories-flow supplier-order-number stock-operations access-boundaries rls-sql-section"
  if [ "$with_rollback" = 1 ]; then
    files+=("$SQL/40-rollback.sql"); stages="$stages rollback"
  fi
  local args=() f
  for f in "${files[@]}"; do args+=(-f "$f"); done

  # One session for the whole run, so state (and cached plans) carry across the
  # migration. stderr carries the PASS/FAIL notices, stdout the NOTIFY lines.
  psql_db "$db" -v shape="$shape" -v migration_file="$MIGRATION" -v rollback_file="$ROLLBACK_SQL" -v rls_categories_file="$RLS_CATEGORIES_SQL" \
    "${args[@]}" >"$out" 2>"$err"
  rc=$?

  strip_psql_prefix "$err"

  pass=$(grep -c '^NOTICE:  PASS  ' "$err" || true)
  fail=$(grep -c '^NOTICE:  FAIL  ' "$err" || true)
  pass=$((pass + pc_pass)); fail=$((fail + pc_fail))

  # Show the log: stage headings and checks.
  local line
  while IFS= read -r line; do
    case "$line" in
      "NOTICE:  [STAGE] "*) [ "$QUIET" = 1 ] || echo "  -- ${line#"NOTICE:  [STAGE] "}" ;;
      "NOTICE:  PASS  "*)   [ "$QUIET" = 1 ] || echo "  PASS  ${line#"NOTICE:  PASS  "}" ;;
      "NOTICE:  FAIL  "*)   echo "  FAIL  ${line#"NOTICE:  FAIL  "}" ;;
    esac
  done < "$err"

  # Every stage must have run.
  local s
  for s in $stages; do
    if ! grep -q "^NOTICE:  \[STAGE\] $s\$" "$err"; then
      echo "  FAIL  stage '$s' never ran"; problems=$((problems + 1))
    fi
  done

  # Every application of the migration, and the rollback block, must announce a
  # schema reload when it commits. The count is taken strictly between the
  # @@APPLY markers of that one application. A count over the whole run would be
  # satisfied by the rollback block's own NOTIFY and prove nothing about the
  # migration.
  local label notified apply_labels="first second"
  [ "$with_rollback" = 1 ] && apply_labels="$apply_labels rollback roll-forward"
  for label in $apply_labels; do
    notified="$(notifications_in "$label" "$out")"
    if [ "$notified" = missing ]; then
      echo "  FAIL  NOTIFY pgrst: the @@APPLY-BEGIN/@@APPLY-END markers of the '$label' application are missing from the psql output, so its notifications cannot be counted"
      fail=$((fail + 1))
    elif [ "$notified" -ge 1 ]; then
      [ "$QUIET" = 1 ] || echo "  PASS  NOTIFY pgrst 'reload schema' was delivered when the '$label' application committed ($notified)"
      pass=$((pass + 1))
    else
      echo "  FAIL  NOTIFY pgrst 'reload schema' was not delivered when the '$label' application committed (saw 0, expected at least 1)"
      fail=$((fail + 1))
    fi
  done

  if [ "$rc" -ne 0 ]; then
    echo "  ERROR psql stopped with exit code $rc before finishing:"
    grep -E -A4 'ERROR:|FATAL:' "$err" | head -n 12 | sed 's/^/    /'
    problems=$((problems + 1))
  fi
  if [ "$pass" -eq 0 ]; then echo "  FAIL  no checks ran"; problems=$((problems + 1)); fi

  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail + problems))
  if [ "$fail" -gt 0 ] || [ "$problems" -gt 0 ]; then record_failure; fi
  echo "  => $shape: $pass passed, $((fail + problems)) failed"
  SUMMARY_LINES+=("$(printf '%-12s %3d passed  %3d failed' "$shape" "$pass" "$((fail + problems))")")
}

# ── Static checks on the text of the files ───────────────────────────────────
shell_pass() { TOTAL_PASS=$((TOTAL_PASS + 1)); [ "$QUIET" = 1 ] || echo "  PASS  $1"; }
shell_fail() { TOTAL_FAIL=$((TOTAL_FAIL + 1)); record_failure; echo "  FAIL  $1"; }

# ── Scenarios that need a database of their own ──────────────────────────────
# They report through shell_pass / shell_fail like the static checks, and use the
# same shapes as above, loaded by build_shape_db.
check_eq() { # label got expected
  if [ "$2" = "$3" ]; then shell_pass "$1"; else shell_fail "$1  [expected '$3', got '$2']"; fi
}

SC_DB=""   # name of the database new_scenario_db just built
new_scenario_db() { # name shape
  local name="$1" shape="$2" log built=0
  SC_DB="medinv_test_${name}_${RUN_ID}"
  log="$WORK/$name.setup.log"
  build_shape_db "$shape" "$SC_DB" "$log"; built=$?
  if [ "$built" != 0 ]; then
    shell_fail "$name scenario: could not build the $shape shape ($(grep -E 'ERROR|FATAL' "$log" | head -n 1))"
    return 1
  fi
  return 0
}

stop_blocker() {
  [ -n "$BLOCKER_PID" ] || return 0
  psql_admin -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name = '$BLOCKER_APP'" >/dev/null 2>&1
  wait "$BLOCKER_PID" 2>/dev/null
  BLOCKER_PID=""
}

# The header promises: it fully applies or not at all, and it gives up after 5
# seconds instead of queueing behind a long-running query. Reproduced for real:
# a second session holds ACCESS SHARE on categories (what any running SELECT
# holds). The migration's ALTER TABLE on medications goes through, then its
# CREATE POLICY on categories has to wait for that lock. Without lock_timeout it
# would wait until the other session ends (20 s here, however long a real query
# runs); without the transaction it would leave the new column behind.
scenario_lock_timeout() {
  echo
  echo "== scenario: lock timeout (another session holds a lock on categories while the migration runs)"
  new_scenario_db lock live || return 0
  local db="$SC_DB" mlog="$WORK/lock.migration.log" held=0 tries=0 n="" rc=0 start=0 elapsed=0 state=""
  local state_sql="select (select count(*) from pg_attribute where attrelid = 'public.medications'::regclass and attname = 'supplier_order_number' and not attisdropped) || ' column, ' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'categories') || ' policies'"
  BLOCKER_APP="medinv_blocker_${RUN_ID}"
  PGAPPNAME="$BLOCKER_APP" psql -X -q -h "$HOST" -p "$PORT" -U "$DBUSER" -d "$db" \
    -c "begin; lock table public.categories in access share mode; select pg_sleep(20)" >/dev/null 2>&1 &
  BLOCKER_PID=$!
  while [ "$tries" -lt 50 ]; do
    n="$(sql_at "$db" -c "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where a.application_name = '$BLOCKER_APP' and l.locktype = 'relation' and l.mode = 'AccessShareLock' and l.granted and l.database = (select oid from pg_database where datname = current_database()) and l.relation = 'public.categories'::regclass" 2>/dev/null)"
    if [ "${n:-0}" = 1 ]; then held=1; break; fi
    sleep 0.2; tries=$((tries + 1))
  done
  if [ "$held" != 1 ]; then
    stop_blocker
    shell_fail "lock timeout: the scenario could not hold a lock on categories from a second session, so the migration's behaviour under a lock was not tested"
    return 0
  fi

  start="$(date +%s)"
  psql_db "$db" -v VERBOSITY=sqlstate -f "$MIGRATION" >"$mlog" 2>&1; rc=$?
  elapsed=$(( $(date +%s) - start ))
  if [ "$rc" -ne 0 ] && grep -q '55P03' "$mlog" && [ "$elapsed" -le 12 ]; then
    shell_pass "lock timeout: with another session holding a lock on categories the migration gave up with SQLSTATE 55P03 after ${elapsed}s instead of waiting for it"
  else
    shell_fail "lock timeout: with another session holding a lock on categories the migration must give up with SQLSTATE 55P03 within 12s (exit code $rc after ${elapsed}s; last output line: $(tail -n 1 "$mlog"))"
  fi
  if [ "$rc" -ne 0 ]; then
    state="$(sql_at "$db" -c "$state_sql")"
    check_eq "lock timeout: ...and the run that gave up left nothing behind, although the new column had already been added before the wait began (all or nothing)" "$state" "0 column, 0 policies"
  fi
  stop_blocker
  psql_db "$db" -f "$MIGRATION" >"$mlog" 2>&1; rc=$?
  state="$(sql_at "$db" -c "$state_sql")"
  check_eq "lock timeout: ...and once the other session has ended, running the migration again applies it (the header says \"just run it again\")" "exit $rc, $state" "exit 0, 1 column, 2 policies"
}

# supplier_order_number may already exist (someone added it by hand). The
# migration never alters a column, so a column of another type has to stop it:
# skipping it silently would leave staff typing codes into, say, an integer
# column that drops their leading zeros.
scenario_column_conflict() {
  echo
  echo "== scenario: column conflict (medications.supplier_order_number already exists)"
  new_scenario_db conflict live || return 0
  local db="$SC_DB" mlog="$WORK/conflict.migration.log" def before after rc=0
  local state_sql="select format_type(a.atttypid, a.atttypmod) || ', comment: ' || coalesce(col_description(a.attrelid, a.attnum), '<none>') || ', categories policies: ' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'categories') from pg_attribute a where a.attrelid = 'public.medications'::regclass and a.attname = 'supplier_order_number' and not a.attisdropped"
  for def in "integer" "bigint" "varchar(10)" "text[]"; do
    sql_at "$db" -c "alter table public.medications add column supplier_order_number $def" >/dev/null
    before="$(sql_at "$db" -c "$state_sql")"
    psql_db "$db" -v VERBOSITY=verbose -f "$MIGRATION" >"$mlog" 2>&1; rc=$?
    after="$(sql_at "$db" -c "$state_sql")"
    if [ "$rc" -ne 0 ] && grep -q '42804' "$mlog" && grep -q 'already exists as' "$mlog"; then
      shell_pass "column conflict: a pre-existing $def column stops the migration with an error (SQLSTATE 42804) instead of being skipped silently"
    else
      shell_fail "column conflict: a pre-existing $def column must stop the migration with an error (SQLSTATE 42804, \"already exists as\"); it ended with exit code $rc"
    fi
    check_eq "column conflict: ...and the $def column was left exactly as it was (type, comment, and no policy added either)" "$after" "$before"
    sql_at "$db" -c "alter table public.medications drop column supplier_order_number" >/dev/null
  done

  sql_at "$db" -c "alter table public.medications add column supplier_order_number text" \
              -c "comment on column public.medications.supplier_order_number is 'owner note: keep me'" >/dev/null
  psql_db "$db" -f "$MIGRATION" >"$mlog" 2>&1; rc=$?
  check_eq "column conflict: a pre-existing text column is accepted, and the comment someone wrote on it is kept, not overwritten" \
    "exit $rc, $(sql_at "$db" -c "$state_sql")" "exit 0, text, comment: owner note: keep me, categories policies: 2"
}

# The migration issues no GRANT, so it cannot help where anon lacks the plain
# table privileges. 42501 is also what a row level security refusal gives, so
# the header tells the operator to run a read-only pre-check first. Prove that
# the pre-check sees each gap, and that the gap is real: the migration runs
# fine and categories still cannot be created until the privilege is granted.
priv_case() { # name shape revoke-sql expected-precheck grant-sql what
  local name="$1" shape="$2" revoke_sql="$3" want_pre="$4" grant_sql="$5" what="$6"
  local db rc=0 mlog="$WORK/$name.migration.log" ins guard
  new_scenario_db "$name" "$shape" || return 0
  db="$SC_DB"
  psql_db "$db" -v shape="$shape" -f "$SQL/00-helpers.sql" >/dev/null 2>&1
  ins="select medinv_t.probe('anon', \$q\$insert into public.categories (name) values ('probe')\$q\$)"
  if [ "$name" = privuuid ]; then
    guard="$(psql_ro "$db" -v VERBOSITY=sqlstate -c "create table public.medinv_ro_probe (x int)" 2>&1 | head -n 1)"
    check_eq "pre-check: the read-only session used to run it really refuses writes (SQLSTATE 25006), so running it cannot change anything" "$guard" "ERROR:  25006"
  fi
  sql_at "$db" -c "$revoke_sql" >/dev/null
  check_eq "pre-check: with $what revoked from anon it reports the gap (rls_enabled|anon_can_select|anon_can_insert|anon_can_use_id_sequence)" \
    "$(psql_ro "$db" -f "$PRECHECK_SQL" 2>&1)" "$want_pre"
  psql_db "$db" -f "$MIGRATION" >"$mlog" 2>&1; rc=$?
  check_eq "privileges: the migration still runs without error with $what revoked from anon, because it grants nothing" "$rc" "0"
  check_eq "privileges: ...and it does not make up for it: anon still cannot create a category (42501, as the pre-check predicted)" "$(sql_at "$db" -c "$ins")" "err:42501"
  sql_at "$db" -c "$grant_sql" >/dev/null
  check_eq "privileges: ...while granting just that privilege separately is enough: anon can create a category (the migration's policies were all that was missing)" "$(sql_at "$db" -c "$ins")" "ok:some"
}

scenario_privileges() {
  echo
  echo "== scenario: privileges the migration does not grant (what the documented pre-check is for)"
  if [ "$HAVE_PRECHECK" != 1 ]; then echo "  (skipped: the migration has no <precheck-sql> block, reported above)"; return 0; fi
  priv_case privuuid live        "revoke insert on public.categories from anon"                 't|t|f|'  "grant insert on public.categories to anon"                 "INSERT on categories"
  priv_case privseq  repo_legacy "revoke all on sequence public.categories_id_seq from anon"    'f|t|t|f' "grant usage on sequence public.categories_id_seq to anon"  "USAGE on the id sequence (bigint ids)"
}

echo
echo "== static checks"
# Belt and braces next to the behavioural checks: the migration may only add.
migration_code="$(sed -E 's/--.*$//' "$MIGRATION" | tr '\n' ' ' | tr -s '[:space:]' ' ' | tr 'A-Z' 'a-z')"
forbidden="$(printf '%s' "$migration_code" \
  | grep -Eo 'drop (table|column|policy|index|trigger|function|constraint|schema)|truncate|delete from|insert into|update [^;]* set |rename|alter column|alter type|(enable|disable|force) row level security|revoke|grant ' \
  | sort -u | tr '\n' ',' | sed 's/,$//')"
if [ -z "$forbidden" ]; then
  shell_pass "migration SQL (comments removed) has no drop, truncate, delete, insert, update, rename, alter column/type, grant, revoke or row level security toggle"
else
  shell_fail "migration SQL contains statement(s) a purely additive migration must not have: $forbidden"
fi
# The header promises one transaction that gives up after a few seconds instead
# of queueing behind a long-running query. Pin the statements that deliver it
# (the lock scenario below tests the behaviour; this catches the text drifting).
# "set local" only works inside a transaction, so begin; has to come first, and
# lock_timeout has to come before the first statement that takes a lock.
code_trimmed="$(printf '%s' "$migration_code" | sed -E 's/^ +//; s/ +$//')"
if printf '%s' "$code_trimmed" | grep -Eq "^begin; set local lock_timeout = '([1-9]|10)s'; "; then
  shell_pass "transaction wrapper: the migration opens with begin; then set local lock_timeout = '<=10s';, before any statement that takes a lock"
else
  shell_fail "transaction wrapper: the migration must open with \"begin;\" followed by \"set local lock_timeout = '<1 to 10>s';\" (its header promises it gives up quickly and applies all or nothing; \"local\" so the setting cannot leak into the operator's session)"
fi
n_begin="$(printf '%s' "$code_trimmed" | grep -Eo 'begin;' | wc -l | tr -d ' ')"
n_commit="$(printf '%s' "$code_trimmed" | grep -Eo 'commit;' | wc -l | tr -d ' ')"
if [ "$n_begin" = 1 ] && [ "$n_commit" = 1 ] && printf '%s' "$code_trimmed" | grep -Eq 'commit;$'; then
  shell_pass "transaction wrapper: exactly one begin; and one commit;, and commit; is the last statement"
else
  shell_fail "transaction wrapper: the migration must contain exactly one \"begin;\" and one \"commit;\", with commit; as its last statement (found $n_begin begin; and $n_commit commit;)"
fi
if [ "$HAVE_PRECHECK" = 1 ]; then
  shell_pass "migration header holds a <precheck-sql> block (it is executed read-only on every shape and in the privilege scenarios)"
else
  shell_fail "pre-check: the migration header has no <precheck-sql> block that reads has_table_privilege for anon on public.categories"
fi
if [ "$HAVE_ROLLBACK" = 1 ]; then
  shell_pass "migration header holds a <rollback-sql> block (it is executed in the rollback stage)"
else
  shell_fail "migration header has no <rollback-sql> block that drops the column, so the documented rollback cannot be tested"
fi
if [ "$HAVE_RLS_SECTION" = 1 ]; then
  shell_pass "rls.sql has a categories section that creates both policies (it is executed in the rls-sql-section stage)"
else
  shell_fail "rls.sql has no categories section (headings '4. categories policies' .. '5. RPC function execute permission') creating both policies"
fi
ROLL="$HAVE_ROLLBACK"

run_shape live       "deployed Health Center shape (uuid ids, RLS on categories, no policy, no supplier column)" "$ROLL"
run_shape repo_legacy "database provisioned from the previous schema.sql + rls.sql (bigint ids)"               "$ROLL"
run_shape repo_fresh  "database provisioned from the current schema.sql + rls.sql (bigint ids)"                  0

scenario_lock_timeout
scenario_column_conflict
scenario_privileges

# ── Summary ──────────────────────────────────────────────────────────────────
cleanup
echo
echo "SUMMARY"
for line in "${SUMMARY_LINES[@]}"; do echo "  $line"; done
if [ "$SHAPES_FAILED" -eq 0 ] && [ "$TOTAL_FAIL" -eq 0 ] && [ "$TOTAL_PASS" -gt 0 ]; then
  echo "RESULT: PASS ($TOTAL_PASS checks passed, 0 failed)"
  exit 0
fi
echo "RESULT: FAIL ($TOTAL_PASS checks passed, $TOTAL_FAIL failed)"
exit 1
