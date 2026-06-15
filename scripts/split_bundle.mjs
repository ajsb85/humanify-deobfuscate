#!/usr/bin/env node
// Webpack-bundle mode for the deobfuscation pipeline.
//
// A minified webpack/browserify bundle is one giant file made of many module
// functions. Naming all of it at once is impractical, so this helper lets you
// work module-by-module: list modules ranked by size/domain, then dump a
// module's source + bindings (optionally chunked) as inputs for naming.
//
// The `pos` (declaration byte offset) keys it emits are identical to those from
// extract_identifiers.mjs, so maps produced per-module merge cleanly and are
// applied to the ORIGINAL file in one pass with apply_renames.mjs.
//
// Usage:
//   node split_bundle.mjs <bundle.js> list [keyword,keyword,...]
//       Print every module: index, byte size, binding count, and hits for the
//       given domain keywords (default: a generic CAD/web set). Ranked by score.
//
//   node split_bundle.mjs <bundle.js> dump <outDir> <idx...>
//       For each module index, write <outDir>/mod_<idx>.src.js and
//       <outDir>/mod_<idx>.bindings.json ([{pos,name,kind,line}, ...]).
//
//   node split_bundle.mjs <bundle.js> chunk <outDir> <size> <idx...>
//       Split each module's bindings into <size>-sized chunks:
//       <outDir>/mod_<idx>.chunk_<k>.bindings.json (for giant modules).
//
//   node split_bundle.mjs <bundle.js> merge <workDir> <out.json> [base.json]
//       Combine every <workDir>/mod_*.renames.json (and chunk variants) into one
//       map. Offsets are disjoint across modules so merges never conflict; any
//       genuine key clash (same pos, different name) is reported. Pass base.json
//       to fold the new maps into an existing cumulative map (e.g. for the
//       runtime/entry renames you applied first). The bundle arg is ignored here.
//
// Then: `node apply_renames.mjs <bundle.js> <out.json> readable.js` — ALWAYS apply
// the full cumulative map to the ORIGINAL bundle (offsets are keyed to it); never
// chain applies onto already-renamed output.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const [file, cmd, ...rest] = process.argv.slice(2);
if (!file || !cmd) {
  console.error('usage: node split_bundle.mjs <bundle.js> <list|dump|chunk|merge> ...');
  process.exit(64);
}

// `merge` is pure file I/O — handle it before parsing the (possibly huge) bundle.
if (cmd === 'merge') {
  const [workDir, outJson, baseJson] = rest;
  if (!workDir || !outJson) {
    console.error('usage: node split_bundle.mjs <bundle.js> merge <workDir> <out.json> [base.json]');
    process.exit(64);
  }
  const map = baseJson ? JSON.parse(readFileSync(baseJson, 'utf8')) : {};
  let files = 0, added = 0, conflicts = 0;
  for (const f of readdirSync(workDir).filter((x) => /^mod_\d+(\.chunk_\d+)?\.renames\.json$/.test(x))) {
    const m = JSON.parse(readFileSync(`${workDir}/${f}`, 'utf8'));
    files++;
    for (const k in m) {
      if (k in map && map[k] !== m[k]) { conflicts++; continue; } // disjoint offsets => should never happen
      if (!(k in map)) added++;
      map[k] = m[k];
    }
  }
  writeFileSync(outJson, JSON.stringify(map, null, 1));
  console.log(`merged ${files} maps -> ${outJson}: ${Object.keys(map).length} entries (+${added} new${conflicts ? `, ${conflicts} CONFLICTS ignored` : ''})`);
  process.exit(0);
}

const src = readFileSync(file, 'utf8');
const ast = parse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx'] });

// The modules live in the largest array literal whose elements are all functions
// (webpack's `[function(module,exports,require){...}, ...]`). Pick the biggest.
let modulesArr = null;
traverse(ast, {
  ArrayExpression(p) {
    const els = p.node.elements;
    if (els.length > 20 && els.every((e) => e && e.type === 'FunctionExpression')) {
      if (!modulesArr || els.length > modulesArr.elements.length) modulesArr = p.node;
    }
  },
});
if (!modulesArr) {
  console.error('No webpack-style modules array found. This may not be a bundle — use extract_identifiers.mjs directly.');
  process.exit(1);
}
const modules = modulesArr.elements;

// Collect every binding once, tagged with its declaration offset.
const seen = new Set();
const allBindings = [];
traverse(ast, {
  enter(path) {
    const b = path.scope.bindings;
    for (const name of Object.keys(b)) {
      const binding = b[name];
      if (seen.has(binding)) continue;
      seen.add(binding);
      const idNode = binding.identifier;
      if (idNode.start == null) continue;
      allBindings.push({ pos: idNode.start, name, kind: binding.kind, line: idNode.loc ? idNode.loc.start.line : null });
    }
  },
});
allBindings.sort((a, b) => a.pos - b.pos);

const bindingsFor = (fn) => allBindings.filter((x) => x.pos >= fn.start && x.pos < fn.end);

function ensureDir(d) { try { mkdirSync(d, { recursive: true }); } catch {} }

if (cmd === 'list') {
  const kws = (rest[0] || 'parse,export,render,board,pcb,footprint,schematic,svg,3d,net,layer,pad,track').split(',');
  const rows = modules.map((fn, idx) => {
    const slice = src.slice(fn.start, fn.end).toLowerCase();
    let score = 0; const hits = {};
    for (const k of kws) { const c = (slice.match(new RegExp(k, 'g')) || []).length; if (c) { hits[k] = c; score += c; } }
    return { idx, bytes: fn.end - fn.start, bindings: bindingsFor(fn).length, score, hits };
  });
  rows.sort((a, b) => b.score - a.score || b.bindings - a.bindings);
  console.log(`bundle has ${modules.length} modules\n`);
  console.log('idx    bytes   bindings  score  domain-hits');
  for (const r of rows) {
    console.log(
      String(r.idx).padStart(3), String(r.bytes).padStart(8), String(r.bindings).padStart(8),
      String(r.score).padStart(6), '  ', Object.entries(r.hits).map(([k, v]) => `${k}:${v}`).join(' ')
    );
  }
} else if (cmd === 'dump') {
  const [outDir, ...idxs] = rest;
  ensureDir(outDir);
  for (const idx of idxs.map(Number)) {
    const fn = modules[idx];
    if (!fn) { console.error('no module', idx); continue; }
    const ids = bindingsFor(fn);
    writeFileSync(`${outDir}/mod_${idx}.src.js`, src.slice(fn.start, fn.end));
    writeFileSync(`${outDir}/mod_${idx}.bindings.json`, JSON.stringify(ids));
    console.log(`mod ${idx}: ${fn.end - fn.start}B, ${ids.length} bindings -> ${outDir}/mod_${idx}.{src.js,bindings.json}`);
  }
} else if (cmd === 'chunk') {
  const [outDir, sizeStr, ...idxs] = rest;
  const size = parseInt(sizeStr, 10) || 400;
  ensureDir(outDir);
  for (const idx of idxs.map(Number)) {
    const fn = modules[idx];
    if (!fn) { console.error('no module', idx); continue; }
    const ids = bindingsFor(fn);
    const n = Math.ceil(ids.length / size);
    for (let k = 0; k < n; k++) writeFileSync(`${outDir}/mod_${idx}.chunk_${k}.bindings.json`, JSON.stringify(ids.slice(k * size, (k + 1) * size)));
    console.log(`mod ${idx}: ${ids.length} bindings -> ${n} chunk(s)`);
  }
} else {
  console.error(`unknown command '${cmd}' (use list | dump | chunk | merge)`);
  process.exit(64);
}
