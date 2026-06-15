#!/usr/bin/env node
// Phase 2 of the deobfuscation pipeline (mirrors humanify's symbol-table rename
// + codegen). Re-parses the SAME source, finds each binding by the `pos` key
// from phase 1, and applies a scope-aware rename via Babel's scope.rename —
// which rewrites the declaration AND every reference, and never touches an
// unrelated identifier that merely shares the name. Then regenerates code.
//
// Usage:   node apply_renames.mjs <input.js> <renames.json> <output.js>
//   renames.json: { "<pos>": "newName", ... }  (pos = string of the offset from phase 1)
//
// Collisions are handled like humanify: if the target name is already bound in
// that scope, Babel's generateUid prefixes it (_name, _name2, ...) so the code
// stays correct.

import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const [file, mapFile, outFile] = process.argv.slice(2);
if (!file || !mapFile || !outFile) {
  console.error('usage: node apply_renames.mjs <input.js> <renames.json> <output.js>');
  process.exit(64);
}

const src = readFileSync(file, 'utf8');
const renames = JSON.parse(readFileSync(mapFile, 'utf8'));
const ast = parse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx'] });

// Collect the bindings we intend to rename first, so applying a rename can't
// perturb the scope map we're iterating over.
const seen = new Set();
const todo = [];
traverse(ast, {
  enter(path) {
    const bindings = path.scope.bindings;
    for (const name of Object.keys(bindings)) {
      const b = bindings[name];
      if (seen.has(b)) continue;
      seen.add(b);
      const key = String(b.identifier.start);
      if (Object.prototype.hasOwnProperty.call(renames, key)) {
        todo.push({ b, newName: renames[key] });
      }
    }
  },
});

let applied = 0;
let skipped = 0;
for (const { b, newName } of todo) {
  const oldName = b.identifier.name;
  if (!newName || typeof newName !== 'string' || newName === oldName) {
    skipped++;
    continue;
  }
  // Avoid clobbering an existing binding/global visible from this scope.
  let target = newName;
  if (b.scope.hasBinding(target) || b.scope.hasGlobal(target) || b.scope.hasReference(target)) {
    target = b.scope.generateUid(newName); // -> _newName, _newName2, ...
  }
  b.scope.rename(oldName, target);
  applied++;
}

const code = generate(ast, { comments: true, retainLines: false, concise: false }).code;
writeFileSync(outFile, code.endsWith('\n') ? code : code + '\n');
console.error(`applied ${applied} renames, skipped ${skipped} -> ${outFile}`);
