#!/usr/bin/env bash
#
# Self-test of the SQL suite (supabase/tests/run.sh): proves that the suite can
# FAIL, and that it works from an awkward path. A suite that has never been seen
# to fail proves little: "366 checks passed" used to stay true for a migration
# without its transaction, without its lock_timeout, and (on two of the three
# shapes) without its NOTIFY.
#
#   control    the real migration: the suite must pass
#   relocated  a copy of supabase/ in a directory whose name holds a space, a
#              colon, parentheses, an apostrophe, & and $, with TMPDIR holding a
#              space as well (think of C:\Users\Jane Doe\...): the suite must
#              pass, with the same number of checks as the control
#   mutants    copies of the migration with ONE deliberate defect each: the
#              suite must exit 1 and print the failure that names that defect
#   guard      the two safety rules at the top of run.sh, which need no database:
#              a host that is not local is REFUSED (exit 2) before anything is
#              contacted, including DNS names that merely start with "127."
#              such as 127.attacker.example; and "cannot run here" is a SKIPPED
#              exit 0 by default but exit 2 when TEST_REQUIRE_DB=1
#
# Usage       bash supabase/tests/selftest.sh   (about 30 s: the cases run in parallel)
# Settings    TEST_PGHOST / TEST_PGPORT / TEST_PGUSER / TEST_REQUIRE_DB, as for run.sh
#             (the guard cases set their own TEST_PGHOST, TEST_PGPORT and TEST_REQUIRE_DB)
# Exit code   0 every case behaved as expected (or SKIPPED: no local PostgreSQL),
#             1 a case did not, 2 the files it needs are missing or run.sh refused
#             (or, with TEST_REQUIRE_DB=1, there was no local PostgreSQL to test against).

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RUNNER="$HERE/run.sh"
MIG="$REPO/supabase/migrations/20261105000000_categories_access_and_supplier_order_number.sql"
if [ ! -f "$RUNNER" ] || [ ! -f "$MIG" ]; then
  echo "ERROR: run.sh or the migration is missing next to this script ($RUNNER, $MIG)" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/medinv-selftest.XXXXXX")"
cleanup() {
  local j
  for j in $(jobs -p); do kill "$j" 2>/dev/null; done   # run.sh drops its own databases when told to stop
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── The mutants: each prints the real migration with one defect ──────────────
Q="'"
LOCK_LINE="set local lock_timeout = ${Q}5s${Q};"
NOTIFY_LINE="notify pgrst, ${Q}reload schema${Q};"
ADD_COLUMN_LINE="  add column if not exists supplier_order_number text;"
mk_m1()  { awk -v lt="$LOCK_LINE" '$0 == "begin;" || $0 == lt || $0 == "commit;" { next } { print }' "$MIG"; }
mk_m2()  { awk -v lt="$LOCK_LINE" '$0 == lt { next } { print }' "$MIG"; }
mk_m3()  { awk -v lt="$LOCK_LINE" -v q="$Q" '$0 == lt { print "set local lock_timeout = " q "300s" q ";"; next } { print }' "$MIG"; }
mk_m4()  { awk -v lt="$LOCK_LINE" -v add="$ADD_COLUMN_LINE" '$0 == lt { next } { print } $0 == add { print lt }' "$MIG"; }
mk_m5()  { awk -v lt="$LOCK_LINE" -v q="$Q" '$0 == lt { print "set lock_timeout = " q "5s" q ";"; next } { print }' "$MIG"; }
mk_m6()  { awk '$0 == "commit;" { next } { print }' "$MIG"; }
mk_m7()  { awk -v n="$NOTIFY_LINE" '$0 == n { next } { print }' "$MIG"; }
mk_m8()  { sed 's/^    raise exception /    raise notice /' "$MIG"; }
mk_m9()  { sed 's/^  if col_description(.*) is null then$/  if true then/' "$MIG"; }
mk_m10() { sed "s/has_table_privilege('anon', c.oid, 'INSERT')/has_table_privilege('anon', c.oid, 'SELECT')/" "$MIG"; }

MUTANTS="m1 m2 m3 m4 m5 m6 m7 m8 m9 m10"
describe() {
  case "$1" in
    m1)  echo "begin;, commit; and lock_timeout all removed" ;;
    m2)  echo "lock_timeout removed" ;;
    m3)  echo "lock_timeout of 300s instead of 5s" ;;
    m4)  echo "lock_timeout set only after the first lock-taking statement" ;;
    m5)  echo "plain set lock_timeout instead of set local" ;;
    m6)  echo "commit; removed" ;;
    m7)  echo "notify pgrst removed" ;;
    m8)  echo "wrong-type column only reported with a notice, not refused" ;;
    m9)  echo "an existing column comment is overwritten" ;;
    m10) echo "the pre-check no longer looks at INSERT" ;;
  esac
}

