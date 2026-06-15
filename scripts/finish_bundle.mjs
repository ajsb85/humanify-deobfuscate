#!/usr/bin/env node
// Cross-platform (Windows/macOS/Linux) version of finish_bundle.sh — the deterministic
// backbone of bundle deobfuscation. Uses only node + the sibling scripts, so it runs in
// native Windows cmd.exe / PowerShell with no bash required.
//
// Usage: node finish_bundle.mjs <bundle.js> <binding_map.json> <out.js>
//
// Stages (each idempotent / verified):
//   1. apply the binding rename map to the ORIGINAL bundle      (scope-safe)
//   2. rename webpack export-ids   (.a/.b member accesses -> real names)
//   3. name TypeScript class-IIFE inner ctors + super params
//   4. node --check                                              (must stay valid JS)
//   5. report remaining nameable short bindings                  (drives the cleanup loop)

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const SD = dirname(fileURLToPath(import.meta.url));
const [bundle, map, out] = process.argv.slice(2);
if (!bundle || !map || !out) {
  console.error('usage: node finish_bundle.mjs <bundle.js> <binding_map.json> <out.js>');
  process.exit(64);
}
const node = process.execPath;
// run a sibling script; stream its stderr to our console, return its stdout
const run = (script, args) =>
  execFileSync(node, [join(SD, script), ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 });

console.error('[1/5] applying binding map to original bundle...');
process.stderr.write(run('apply_renames.mjs', [bundle, map, out]) || '');

console.error('[2/5] renaming webpack export-ids (.a/.b -> names)...');
run('rename_exports.mjs', [out, out]);

console.error('[3/5] naming TypeScript class-IIFE constructors + super params...');
const tsMap = out + '.ts.json';
writeFileSync(tsMap, run('detect_ts_classes.mjs', [out]));
process.stderr.write(run('apply_renames.mjs', [out, tsMap, out]) || '');

console.error('[4/5] verifying...');
execFileSync(node, ['--check', out], { stdio: 'inherit' });
console.error('    OK: valid JS');

console.error('[5/5] measuring remaining...');
const remFile = out + '.remaining.json';
writeFileSync(remFile, run('extract_remaining.mjs', [out]));
const rem = JSON.parse(readFileSync(remFile, 'utf8')).count;
const singles = (readFileSync(out, 'utf8').match(/\b[a-z]\b/g) || []).length;
console.error(`    single-letter tokens: ${singles} ; remaining nameable bindings: ${rem}`);
console.error(`\nDone -> ${out}`);
console.error(`If remaining is high, run the convergence loop (SKILL.md): name the REAL`);
console.error(`bindings in ${remFile}, omit iterator/try-finally scaffolding.`);
