# Changelog

All notable changes are documented here. This project follows
[Conventional Commits](https://www.conventionalcommits.org/) and
[Semantic Versioning](https://semver.org/).

## v1.0.0 — 2026-06-15

### Added
- Initial public release of the **humanify-deobfuscate** Claude Code skill.
- Single-file workflow: `extract_identifiers.mjs` + `apply_renames.mjs` — scope-safe
  AST identifier renaming (Babel `scope.rename`).
- Webpack/browserify **bundle mode**: `split_bundle.mjs` (`list` / `dump` / `chunk` /
  `merge`) with a parallel per-module naming pattern.
- Deterministic post-passes for the parts plain renaming can't reach:
  `rename_exports.mjs` (webpack export-ids `.a`/`.b` → real names) and
  `detect_ts_classes.mjs` (TypeScript class-IIFE constructors + super params).
- **Convergence loop**: `extract_remaining.mjs` surfaces only meaningful residual names.
- One-command deterministic backbone: `finish_bundle.mjs` (cross-platform) and
  `finish_bundle.sh`.
- CI on Ubuntu + Windows (syntax, SKILL.md frontmatter, behavior-preserving smoke test)
  and a release workflow that packages the skill on each `v*` tag.