# What each mutant must make the suite print: "<fixed text>|<minimum lines>".
expect_for() {
  case "$1" in
    m1)  echo "FAIL  transaction wrapper: the migration must open with|1"
         echo "FAIL  transaction wrapper: the migration must contain exactly one|1"
         echo "FAIL  lock timeout: with another session holding a lock on categories the migration must give up|1" ;;
    m2)  echo "FAIL  transaction wrapper: the migration must open with|1"
         echo "FAIL  lock timeout: with another session holding a lock on categories the migration must give up|1" ;;
    m3)  echo "FAIL  transaction wrapper: the migration must open with|1"
         echo "FAIL  lock timeout: with another session holding a lock on categories the migration must give up|1" ;;
    m4)  echo "FAIL  transaction wrapper: the migration must open with|1" ;;
    m5)  echo "FAIL  transaction wrapper: the migration must open with|1" ;;
    m6)  echo "FAIL  transaction wrapper: the migration must contain exactly one|1"
         echo "FAIL  NOTIFY pgrst 'reload schema' was not delivered when the 'first' application committed|3" ;;
    m7)  echo "FAIL  NOTIFY pgrst 'reload schema' was not delivered when the 'first' application committed|3" ;;
    m8)  echo "FAIL  column conflict: a pre-existing integer column must stop the migration|1" ;;
    m9)  echo "FAIL  column conflict: a pre-existing text column is accepted, and the comment someone wrote on it is kept|1" ;;
    m10) echo "FAIL  pre-check: with INSERT on categories revoked from anon it reports the gap|1" ;;
  esac
}

# ── Launch everything in parallel ────────────────────────────────────────────
run_case() { # name migration-file(or empty for the real one) [runner]
  local name="$1" mig="$2" runner="${3:-$RUNNER}"
  (
    cd /tmp || exit 1
    if [ -n "$mig" ]; then
      TEST_QUIET=1 TEST_MIGRATION_FILE="$mig" bash "$runner" > "$WORK/$name.log" 2>&1
    else
      TEST_QUIET=1 bash "$runner" > "$WORK/$name.log" 2>&1
    fi
    echo $? > "$WORK/$name.rc"
  ) &
}

BAD=0
GOOD=0
good() { GOOD=$((GOOD + 1)); echo "  ok    $1"; }
bad()  { BAD=$((BAD + 1));  echo "  BAD   $1"; }

# ── The guard cases: they need no database ───────────────────────────────────
# Port 1 has no server, so a host that run.sh lets through ends in SKIPPED (exit 0) at the connection step, which shows it was
# accepted without anything being contacted. A host it refuses never gets that far: REFUSED, exit 2.
guard_expect() { # label wanted-exit wanted-line-start [VAR=value ...]
  local label="$1" want_rc="$2" want_start="$3" out rc
  shift 3
  out="$(cd /tmp && env TEST_QUIET=1 TEST_PGPORT=1 TEST_REQUIRE_DB=0 "$@" bash "$RUNNER" 2>&1)"
  rc=$?
  if [ "$rc" = "$want_rc" ] && printf '%s\n' "$out" | grep -q "^$want_start"; then
    good "$label"
  else
    bad "$label: wanted exit $want_rc and a line starting with $want_start, got exit $rc: $(printf '%s' "$out" | head -n 2 | tr '\n' ' ')"
  fi
}

guard_section() {
  local h
  echo
  echo "guard: only a numeric loopback address, localhost, ::1 or a unix socket directory may be used"
  for h in 127.attacker.example 127.0.0.1.attacker.example 127.1 127.256.0.1 localhost.attacker.example 10.0.0.5 example.com 127.0.0.1:5432; do
    guard_expect "TEST_PGHOST=$h is refused" 2 REFUSED TEST_PGHOST="$h"
  done
  for h in 127.0.0.1 127.1.2.3 localhost ::1 /var/run/postgresql; do
    guard_expect "TEST_PGHOST=$h is let through to the connection step" 0 SKIPPED TEST_PGHOST="$h"
  done
  echo
  echo "guard: a run that cannot happen is a skip by default and a failure with TEST_REQUIRE_DB=1"
  guard_expect "no server, default: SKIPPED, exit 0" 0 SKIPPED TEST_PGHOST=127.0.0.1
  guard_expect "no server, TEST_REQUIRE_DB=1: SKIPPED then REQUIRED, exit 2" 2 REQUIRED TEST_PGHOST=127.0.0.1 TEST_REQUIRE_DB=1
  guard_expect "no server, TEST_REQUIRE_DB=1: the SKIPPED reason is still printed" 2 SKIPPED TEST_PGHOST=127.0.0.1 TEST_REQUIRE_DB=1
}

