---
name: humanify-deobfuscate
description: >-
  Deobfuscate, un-minify, and rename identifiers in minified or obfuscated
  JavaScript so it becomes readable — you do the renaming yourself with an AST,
  no external service required. Use this whenever the user wants to make minified
  JS readable, recover meaningful variable/function names, reverse-engineer a
  bundled/webpack/terser/uglify script, or figure out what cryptic code like
  `function a(e,t){...}` actually does — even if they don't name a tool. Triggers
  on minified .js, "make this readable", "rename these variables", "deobfuscate",
  "un-minify", "what does this minified code do". This is the from-scratch
  technique (the same approach humanify uses): a script handles scope-safe AST
  renaming, you supply the descriptive names.
---

# humanify-deobfuscate

Turn machine-mangled JavaScript like `function a(e,t){var n=[];...}` into readable
code like `function chunkString(str, size){var chunks=[];...}` — **without changing
behavior**. Only identifier names (and formatting) change.

## The core idea — and why it's split in two

Safe deobfuscation is two jobs with very different requirements:

1. **Naming** (judgment): infer a good name from how an identifier is *used*. This is
   what you (the model) are great at.
2. **Renaming** (correctness): rewrite a binding and *all* its references without
   touching unrelated identifiers that happen to share the name. Two different `e`s in
   two scopes must stay independent. Doing this by hand or with find-and-replace
   **will corrupt the code** — shadowed variables and collisions break silently.

