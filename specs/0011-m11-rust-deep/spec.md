---
status: shipped
target: M11
date: 2026-08-05
---

# M11: rust deep support (lifecycle + CI workflow + AGENTS.md commands + pre-commit gates)

## Background

Rust is one of the three highest-stakes languages in the AI ecosystem (Python, TypeScript, Rust — the model/tooling/agent runtime layers all converge on it). M6 (spec 0006) deliberately left rust in the detect+audit-only tier ("demand-driven later"); the demand has arrived. The per-stack surface is already small and proven (M6's "one template + one lifecycle map" + M10's generator): adding rust is the same recipe as go — detect already recognizes `Cargo.toml`, audit already under-scores honestly, and the audit's `cfg-lint` config family already includes `rustfmt.toml`. The gaps: transform Stages 2-3 (rust repos currently get the "not supported yet" notice + cross-stack gates only) and the M10 pre-commit generator (no cargo hooks).

Design principles this spec pins (inherited, not new):

- **The stack model is a map, not a branch**: rust joins `[node, python, go, java]` → `[node, python, go, java, rust]` (appended — existing priority order unchanged). One workflow template + one lifecycle map row + one generator section — the M6 "branch hell" mitigation holds.
- **Cargo is the repo's own toolchain** (like go/java): rustfmt/clippy/cargo ship with the toolchain — local system hooks, SKIP'd in CI (the M10 pattern), no managed repos needed.
- **Warn-only softness**: `cargo clippy` without `-D warnings` (errors fail, style warnings don't block) — matches the warn-only gate philosophy; `cargo fmt --check` and `cargo test` are the hard local gates.
- **CI setup uses the community standard**: `dtolnay/rust-toolchain@stable` (verified 2026-08, the de-facto rustup-based setup action; the toolchain ref encodes the version).

## Goal (one sentence)

Rust repositories get the same deep transform as node/python/go/java: a cargo lifecycle (build/test) verified by the CI hard gate, a per-stack `ci-workflow-rust.yml`, AGENTS.md command extraction, and M10-generated pre-commit gates (fmt/clippy/test) — with the "not supported yet" notice now applying only to ruby/php/swift/dotnet.

## Scope

- **Stack model**: `STACK_PRIORITY` = `[node, python, go, java, rust]` (append — existing order and mixed-repo behavior unchanged); rust detected via `Cargo.toml` (already in detect).
- **Lifecycle commands** (local verification + CI hard gate, same trust model): build `cargo build`, test `cargo test`.
- **Stage 2**: `STAGE2_WORKFLOWS` gains `rust: ci-workflow-rust.yml` — modeled byte-for-byte on `ci-workflow-go.yml` except: setup `dtolnay/rust-toolchain@stable`, lint-test = `cargo fmt --check` + `cargo clippy --all-targets` + `cargo test` (warn-only), declared-commands = `cargo build && cargo test`, pre-commit job `SKIP: typecheck,test,cargo-fmt,cargo-clippy,cargo-test`.
- **Stage 3**: `stackCommandsOf` gains rust — `Cargo.toml` → `cargo build` (build) / `cargo test` (test) / `cargo fmt --check` (fmt) / `cargo clippy` (lint), each traceable to the build file.
- **audit `checkAgentsCommands`**: `stackCommandSources` gains rust — `Cargo.toml → cargo build/test` (rust repos can now credit 2/2).
- **M10 generator**: `rustHooks(root)` — `cargo fmt --check` + `cargo clippy --all-targets` (no `-D warnings`) + `cargo test`, local system hooks, `files: \.rs$`, `stages: [pre-commit]`, emitted when `Cargo.toml` present; joined into `generatePreCommitConfig` after go.
- **TOOL_VERSION 0.3.0 → 0.4.0** (feature bump) + `EXPECTED` synced in all **five** workflow templates + docs/08 ledger row + dogfood `sync` (spec 0004/0005 contract).
- **Spec revisions (living doc)**: spec 0006 — rust moves from the unsupported list to the deep tier (goal, scope, acceptance #3 fixture switches to ruby); spec 0010 — acceptance #6's "unsupported stack" fixture switches from Cargo.toml to ruby.

## Non-goals

- ruby/php/swift/dotnet deep support (still detect+audit only + explicit notice — the M6 contract for the remaining four)
- Managed pre-commit repos for rustfmt/clippy (cargo toolchain is the repo's own; deterministic via `rust-toolchain.toml` when the repo pins it)
- Workspace/monorepo cargo workspaces (primary-stack rule applies; `cargo build`/`cargo test` at the root work for the default workspace layout)
- WASM/cross-target lifecycle variants (demand-driven)
- Changing the existing four stacks' behavior

## Acceptance criteria (all must pass for shipped)

1. **Stack selection**: rust fixture (`Cargo.toml`) → `primaryStack` = rust; `stage2Templates` installs `ci-workflow-rust.yml` byte-identical to the template
2. **Priority order**: existing order preserved — a node+rust mixed fixture still picks node (no reorder regression)
3. **Lifecycle**: rust fixture → stage-2 buildCheck command `cargo build` + `cargo test` (declared, verified by the hard gate trust model)
4. **Stage 3**: rust fixture → AGENTS.md command table lists `cargo build` / `cargo test` / `cargo fmt --check` / `cargo clippy`, each traceable to `Cargo.toml`
5. **Audit credit**: rust fixture with AGENTS.md listing `cargo test` → `agents-commands` credits 2/2 (hasBuild+hasTest from Cargo.toml)
6. **Pre-commit gates**: rust fixture → generated config contains `cargo-fmt` + `cargo-clippy` + `cargo-test` local hooks, no `-D warnings` in clippy args, no orphaned hook blocks
7. **Unsupported notice narrows**: ruby fixture (`Gemfile`) → cross-stack gates only, no workflow, "not supported yet" notice (the old Cargo.toml fixture now installs the rust workflow)
8. **Version + EXPECTED**: TOOL_VERSION = baked `EXPECTED` in all five workflow templates; docs/08 ledger row records the bump
9. **Regression**: typecheck + markdownlint + full suite green (52 M10-era tests + new rust fixtures); M6/M10 acceptance re-run; dogfood `sync` applies the 0.4.0 templates
10. **Docs**: SKILL.md stack matrix + stage tables; README stack matrix (bilingual); AGENTS.md status + docs table

## Slice plan

| Slice | Content                                                                                                                                                 | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1     | Spec + stack model (priority/lifecycle/commands/audit credit) + `ci-workflow-rust.yml` + `rustHooks` + TOOL_VERSION/EXPECTED + spec 0006/0010 revisions | [x]    |
| 2     | Acceptance fixtures (workflow/lifecycle/stage-3/audit/pre-commit/ruby-notice) + SKILL.md/README/AGENTS docs + ledger + dogfood + ship                   | [x]    |

## Risks

- `cargo clippy` on legacy repos blocks commits — mitigation: no `-D warnings` (soft); hooks are SKIP-able; the M10 check-only discipline holds
- Cargo workspace layout surprises (root build fails in exotic layouts) — mitigation: `cargo build`/`cargo test` at root is the standard default; warn-only jobs keep failures soft; documented boundary
- Mixed-repo priority shift — mitigation: rust appended last, existing order byte-identical (acceptance #2)
- Template duplication grows (5 workflows) — mitigation: accepted cost of the zero-param verbatim-copy decision (M6 risk, unchanged)
- Scope creep into other four unsupported stacks (non-goals section)
