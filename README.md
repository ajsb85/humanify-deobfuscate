# humanify-deobfuscate

[![CI](https://github.com/ajsb85/humanify-deobfuscate/actions/workflows/ci.yml/badge.svg)](https://github.com/ajsb85/humanify-deobfuscate/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ajsb85/humanify-deobfuscate)](https://github.com/ajsb85/humanify-deobfuscate/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [Claude Code](https://claude.com/claude-code) **agent skill** that makes minified,
bundled, or obfuscated JavaScript readable again — by renaming identifiers **scope-safely
with an AST while the model supplies the names**. It reaches the parts plain renaming
can't: webpack export-ids (`.a`/`.b`) and TypeScript class-IIFE constructors, with a
deterministic backbone and a convergence loop for large bundles.

It's the from-scratch reimplementation of [humanify](https://github.com/jehna/humanify)'s
technique: a script owns *correctness* (Babel `scope.rename`), the model owns *naming*.

## Why this exists

Renaming minified JS by hand or with find-and-replace silently corrupts code — shadowed
variables merge, names collide. This skill routes every rename through an AST so it's
always safe, and it has been run end-to-end on a real **1 MB / 124-module / ~10k-identifier
webpack bundle**, cutting single-letter identifier tokens by ~63% while keeping the output
byte-for-byte behavior-equivalent.

## Install

Requires [Node.js](https://nodejs.org/). Install with the [skills CLI](https://skills.sh):

```bash
npx skills add ajsb85/humanify-deobfuscate -g
```

Or clone manually into your agent's skills directory (`~/.claude/skills/` for Claude Code),
then install the Babel dependencies:

```bash
cd humanify-deobfuscate/scripts && npm install
```

## Use it

Just ask your agent in natural language — the skill triggers on minified `.js`,
"deobfuscate", "un-minify", "make this readable", "what does this minified code do", etc.
For example:

> "Deobfuscate `vendor.min.js` and tell me what the `parseConfig` module does."

### Single file

```bash
node scripts/extract_identifiers.mjs input.js > identifiers.json   # AST → bindings + context
# (the model names them into renames.json keyed by byte offset)
node scripts/apply_renames.mjs input.js renames.json readable.js   # scope-safe rename
node --check readable.js
```

### Webpack / browserify bundles

```bash
node scripts/split_bundle.mjs bundle.js list                       # survey modules
node scripts/split_bundle.mjs bundle.js dump work 73 102           # dump per module
# (one agent per module names its bindings -> work/mod_<idx>.renames.json)
node scripts/split_bundle.mjs bundle.js merge work renames_all.json
node scripts/finish_bundle.mjs bundle.js renames_all.json readable.js   # deterministic backbone
```

See [`SKILL.md`](SKILL.md) for the full workflow, including the parallel-agent scaling
pattern and the convergence loop.

## What's inside

| Script | Role |
|---|---|
| `extract_identifiers.mjs` | AST → renameable bindings + context, keyed by byte offset |
| `apply_renames.mjs` | scope-safe rename (`scope.rename`) + codegen |
| `split_bundle.mjs` | bundle mode: `list` / `dump` / `chunk` / `merge` |
| `rename_exports.mjs` | post-pass: webpack export-ids (`.a`/`.b` → real names) |
| `detect_ts_classes.mjs` | post-pass: TS class-IIFE inner ctors + super params |
| `extract_remaining.mjs` | convergence loop: surface remaining nameable bindings |
| `finish_bundle.mjs` / `.sh` | one-command deterministic backbone |

## How it works

The model never edits code — it only suggests one name at a time, and an AST applies it
across the binding's whole scope. See [`references/algorithm.md`](references/algorithm.md)
for the full breakdown and how it mirrors humanify's pipeline.

## License

[MIT](LICENSE) © Alexander Salas Bastidas
