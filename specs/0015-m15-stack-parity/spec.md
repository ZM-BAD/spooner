---
status: shipped # proposed → approved → in-progress → shipped
target: M15
date: 2026-08-10
---

# M15: stack parity — consumption-point completeness + generator anti-regression

## Background

Four pitfall classes recur because fixes are point-wise and no prevention mechanism gets added:

1. **fresh-deps list lags detect stacks**: every new detect stack re-triggers the false "no dependency manifest" 0-score — `go.sum` → `build.zig.zon` → `pubspec.yaml`+`pubspec.lock` → `Packages/manifest.json` each had to be added by hand after a 0-score surfaced.
2. **audit credit vs generated artifact contradiction**: `stackCommandsOf` missing c/cpp/zig/apple/dart (AGENTS.md "None declared" while audit credits 0.6/1); stage-2 verify phrase "none declared" while the audit credits xcodebuild; AGENTS.md "add real build/test commands" on a stack with no canonical lifecycle (unity ceiling).
3. **auto-fix side effects in gate verification**: `pre-commit run --all-files` silently rewrites 358 / 209 / 119 / 114 / 1961 files on large legacy repos; each run restores and moves on.
4. **template-literal backslash escaping**: `\.` swallowed by the spec (write `\\\`); repeated as a 4-backslash run rendering a double backslash into the generated exclude — plus the test assertion initially copied the wrong implementation.

Root-cause analysis:

- Classes 1-2 are a **design gap**: "stack" has no single source of truth — consumption points are scattered across 7+ sites (`detect.ts MANIFESTS`; `audit.ts` stackCommandSources / stackLintCommandOf / fresh-deps branches / cfg-lint+cfg-format lists / struct-layout; `transform.ts` stackLifecycle / stackCommandsOf / verify + None-declared copy) with no registration and no consistency enforcement. Audit and transform even maintain **two parallel command-source implementations** (DRY violation).
- Class 3 is a **process gap**: the verification command never fixed `SKIP=trailing-whitespace,end-of-file-fixer`, so the known auto-fix behavior re-triggers every round (a documented hint is not a step).
- Class 4 is a **protection gap**: ledger lessons never became code-level guards — escaping stayed manual, assertions were copied from the implementation instead of pinned bytes.

Design principles (inherited, not new):

- **No version chain**: audit/transform logic changes don't touch template bytes — no TOOL_VERSION bump, no EXPECTED sync (spec 0014 precedents).
- **Determinism**: tests assert exact rendered bytes and real-matchability — never derive expectations from the implementation under test.
- **Single source preferred**: one definition of "stack lifecycle commands", consumed by both audit and transform.
- **Coverage or explicit ceiling**: every consumption point either covers a stack or names the documented ceiling — no silent gaps.

## Goal (one sentence)

Add a stack-parity mechanism that makes consumption-point completeness a test-enforced contract (fresh-deps / command sources / lint+format lists), single-sources the audit/transform command definitions, and adds generator anti-regression guards (escape helper + pinned-byte assertions) — so the four pitfall classes fail fast at development time.

## Scope

1. **Consumption-point enumeration**: export the detect stack list as the single enumeration source; each consumption point (fresh-deps branches, stackCommandsOf, cfg-lint/cfg-format lists, audit command source) becomes queryable by stack.
2. **Stack-parity test** (`test/stack-parity.test.ts`): for every detect stack, assert coverage at each consumption point **or** an explicit `ceiling` marker (e.g. unity: no canonical lifecycle; apple: no layout convention). Negative test: removing one stack's fresh-deps branch turns the parity test red. Gaps the test exposes (e.g. ruby/swift/dotnet/harmonyos fresh-deps) are resolved per point: real manifest semantics → add coverage; otherwise → explicit ceiling marker.
3. **Command-source single-sourcing**: one "stack lifecycle commands" definition shared by audit's `stackCommandSources` and transform's `stackCommandsOf` — same data, each consumer formats it its own way (evidence strings vs AGENTS.md table rows); behavior and rendered output stay byte-identical.
4. **Escape helper for generated regexes**: template-literal regex content (check-yaml/check-json excludes) goes through one helper that produces the exact rendered byte; PRE_COMMIT_CORE migrates to it with a byte-identical render check.
5. **Pinned-byte assertion principle**: template-content tests assert exact rendered bytes (manually verified before pinning) plus a "regex really matches the target file" assertion (e.g. the check-json exclude matches `website/tsconfig.json`).
6. **Process fixes** (in-place doc revisions, tracked by this spec): the SKILL.md verification chapter mandates `SKIP=trailing-whitespace,end-of-file-fixer pre-commit run --all-files` for gate verification; the AGENTS.md playbook requires every pitfall to produce a prevention mechanism (test or process step) or record the rejection reason (skill-incorporation review: prevent, not record+patch).

## Non-goals (explicitly out)

- **No full `STACK_DEFS` registry refactor** (all consumption points deriving from one table) — that is a structural refactor of spec 0014's model, evaluated separately (P2 roadmap); this spec delivers the test-enforced contract without the refactor.
- **No semantic-value checking**: parity proves coverage, not that a coverage is _correct_ (a fresh-deps branch with the wrong score still passes) — catching wrong values is out of scope.
- **No format-dimension blind-spot coverage** (tsconfig JSONC / .clang-format multi-doc YAML / PyYAML tags): those are file-format ecology, orthogonal to stacks and unbounded — out of scope.
- **No user-visible behavior change**: scores, evidence strings, and generated bytes stay identical (the escape-helper migration must render byte-equal; single-sourcing must not alter php/ruby/etc. command handling beyond today's behavior).

## Acceptance criteria (verifiable, itemized)

1. `test/stack-parity.test.ts` exists and is green: every detect stack (15) has coverage or an explicit ceiling marker at fresh-deps, command source (audit), stackCommandsOf (transform), cfg-lint/cfg-format lists — enumerated from the detect list, not a hard-coded copy
2. Negative test proven: deleting one stack's fresh-deps branch turns parity red (run, observe, restore)
3. Audit command source and transform `stackCommandsOf` share one definition (single source); full test suite green + installed workflow mirrors byte-equal (parity tests unchanged)
4. PRE_COMMIT_CORE regex content is produced by the escape helper; rendered exclude bytes identical to the pre-migration render (verified by the existing byte assertions)
5. Template-content assertions pin exact rendered bytes (no derivation from the implementation) and include a real-match assertion for regex excludes
6. SKILL.md verification chapter includes the SKIP auto-fix command; AGENTS.md playbook includes the prevention-mechanism rule
7. Regression: typecheck + markdownlint + full suite green; determinism double-run diff empty
8. No TOOL_VERSION change; no template-bytes change (installed workflow/pre-commit parity stays green)

## Slice plan (each slice independently verifiable)

| Slice | Content                                                                                      |
| ----- | -------------------------------------------------------------------------------------------- |
| 1     | Consumption-point enumeration + stack-parity test (coverage/ceiling markers + negative test) |
| 2     | Command-source single-sourcing (byte-identical behavior, parity-green)                       |
| 3     | Escape helper + PRE_COMMIT_CORE migration (byte-identical render check)                      |
| 4     | Pinned-byte + real-match assertions on template content                                      |
| 5     | Process fixes: SKILL.md verification chapter + AGENTS.md playbook + HANDOFF note             |

## Risks

- **Parity test rigidity**: a future stack legitimately without a fresh-deps manifest would trip the test — mitigated by the explicit `ceiling` marker mechanism (test asserts "coverage or ceiling", never "coverage" alone)
- **Single-sourcing output drift**: audit evidence strings vs AGENTS.md rows differ in shape — mitigated by keeping data/format separate and letting the full suite + the installed-workflow parity guard the bytes
- **Escape helper changing rendered bytes**: migrating PRE_COMMIT_CORE must render byte-equal — the existing preCommit/installed-config byte assertions verify it before any content change
- **Tests copying implementations again**: pinned-byte principle (manually verify first, then pin) + real-match assertions make copy-errors fail loudly
