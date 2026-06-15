#!/usr/bin/env node
// Find the bindings still worth naming after a first pass — for convergence loops.
//
// After the main naming pass + the export/TS-class post-passes, a bundle still has many
// single-letter bindings. MOST are genuine compiler temporaries (single-use try/finally
// iterator scratch) that should stay as-is. This script surfaces the REST: short names
// that are real and nameable —
//   - class/function declarations (kind 'hoisted'), always worth a name, OR
//   - function params (an API surface), OR
//   - locals referenced >= 2 times (carry real meaning),
// while EXCLUDING catch-clause params and single-use throwaways.
//
// Emits each with a context window and its module index (for a bundle), so a second-pass
// namer (you or a subagent) can finish them. Re-run after each pass; when it returns few
// or none, you've converged.
//
// Usage: node extract_remaining.mjs <file.js> [maxNameLen=2]
// Output (stdout): { count, remaining: [ {pos,name,kind,refs,module,context}, ... ] }

import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const file = process.argv[2];
const MAXLEN = parseInt(process.argv[3] || '2', 10);
const CTX = 1400;
if (!file) { console.error('usage: node extract_remaining.mjs <file.js> [maxNameLen]'); process.exit(64); }
const src = readFileSync(file, 'utf8');
const ast = parse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx'] });

// Module ranges (if this is a bundle) so each binding can be tagged with its module.
let modulesArr = null;
traverse(ast, { ArrayExpression(p) {
  const e = p.node.elements;
  if (e.length > 20 && e.every((x) => x && x.type === 'FunctionExpression')) {
    if (!modulesArr || e.length > modulesArr.elements.length) modulesArr = p.node;
  }
}});
const ranges = modulesArr ? modulesArr.elements.map((fn, i) => ({ i, s: fn.start, e: fn.end })) : [];
const moduleOf = (pos) => { const r = ranges.find((r) => pos >= r.s && pos < r.e); return r ? r.i : null; };

const seen = new Set();
const rows = [];
traverse(ast, {
  enter(path) {
    const bindings = path.scope.bindings;
    for (const name of Object.keys(bindings)) {
      const b = bindings[name];
      if (seen.has(b)) continue;
      seen.add(b);
      if (name.length > MAXLEN) continue;
      // Exclude catch params (genuine throwaways).
      if (b.kind === 'param' && b.path && b.path.parentPath && b.path.parentPath.isCatchClause()) continue;
      const refs = b.references;
      const worth = b.kind === 'hoisted' || b.kind === 'class' || b.kind === 'param' || refs >= 2;
      if (!worth) continue;
      const idNode = b.identifier;
      if (idNode.start == null) continue;
      const sc = b.scope.path && b.scope.path.node;
      let cs = sc && sc.start != null ? sc.start : 0;
      let ce = sc && sc.end != null ? sc.end : src.length;
      if (ce - cs > CTX) { const h = CTX >> 1; cs = Math.max(cs, idNode.start - h); ce = Math.min(ce, idNode.end + h); }
      rows.push({ pos: idNode.start, name, kind: b.kind, refs, module: moduleOf(idNode.start), context: src.slice(cs, ce) });
    }
  },
});
rows.sort((a, b) => (a.module ?? 1e9) - (b.module ?? 1e9) || a.pos - b.pos);
process.stdout.write(JSON.stringify({ count: rows.length, remaining: rows }, null, 1));
