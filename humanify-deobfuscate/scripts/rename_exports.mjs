#!/usr/bin/env node
// Webpack export-id renaming — the piece binding-renaming can't reach.
//
// Webpack mangles each module's public exports to single letters: a module does
//   __webpack_require__.d(exports, "a", function () { return SomeLocal; });
// and consumers read it as `imported.a`. Those `.a`/`.b` are PROPERTY names, not
// bindings, so apply_renames.mjs (scope-safe binding rename) never touches them.
//
// This pass closes that gap deterministically:
//   1. For each module, read its `r.d(exports, "<id>", () => Local)` calls to learn
//      exportId -> Local's (already-renamed) name.
//   2. Resolve every `var v = r(N)` import binding to module N.
//   3. Rewrite the definition string "<id>" AND every `v.<id>` access to the local
//      name (suffixed `_` to keep it a distinct property and avoid clashes).
//
// Only member accesses whose object is provably a `r(N)` import binding are touched,
// so real object properties (point.x, color.a) are never renamed.
//
// Usage: node rename_exports.mjs <input.js> <output.js>
// Run it AFTER apply_renames.mjs so the exported locals already have good names.

import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error('usage: node rename_exports.mjs <input.js> <output.js>');
  process.exit(64);
}
const src = readFileSync(inFile, 'utf8');
const ast = parse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx'] });

// Locate the modules array and record each module's byte range + its (module,exports,
// require) param names, which may already be renamed.
let modulesArr = null;
traverse(ast, {
  ArrayExpression(p) {
    const els = p.node.elements;
    if (els.length > 20 && els.every((e) => e && e.type === 'FunctionExpression')) {
      if (!modulesArr || els.length > modulesArr.elements.length) modulesArr = p.node;
    }
  },
});
if (!modulesArr) { console.error('no modules array found'); process.exit(1); }

const mods = modulesArr.elements.map((fn, index) => ({
  index, start: fn.start, end: fn.end,
  exportsParam: fn.params[1] && fn.params[1].name,
  requireParam: fn.params[2] && fn.params[2].name,
}));
const moduleOf = (pos) => mods.find((m) => pos >= m.start && pos < m.end);

// Pass 1: learn each module's export map { exportId -> newPropName }.
const exportMap = {}; // index -> { "a": "Vector2_", ... }
const defLiterals = []; // { node: StringLiteral, newName } definition sites to rewrite
const used = {}; // index -> Set of new prop names (dedupe within a module)

traverse(ast, {
  CallExpression(path) {
    const { callee, arguments: args } = path.node;
    if (callee.type !== 'MemberExpression' || callee.computed) return;
    if (!callee.property || callee.property.name !== 'd') return; // r.d(...)
    const m = moduleOf(path.node.start);
    if (!m || !callee.object || callee.object.name !== m.requireParam) return;
    // args: (exportsObj, "id", getter). Only count exports on THIS module's exports.
    if (args.length < 3) return;
    if (!args[0] || args[0].name !== m.exportsParam) return;
    if (args[1].type !== 'StringLiteral') return;
    const getter = args[2];
    if (!getter || getter.type !== 'FunctionExpression') return;
    const body = getter.body.body;
    const ret = body.find((s) => s.type === 'ReturnStatement');
    if (!ret || !ret.argument || ret.argument.type !== 'Identifier') return; // skip re-exports
    let newName = ret.argument.name + '_'; // trailing _ keeps it distinct from the binding
    used[m.index] = used[m.index] || new Set();
    let n = newName, k = 2;
    while (used[m.index].has(n)) n = newName + k++;
    used[m.index].add(n);
    exportMap[m.index] = exportMap[m.index] || {};
    exportMap[m.index][args[1].value] = n;
    defLiterals.push({ node: args[1], newName: n });
  },
});

// Pass 2: resolve import bindings `var v = r(N)` -> module N.
const importBindingToModule = new Map(); // Binding object -> module index
traverse(ast, {
  VariableDeclarator(path) {
    const init = path.node.init;
    if (!init || init.type !== 'CallExpression') return;
    const m = moduleOf(path.node.start);
    if (!m || !init.callee || init.callee.name !== m.requireParam) return;
    if (init.arguments.length !== 1 || init.arguments[0].type !== 'NumericLiteral') return;
    if (path.node.id.type !== 'Identifier') return;
    const binding = path.scope.getBinding(path.node.id.name);
    if (binding) importBindingToModule.set(binding, init.arguments[0].value);
  },
});

// Apply definition-site renames.
for (const { node, newName } of defLiterals) node.value = newName;

// Pass 3: rewrite `v.<id>` accesses where v is an import binding for module N.
let accessRenames = 0;
traverse(ast, {
  MemberExpression(path) {
    const { object, property, computed } = path.node;
    if (computed || object.type !== 'Identifier' || property.type !== 'Identifier') return;
    const binding = path.scope.getBinding(object.name);
    if (!binding || !importBindingToModule.has(binding)) return;
    const N = importBindingToModule.get(binding);
    const map = exportMap[N];
    if (map && map[property.name]) { property.name = map[property.name]; accessRenames++; }
  },
});

const code = generate(ast, { comments: true, retainLines: false }).code;
writeFileSync(outFile, code.endsWith('\n') ? code : code + '\n');
console.error(`export ids: ${defLiterals.length} definitions renamed, ${accessRenames} accesses rewritten -> ${outFile}`);