So never deobfuscate by editing text directly. Let the bundled AST scripts own job #2
(they use Babel's scope analysis, exactly like humanify uses oxc), and you own job #1.

See `references/algorithm.md` for the full breakdown of how humanify does this and how
these scripts mirror it.

## Setup (once)

The scripts need Babel. From the skill's `scripts/` directory:

```bash
cd <skill-dir>/scripts && npm install
```

Requires Node.js. This installs `@babel/parser`, `@babel/traverse`, `@babel/generator`
locally in the skill — nothing global.

## Workflow

### 1. Extract bindings + context

```bash
node <skill-dir>/scripts/extract_identifiers.mjs input.js > identifiers.json
```

This emits every renameable binding with a `pos` key (its declaration offset) and a
**context window** — the source of that binding's scope, windowed around it. Bindings
are ordered **largest-scope-first**, the order you should name them in (outer names
inform inner ones). Object property keys, member accesses, and string literals are
*not* included — those aren't bindings and must not be renamed.

Tune context with `CONTEXT_SIZE=2500 node ...` for denser code.

### 2. Decide the names (your job)

Read `identifiers.json`. For each entry, study `context` and choose a descriptive name
based on **how the identifier is used** — what's assigned to it, what it's called with,
what it returns. Naming rules (these keep the output valid and idiomatic):

- **camelCase** for variables and functions; **PascalCase** for classes and constructors.
- Prefer specific over generic: `userList` not `arr`, `parseConfig` not `fn`.
- If a name is *already* meaningful (`React`, `fetch`, `handleClick`), keep it unchanged —
  don't rename for the sake of it.
- ASCII letters/digits/underscore only; must not start with a digit; avoid reserved
  words. (The apply script normalizes/penalizes anyway, but clean names read better.)
- Use the largest-first order: once you've named an outer function `chunkString`, its
  params `str`/`size` follow naturally.
- **Omit, don't invent.** Leave a binding out of the map (keep its original name) when it
  carries no meaning: a one-letter loop index that's already idiomatic (`i`), or — in
  TypeScript-compiled code — the `try/finally` iterator scratch variables the compiler
  emits (`__values`/`__read`/`__generator` internals, the `e_1`/`_a`/error-and-return
  holders). Naming these adds noise, not readability. In practice ~30–45% of bindings in
  TS-compiled bundles are this kind of scaffolding and are best left untouched.

Write a rename map keyed by `pos` (omit entries you're leaving unchanged):

```json
{
  "9":  "chunkString",
  "21": "str",
  "23": "size"
}
```

Save it as `renames.json`.

**For large files**, work in batches: name the outermost N bindings, apply, re-extract,
and continue inward — or just process `identifiers.json` in chunks. Don't try to hold a
2000-identifier file in your head at once; correctness comes from the AST, so partial
passes compose safely.

### 3. Apply (scope-safe)

```bash
node <skill-dir>/scripts/apply_renames.mjs input.js renames.json readable.js
```

This re-parses, matches each `pos`, and applies `scope.rename` — rewriting every
reference and auto-prefixing `_` on any collision. It prints `applied N renames`.

### 4. Verify

Always confirm you didn't break anything:

```bash
node --check readable.js        # must parse
```

If available, run the project's tests, or compare behavior on a sample input. Then show
the user a short before/after of a few key identifiers so they can see it worked.

## Example

**Input** (`a` is a string-chunker):
```javascript
function a(e,t){var n=[];var r=e.length;var i=0;for(;i<t?... ;)n.push(e.substring(i,i+t));return n}
```
**identifiers.json** (abbreviated): `a`→pos 9, `e`→pos 11, `t`→pos 13, `n`,`r`,`i`…
**renames.json**: `{"9":"chunkString","11":"str","13":"size","...":"chunks"}`
**readable.js**:
```javascript
function chunkString(str, size) {
  var chunks = [];
  var length = str.length;
  for (var i = 0; i < length; i += size) chunks.push(str.substring(i, i + size));
  return chunks;
}
```

## Webpack / browserify bundles (large minified files)

A bundle is one huge file containing many module functions — too big to name in one
pass. Work module-by-module with `scripts/split_bundle.mjs`. This workflow has been run
end-to-end on a 1 MB / 124-module / 10k-binding bundle.

**The whole pipeline, so nothing is skipped (each phase below has its own section):**

1. **Survey & dump** — `split_bundle.mjs list` / `dump` (and `chunk` giant modules).
2. **Name bindings (thorough first pass)** — one subagent per module using
   `references/agent-prompt.md`; its MUST-name checklist (class names + params) is what
   makes the first pass complete instead of needing many cleanup rounds.
3. **Merge** — `split_bundle.mjs merge`.
4. **Deterministic backbone** — `finish_bundle.sh` (binding map → webpack export-ids →
   TS class-IIFE names → verify → report remaining). **Skipping this is the #1 cause of
   a "named but still cryptic" result.**
5. **Converge** — the cleanup loop on `*.remaining.json` until a round names < ~5.

Phases 1–4 plus a couple of phase-5 rounds get a genuinely readable bundle; what's left
after that is compiler scaffolding that is correct to leave.

### The loop: list → dump → name → merge → apply → verify

```bash
# 1. Survey the modules (index, size, binding count, domain-keyword hits):
node <skill-dir>/scripts/split_bundle.mjs bundle.js list

# 2. Dump the modules you'll name (writes work/mod_<idx>.{src.js,bindings.json}):
node <skill-dir>/scripts/split_bundle.mjs bundle.js dump work 73 102 60

# 3. For a giant module (>~400 bindings), chunk its bindings:
node <skill-dir>/scripts/split_bundle.mjs bundle.js chunk work 400 73

# 4. (you/agents name each module — see below — writing work/mod_<idx>.renames.json)

# 5. Merge every per-module map into one cumulative map (folds into a base if given):
node <skill-dir>/scripts/split_bundle.mjs bundle.js merge work renames_all.json [base.json]

# 6. Run the deterministic backbone in ONE command — applies the binding map to the
#    ORIGINAL, then the export-id and TS-class post-passes, verifies, and reports what
#    the convergence loop still needs to name (in readable.js.remaining.json).
#    Cross-platform (Windows/macOS/Linux):
node <skill-dir>/scripts/finish_bundle.mjs bundle.js renames_all.json readable.js
#    (or, on unix only, the bash equivalent: finish_bundle.sh bundle.js renames_all.json readable.js)
```

> **Always use `finish_bundle.sh` for steps after merge** — running the post-passes by
> hand is how a "fully named" bundle ends up still cryptic (the `.a`/`.b` exports and
> class-IIFE names get forgotten). The driver guarantees the full ordered pipeline.

### Post-passes: the parts binding-renaming can't reach

Renaming *bindings* leaves two big categories of crypticness that you must clean up
separately — skipping these is why a "fully named" bundle can still read cryptically:

1. **Webpack export-ids** (`imported.a`, `imported.b`). Webpack mangles each module's
   exports to single letters; consumers read `geometry.a.ORIGIN`. These are *property
   accesses, not bindings*, so `apply_renames.mjs` never touches them — and they're
   numerous (thousands in a real bundle). `rename_exports.mjs` fixes them
   deterministically: it reads each module's `__webpack_require__.d(exports,"a",()=>X)`
   to learn `.a` → `X`, resolves every `r(N)` import, and rewrites both the definition
   and all accesses (only on confirmed import bindings, so real `point.x` is safe).

2. **TypeScript class IIFEs.** `var X = (function(_super){ __extends(e,_super); function
   e(){} return e })(Base)` — the holder `X` gets named but the inner constructor `e`
   and the `_super` param stay cryptic, so `new e(...)`/`e.prototype.foo` read badly.
   `detect_ts_classes.mjs` recognizes this exact compiler pattern and emits a rename map
   (inner ctor → holder name, super param → `_super`) that you apply through the normal
   safe-rename machinery.

The lesson: **minifier/compiler output has recognizable structural patterns. Handle
those deterministically with a script — don't rely on per-binding LLM naming to catch
them, because it's inconsistent and misses property-level mangling entirely.**

### Scaling with parallel agents

This is the proven pattern for big bundles. After `dump`, **fan out one subagent per
module** (or per chunk, for giant ones). Give each agent only:
- the absolute path to its `work/mod_<idx>.src.js` (full module source, for context), and
- its `work/mod_<idx>.bindings.json` (the bindings to name).

Instruct each agent to **write its `{"pos":"name"}` map to `work/mod_<idx>.renames.json`
and return only a one-line summary** — writing to a file (rather than returning the map
as text) is far more reliable at scale. A ready-to-use agent prompt is in
`references/agent-prompt.md`. Then `merge` collects them all.

**Why this is safe to parallelize:** each module occupies a disjoint byte range, so the
`pos` keys never overlap — maps merge with zero conflicts no matter how many agents run.
For giant modules, every chunk-agent sees the *full* module source but names only its
slice; chunks merge the same way.

**Checkpoint discipline:** keep one cumulative `renames_all.json`. After each wave,
`merge` the new maps in and re-apply to the **original** bundle (the `pos` offsets are
keyed to the original — never chain applies onto already-renamed output, or the offsets
drift). `node --check` after every apply.

### Naming tips specific to bundles

- The module function's params `(t, e, r)` are webpack's `(module, exports, require)`.
- `var x = r(N)` imports module N — name `x` by how it's used; the `.a`/`.b` members are
  webpack export ids, *not* bindings, so leave them.
- Bundles are often TypeScript-compiled: name the helpers `__extends`, `__values`,
  `__assign`, `__generator`, `__awaiter`, `__read`, `__spread` — and omit their internal
  iterator/try-finally temporaries (see "Omit, don't invent" above).
- Identify a module's purpose from its strings/methods, then name top-down (class →
  methods → params). A consistent vocabulary across related modules pays off.

### Don't trust the domain score alone

`list` ranks by domain-keyword hits, which is good for finding obvious targets — but
**core geometry, data-structure, and math modules often score zero** (no domain words in
their source) while being high value. After the keyword-ranked modules, also sweep the
remaining modules by **binding count**, and don't skip score-0 ones. "Vendored" guesses
are sometimes wrong too — confirm from the code (a module hinted as an "exporter" turned
out to be the `pako` zlib library).

### What "done" looks like

For a TypeScript-compiled bundle, expect to name roughly **60–70% of all bindings** at
100% module coverage — the rest are compiler scaffolding deliberately left alone. Track
progress as *modules named* and *meaningful bindings named*, not raw binding percentage.

## Refining to convergence (the cleanup loop)

A first pass + the deterministic post-passes still leave short names. Finishing the job is
a **loop-until-dry**: name the genuinely-meaningful residual, re-measure, repeat until the
count stops dropping. The key discipline is knowing what NOT to name.

Each iteration:

```bash
# 1. deterministic passes first (cheap, no LLM) — they may expose more each round:
node <skill-dir>/scripts/rename_exports.mjs readable.js readable.js
node <skill-dir>/scripts/detect_ts_classes.mjs readable.js > ts.json
node <skill-dir>/scripts/apply_renames.mjs readable.js ts.json readable.js

# 2. surface only the REMAINING NAMEABLE bindings (class/fn names, params, multiply-
#    referenced locals) with context — excludes single-use throwaways:
node <skill-dir>/scripts/extract_remaining.mjs readable.js > remaining.json

# 3. name them (you or per-module subagents), apply, then re-measure remaining.json.
#    Stop when each round names only a handful — you've hit the scaffolding floor.
```

**The floor is real — don't fight it.** In TypeScript-compiled bundles a large share of
the short names are iterator-protocol scratch (`for (var i = iter(x), s = i.next();
!s.done; s = i.next())`) and try/finally error holders. These are *multiply-referenced*
but carry no meaning; naming them across thousands of sites makes the code worse, not
better. `extract_remaining.mjs` surfaces them too (it can't perfectly tell them apart),
so the namer (you or the subagent) must be told explicitly: **name function/class names,
constructor & method params, and meaningful locals; OMIT iterator/try-finally temporaries.**

### Running it unattended with /loop

Because each round spawns subagents that notify on completion, the loop self-paces
naturally turn-by-turn. To drive it hands-off, the user can run:

```
/loop 2m continue
```

which re-issues "continue" on an interval so successive rounds (extract → name → apply →
measure) keep firing until convergence. Tell the loop to **stop when a round names < ~5
new bindings** — past that you're only touching scaffolding. (Self-paced `/loop continue`
with no interval works too; the model decides when to stop.)

## Limitations (set expectations)

- Recovers **names and layout**, not deleted **logic, comments, or original file
  structure** — minifiers destroy those irreversibly. This is not a decompiler.
- Renaming exported / public-API names changes the external surface; if that matters,
  skip those `pos` entries.
- Heavily obfuscated code (string-array encoding, control-flow flattening, eval) may
  need a *de-obfuscation* pass (string decoding, dead-code removal) before renaming
  helps — that's beyond this skill's renaming focus.

## Files

- `scripts/extract_identifiers.mjs` — phase 1: AST → bindings + context (keyed by offset)
- `scripts/apply_renames.mjs` — phase 2: scope-safe rename + codegen
- `scripts/split_bundle.mjs` — webpack/browserify bundle mode: `list`/`dump`/`chunk`/`merge`
- `scripts/rename_exports.mjs` — post-pass: rename webpack export-ids (`.a`/`.b` → real names)
- `scripts/detect_ts_classes.mjs` — post-pass: name TS class-IIFE inner ctors + super params
- `scripts/extract_remaining.mjs` — convergence loop: surface remaining nameable short bindings
- `scripts/finish_bundle.mjs` — one-command deterministic backbone, cross-platform (Windows/macOS/Linux)
- `scripts/finish_bundle.sh` — same backbone as a bash script (unix convenience)
- `scripts/package.json` — Babel deps (`npm install` once)
- `references/algorithm.md` — how humanify works and how this mirrors it
- `references/agent-prompt.md` — ready-to-use prompt for fanning out per-module naming agents
