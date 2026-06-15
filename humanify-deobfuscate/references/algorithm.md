# How humanify works (and how this skill mirrors it)

humanify is an LLM-powered JS un-minifier. Its crucial design decision is that **the LLM
never edits code** — it only suggests one name at a time. All correctness comes from a
compiler-grade AST pipeline. This skill reproduces that split with Babel + you-as-renamer.

## humanify's pipeline (Rust, oxc)

1. **Parse** the source to an AST (`oxc_parser`). Bail out with a parse error if it isn't
   valid JS.
2. **Semantic analysis** (`oxc_semantic::SemanticBuilder`) builds the scope tree and a
   **symbol table**. Every *binding* becomes a unique `SymbolId`. Two variables both named
   `a` in different scopes are different symbols — this is what makes renaming safe.
3. **Order bindings largest-scope-first.** For each symbol it finds the span of the
   scope-introducing ancestor (the function/block that owns the binding), then sorts by
   that scope's size descending, ties broken by source position. Outer, longer-lived names
   are decided before inner ones.
4. **Context window.** For each symbol it slices the source of that symbol's scope block.
   If the slice exceeds `context_size`, it windows around the identifier (top-level
   bindings window within the whole file; inner bindings get only their local scope). The
   model sees relevant usage, not the entire file.
5. **One LLM call per identifier.** System prompt: *"You are a senior software engineer
   reviewing minified or obfuscated JavaScript. Assign a single descriptive identifier name
   based on how the variable is used in the surrounding code. Return JSON only."* The user
   message includes the context window + the current name and asks for a replacement, with
   rules: camelCase vars/funcs, PascalCase classes, ASCII identifier chars, avoid reserved
   words, keep already-meaningful names. The response is constrained to JSON `{ "name": ... }`.
6. **Normalize the name** (`safe_name::to_identifier`): collapse `.`, `-`, space into
   camelCase; drop illegal characters; prefix `_` if the result is empty, starts with a
   digit, or is a reserved word.
7. **Resolve collisions:** if the normalized name is already taken in that scope (or used
   by another rename this run), prefix `_` until it's free.
8. **Apply in the symbol table**, not by text: `scoping.rename_symbol(...)`. Because codegen
   reads names from the scope model, every declaration and reference updates together.
9. **Codegen** (`oxc_codegen`) regenerates readable source from the AST + renamed scoping.

Robustness details worth knowing:
- It uses a **strategy "ladder"** for the JSON call (native structured output, tool-call,
  prompt-and-parse) so it works across providers; on any failure it **falls back to the
  original name** rather than corrupting output.
- Truncation snaps to **UTF-8 char boundaries** so multibyte chars near a window edge don't
  split (regression test for issue #747).
- Class methods, object property keys, and private fields are **not** bindings in the
  rename set, so they're preserved.

## How this skill maps onto that

| humanify (oxc, Rust) | this skill (Babel, Node + you) |
|---|---|
| `oxc_parser` parse | `@babel/parser` parse (`extract`/`apply`) |
| `oxc_semantic` symbol table | Babel `path.scope.bindings` |
| largest-scope-first ordering | `extract_identifiers.mjs` sorts by scope size |
| per-symbol context window | `context` field, windowed by `CONTEXT_SIZE` |
| one LLM call returning `{name}` | **you** read `context` and choose names |
| `safe_name` normalize + `_` collisions | `scope.generateUid` on collision in `apply` |
| `rename_symbol` + codegen | `scope.rename` + `@babel/generator` |
| ladder fallback to original name | omit a `pos` from `renames.json` to leave it as-is |

The one meaningful difference: humanify renames **one identifier per LLM call** with only
local context, because it's calling an API in a loop. You can see the *whole* file and name
many bindings in one pass with global understanding — often producing more coherent names
(consistent terminology across related functions). The AST scripts guarantee that whatever
names you pick are applied correctly.

## Why not just let the model rewrite the file?

Because text-level rewriting silently breaks on:
- **Shadowing** — inner `e` vs outer `e`; a blind replace merges them.
- **Collisions** — renaming `a`→`data` when `data` already exists in scope.
- **Look-alikes** — a property `obj.a` or string `"a"` must not change when variable `a` does.

Scope-aware renaming via the symbol table is the only way to be safe, which is why both
humanify and this skill route every rename through the AST.
