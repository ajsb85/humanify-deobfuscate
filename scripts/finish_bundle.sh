#!/usr/bin/env bash
# Deterministic backbone of bundle deobfuscation — run after you've produced the
# per-module binding rename map (merged into one JSON). Chains every non-LLM pass in
# the ONE correct order so none is ever forgotten, then reports what (if anything) the
# convergence loop still needs to name.
#
# Usage: finish_bundle.sh <bundle.js> <binding_map.json> <out.js>
#
# Pipeline (each stage is idempotent / verified):
#   1. apply the binding rename map to the ORIGINAL bundle      (scope-safe)
#   2. rename webpack export-ids   (.a/.b member accesses -> real names)
#   3. name TypeScript class-IIFE inner ctors + super params
#   4. node --check                                              (must stay valid JS)
#   5. report remaining nameable short bindings                  (drives the cleanup loop)
set -euo pipefail

SD="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="${1:-}"; MAP="${2:-}"; OUT="${3:-}"
if [ -z "$BUNDLE" ] || [ -z "$MAP" ] || [ -z "$OUT" ]; then
  echo "usage: finish_bundle.sh <bundle.js> <binding_map.json> <out.js>" >&2
  exit 64
fi

echo "[1/5] applying binding map to original bundle..."
node "$SD/apply_renames.mjs" "$BUNDLE" "$MAP" "$OUT"

echo "[2/5] renaming webpack export-ids (.a/.b -> names)..."
node "$SD/rename_exports.mjs" "$OUT" "$OUT"

echo "[3/5] naming TypeScript class-IIFE constructors + super params..."
node "$SD/detect_ts_classes.mjs" "$OUT" > "$OUT.ts.json"
node "$SD/apply_renames.mjs" "$OUT" "$OUT.ts.json" "$OUT"

echo "[4/5] verifying..."
node --check "$OUT" && echo "    OK: valid JS"

echo "[5/5] measuring remaining..."
node "$SD/extract_remaining.mjs" "$OUT" > "$OUT.remaining.json"
REM=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).count)' "$OUT.remaining.json")
SL=$(grep -oE '\b[a-z]\b' "$OUT" | wc -l | tr -d ' ')
echo "    single-letter tokens: $SL ; remaining nameable bindings: $REM"
echo
echo "Done -> $OUT"
echo "If REM is high, run the convergence loop (see SKILL.md 'Refining to convergence'):"
echo "  the residual is in $OUT.remaining.json — name the REAL ones, omit iterator/try-finally scaffolding."
