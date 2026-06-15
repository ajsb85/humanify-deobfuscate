# Per-module naming agent prompt

When deobfuscating a bundle, fan out one subagent per module (or per chunk for giant
modules). This prompt is tuned from a real 124-module run: the earlier, vaguer version
made agents *too conservative* — they skipped class names and parameters, which forced
extra cleanup rounds. The MUST-name checklist below fixes that, so the first pass is
thorough and convergence is fast.

For very small modules, batch several into one agent (4–6 each); tell it to process each
independently and write one map per module.

---

```
Deobfuscate ONE module from a webpack-bundled JS library (TypeScript-compiled then
minified). <optional 1-line context, e.g. "It's a PCB/schematic CAD library.">

Read BOTH:
- Source (for context):  <abs>/work/mod_<idx>.src.js
- Bindings to name:      <abs>/work/mod_<idx>.bindings.json   ([{pos,name,kind,line}, ...]
  keyed by `pos` = byte offset)

Infer the module's purpose from its strings/methods, then name bindings by how they're
USED. Write a {"pos":"name"} map and return a one-line summary.

MUST name (these were the misses last time — do NOT skip them):
- EVERY class and function declaration name — including the inner constructor of a class
  IIFE `var X = (function(_s){ __extends(e, _s); function e(){} return e })(Base)` (name
  `e` after the holder `X`).
- EVERY constructor and method PARAMETER (they're the API surface).
- Imported module aliases `var x = r(N)` — name `x` by how it's used (its `.a`/`.b`
  members are webpack export ids, leave them; a later pass handles those).
- Locals referenced 2+ times that carry meaning.

OMIT (leave unchanged) ONLY genuine scaffolding:
- TypeScript helper internals: __extends / __values / __read / __spread / __assign /
  __awaiter / __generator, and the `setPrototypeOf` params inside them.
- Iterator-protocol scratch: a var whose ONLY job is to drive a `.next()` / `.done` /
  `.return` loop.
- try/finally error/return holders: the `e_1 = {error: ...}` and the `.return` holder.
- Names that are already meaningful or conventional (`i` loop index, `x`/`y` coords).

Naming style: camelCase for variables/functions, PascalCase for classes/constructors.
Keys = `pos` as a STRING. Don't worry about collisions — apply prefixes `_` to resolve.

BEFORE returning: re-scan your map vs the binding list — for every single-letter class
name, function name, or parameter you did NOT include, confirm it's genuine scaffolding;
otherwise name it.

Output:
1. Write ONLY valid JSON to <abs>/work/mod_<idx>.renames.json
2. Return ONE line: `mod <idx>: <what the module does> — named N/total bindings`
```

---

## After the agents finish — the deterministic backbone

Don't hand-run the merge/apply/post-passes; the driver does them in the correct order:

```bash
# collect every per-module map into one cumulative file:
node <skill-dir>/scripts/split_bundle.mjs bundle.js merge work renames_all.json [base.json]
# apply binding map + export-ids + TS-classes + verify + report remaining, in one shot:
bash <skill-dir>/scripts/finish_bundle.sh bundle.js renames_all.json readable.js
```

Then run the convergence loop (SKILL.md → "Refining to convergence") on
`readable.js.remaining.json` until a round names < ~5.

Practice notes:
- Agents **writing to a file** (not returning the map as text) is far more reliable at
  scale; `merge` collects them uniformly. Maps never conflict (disjoint offsets).
- Cleanup-loop maps are keyed to the CURRENT readable file (post-rename offsets), so
  apply them as a separate stage — do NOT merge them back into the original-keyed map.
- "Done" = single-letter tokens stop dropping; the residual is iterator/try-finally
  scaffolding that is correct to leave (expect ~⅓ of bindings to remain short).
