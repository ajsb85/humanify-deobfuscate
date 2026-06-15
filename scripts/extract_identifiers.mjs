#!/usr/bin/env node
// Phase 1 of the deobfuscation pipeline (mirrors humanify's walker).
//
// Parses a JS file, runs Babel's scope analysis, and emits every *binding*
// (real lexical declaration — not object keys, not member properties) with a
// surrounding-code context window. Each binding is keyed by `pos`, the byte
// offset of its declaration identifier, which is stable across re-parsing the
// same source. Phase 2 (apply_renames.mjs) uses that key to apply renames.
//
// Usage:   node extract_identifiers.mjs <input.js> [> identifiers.json]
// Env:     CONTEXT_SIZE  max chars of context per binding (default 1500)
//
// Output (stdout): { file, count, identifiers: [ {pos, name, kind, line, context}, ... ] }
// Ordered largest-scope-first then by source position — the order you should
// reason about names in, exactly like humanify.

import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const file = process.argv[2];
if (!file) {
  console.error('usage: node extract_identifiers.mjs <input.js>');
  process.exit(64);
}
const CONTEXT = parseInt(process.env.CONTEXT_SIZE || '1500', 10);
const src = readFileSync(file, 'utf8');

// `unambiguous` lets Babel decide script-vs-module; errorRecovery keeps going on
// the slightly-off code minifiers sometimes emit. Plugins cover the common cases.
const ast = parse(src, {
  sourceType: 'unambiguous',
  errorRecovery: true,
  plugins: ['jsx'],
});

const seen = new Set();
const rows = [];

traverse(ast, {
  enter(path) {
    const bindings = path.scope.bindings;
    for (const name of Object.keys(bindings)) {
      const b = bindings[name];
      if (seen.has(b)) continue; // same scope is revisited by every child node
      seen.add(b);

      const idNode = b.identifier;
      const pos = idNode.start;
      if (pos == null) continue;

      // Context = the binding's own scope block, windowed around the identifier
      // if it's larger than CONTEXT. Inner bindings therefore get local context,
      // not the whole file — same idea as humanify's compute_context_window.
      const scopeNode = b.scope.path && b.scope.path.node;
      let cs = scopeNode && scopeNode.start != null ? scopeNode.start : 0;
      let ce = scopeNode && scopeNode.end != null ? scopeNode.end : src.length;
      if (ce - cs > CONTEXT) {
        const half = Math.floor(CONTEXT / 2);
        cs = Math.max(cs, (idNode.start || 0) - half);
        ce = Math.min(ce, (idNode.end || 0) + half);
      }

      rows.push({
        pos,
        name,
        kind: b.kind, // 'var' | 'let' | 'const' | 'param' | 'hoisted' | 'module' ...
        line: idNode.loc ? idNode.loc.start.line : null,
        scopeSize: (scopeNode && scopeNode.end != null ? scopeNode.end : src.length) -
                   (scopeNode && scopeNode.start != null ? scopeNode.start : 0),
        context: src.slice(cs, ce),
      });
    }
  },
});

// Largest scope first, ties broken by source position — the order humanify renames in.
rows.sort((a, b) => b.scopeSize - a.scopeSize || a.pos - b.pos);
rows.forEach((r) => delete r.scopeSize);

process.stdout.write(JSON.stringify({ file, count: rows.length, identifiers: rows }, null, 2));
