#!/usr/bin/env bash
#
# Times every stage of the canonical gate, exactly as `npm run verify` chains
# them, one stage per line of `<outdir>/stages.tsv`.
#
# It exists because "the test suite got slower" is not a reviewable statement
# and "+73.2 s" is. A slice that adds controls re-runs this at its end and
# attributes the difference to named, load-bearing controls — so what has to
# stay fixed between the two measurements is the *script*, not the number.
#
# The one deviation from the canonical command is a second reporter on the
# vitest stage, which writes per-file and per-test durations to
# `<outdir>/foundation-safe.json`. It selects the same files and runs the same
# tests; without it, "which control costs the time" cannot be answered.
#
# Usage (Git Bash):
#   bash scripts/measure-verify.sh /c/Users/you/measurements/v2-09
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 9

if [ $# -ne 1 ]; then
  echo "usage: bash scripts/measure-verify.sh <output-directory>" >&2
  exit 2
fi

OUTDIR="$1"
mkdir -p "$OUTDIR"
SUMMARY="$OUTDIR/stages.tsv"
: > "$SUMMARY"

run() {
  label="$1"; shift
  start=$(date +%s%3N)
  "$@" > "$OUTDIR/$label.log" 2>&1
  rc=$?
  end=$(date +%s%3N)
  printf '%s\t%s\t%s\n' "$label" "$rc" "$(( end - start ))" >> "$SUMMARY"
}

total_start=$(date +%s%3N)

run schema-generate      npm run schema:generate
run typecheck            npm run typecheck
run build                npm run build
run dist-doctor          npm run test:dist-doctor
run dist-trusted-profile npm run test:dist-trusted-profile
run dist-lease-race      npm run test:dist-lease-race
run dist-lease-release   npm run test:dist-lease-release
run dist-runtime-gate    npm run test:dist-runtime-gate
run foundation-safe      npm run test:foundation-safe -- \
  --reporter=default --reporter=json --outputFile.json="$OUTDIR/foundation-safe.json"
run windows-tree-kill    npm run test:windows-tree-kill-tool-release

total_end=$(date +%s%3N)
printf 'TOTAL\t0\t%s\n' "$(( total_end - total_start ))" >> "$SUMMARY"

# A non-zero exit anywhere makes the timings a measurement of a broken gate, so
# it is reported rather than left in a column nobody reads.
if awk -F'\t' '$2 != 0 { exit 1 }' "$SUMMARY"; then
  echo "all stages green"
else
  echo "AT LEAST ONE STAGE FAILED - these timings do not describe a passing gate" >&2
fi
cat "$SUMMARY"
