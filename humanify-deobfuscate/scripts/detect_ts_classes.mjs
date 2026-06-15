#!/usr/bin/env node
// Deterministic naming for the TypeScript class IIFE pattern.
//
// tsc compiles `class X extends Base {}` to:
//   var X = (function (_superParam) {
//     __extends(_ctor, _superParam);
//     function _ctor(...) { ... }
//     _ctor.prototype.method = ...;
//     return _ctor;
//   })(Base);
// and `class X {}` to the same without the param/__extends. After minification the
// holder `X` often gets a good name but the inner constructor (`_ctor`) and the super
// param stay single letters — so `new e(...)`, `e.prototype.foo`, `_super.call(...)`
// read cryptically even in otherwise-named code.
//
// This pass recognizes that pattern and emits a {pos:name} rename map:
//   inner constructor  -> the holder's name   (e.g. `e` -> `SchExporter`)
//   super-class param  -> `_super`
// Feed the map straight into apply_renames.mjs, which renames scope-safely (the inner
// name collides with the holder in the outer scope, so it becomes `_SchExporter` — the
// same readable convention as other resolved collisions).
//
// Usage: node detect_ts_classes.mjs <input.js> > ts_classes.renames.json
// Run on the already-binding-renamed file so holder names are meaningful.

import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const inFile = process.argv[2];
if (!inFile) { console.error('usage: node detect_ts_classes.mjs <input.js>'); process.exit(64); }
const ast = parse(readFileSync(inFile, 'utf8'), { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx'] });

// Walk up from the IIFE CallExpression to the name it's assigned to.
function holderName(path) {
  let p = path.parentPath;
  while (p) {
    if (p.isVariableDeclarator() && p.node.id.type === 'Identifier') return p.node.id.name;
    if (p.isAssignmentExpression() && p.node.left.type === 'Identifier') return p.node.left.name;
    if (p.isSequenceExpression() || p.isCallExpression() || p.isParenthesizedExpression()) { p = p.parentPath; continue; }
    return null;
  }
  return null;
}

const map = {};
let classes = 0, supers = 0;

// Unwrap an IIFE callee that's wrapped in parens or a comma-sequence
// (tsc emits `var X = (new Deco, function(_super){...})(Base)` for decorated classes).
function asIIFE(node) {
  let n = node;
  while (n && (n.type === 'ParenthesizedExpression')) n = n.expression;
  if (n && n.type === 'SequenceExpression') n = n.expressions[n.expressions.length - 1];
  while (n && n.type === 'ParenthesizedExpression') n = n.expression;
  return n && n.type === 'FunctionExpression' ? n : null;
}

traverse(ast, {
  CallExpression(path) {
    const callee = asIIFE(path.node.callee);
    if (!callee) return;                                       // must resolve to an IIFE
    const body = callee.body.body;
    // inner constructor = a FunctionDeclaration that is also the returned value
    const ret = body.find((s) => s.type === 'ReturnStatement' && s.argument && s.argument.type === 'Identifier');
    if (!ret) return;
    const innerName = ret.argument.name;
    const ctor = body.find((s) => s.type === 'FunctionDeclaration' && s.id && s.id.name === innerName);
    if (!ctor) return;                                         // not the class-IIFE shape
    const holder = holderName(path);
    if (!holder || holder === innerName) return;

    // Rename the inner constructor's declaration to the holder name.
    map[ctor.id.start] = holder;
    classes++;

    // If it's the subclass form, the IIFE's single param is the superclass -> _super.
    if (callee.params.length === 1 && callee.params[0].type === 'Identifier') {
      // confirm an __extends-style call `helper(inner, param)` early in the body
      const param = callee.params[0];
      const isExtends = body.some((s) =>
        s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' &&
        s.expression.arguments.length === 2 &&
        s.expression.arguments[0].type === 'Identifier' && s.expression.arguments[0].name === innerName &&
        s.expression.arguments[1].type === 'Identifier' && s.expression.arguments[1].name === param.name);
      if (isExtends && param.name.length <= 2) { map[param.start] = '_super'; supers++; }
    }
  },
});

console.error(`ts class IIFEs: ${classes} inner constructors + ${supers} super params -> rename map`);
process.stdout.write(JSON.stringify(map, null, 1));