mkdir -p "$WORK/mutants"
for m in $MUTANTS; do
  "mk_$m" > "$WORK/mutants/$m.sql"
  if cmp -s "$MIG" "$WORK/mutants/$m.sql"; then
    bad "mutant $m ($(describe "$m")) did not change the migration: the text this script edits has moved, so the mutant would test nothing"
  else
    run_case "$m" "$WORK/mutants/$m.sql"
  fi
done

# The same suite from a directory with a hostile name, with TMPDIR holding a space as well.
RELOC="$WORK/Jane Doe's (new) dir: a&b \$HOME/it"
mkdir -p "$RELOC" "$WORK/tmp with space"
cp -R "$REPO/supabase" "$RELOC/supabase"
(
  cd /tmp || exit 1
  TMPDIR="$WORK/tmp with space" TEST_QUIET=1 bash "$RELOC/supabase/tests/run.sh" > "$WORK/relocated.log" 2>&1
  echo $? > "$WORK/relocated.rc"
) &

run_case control ""
wait

# ── Judge ────────────────────────────────────────────────────────────────────
if grep -q '^SKIPPED' "$WORK/control.log" 2>/dev/null; then
  grep '^SKIPPED' "$WORK/control.log"
  echo "SKIPPED: the suite itself could not run here, so the database cases (control, relocated, mutants) were not run."
  guard_section
  if [ "$BAD" -ne 0 ]; then
    echo "SELFTEST: FAIL ($BAD of $((GOOD + BAD)) cases)"
    exit 1
  fi
  [ "${TEST_REQUIRE_DB:-0}" = 1 ] && exit 2
  exit 0
fi
if grep -q '^REFUSED' "$WORK/control.log" 2>/dev/null; then
  cat "$WORK/control.log"; exit 2
fi

echo "self-test of $(basename "$RUNNER") against $(basename "$MIG")"
echo
echo "control: the real migration must pass"
control_rc="$(cat "$WORK/control.rc" 2>/dev/null || echo '?')"
control_result="$(grep '^RESULT:' "$WORK/control.log" | head -n 1)"
if [ "$control_rc" = 0 ] && [ "${control_result#RESULT: PASS}" != "$control_result" ]; then
  good "$control_result"
else
  bad "the unmodified suite did not pass (exit $control_rc): ${control_result:-no RESULT line}. Fix that first; see below"
  tail -n 15 "$WORK/control.log" | sed 's/^/        /'
fi

echo
echo "relocated: the suite run from a path with spaces, a colon, parentheses, an apostrophe, & and \$ (TMPDIR with a space too)"
reloc_rc="$(cat "$WORK/relocated.rc" 2>/dev/null || echo '?')"
reloc_result="$(grep '^RESULT:' "$WORK/relocated.log" | head -n 1)"
if [ "$reloc_rc" = 0 ] && [ "$reloc_result" = "$control_result" ]; then
  good "same result as the control: $reloc_result"
else
  bad "expected '$control_result' with exit 0, got '${reloc_result:-no RESULT line}' with exit $reloc_rc"
  grep -E 'FAIL|ERROR' "$WORK/relocated.log" | head -n 6 | sed 's/^/        /'
fi

echo
echo "mutants: each must make the suite fail, for the right reason"
for m in $MUTANTS; do
  [ -f "$WORK/$m.rc" ] || continue
  rc="$(cat "$WORK/$m.rc")"
  log="$WORK/$m.log"
  missing=""
  if [ "$rc" != 1 ] || ! grep -q '^RESULT: FAIL' "$log"; then
    bad "$m ($(describe "$m")): NOT CAUGHT, the suite exited $rc and said: $(grep '^RESULT:' "$log" | head -n 1)"
    continue
  fi
  while IFS='|' read -r text min; do
    [ -n "$text" ] || continue
    n="$(grep -cF -- "$text" "$log")"
    if [ "$n" -lt "$min" ]; then missing="$missing [wanted $min x '$text', saw $n]"; fi
  done <<EOF
$(expect_for "$m")
EOF
  if [ -z "$missing" ]; then
    good "$m ($(describe "$m")): caught"
  else
    bad "$m ($(describe "$m")): the suite failed, but not with the expected message:$missing"
    grep 'FAIL' "$log" | head -n 4 | sed 's/^/        /'
  fi
done

guard_section

echo
if [ "$BAD" -eq 0 ]; then
  echo "SELFTEST: PASS ($GOOD cases)"
  exit 0
fi
echo "SELFTEST: FAIL ($BAD of $((GOOD + BAD)) cases)"
exit 1
