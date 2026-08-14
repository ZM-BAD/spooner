---
status: shipped
target: M10
date: 2026-08-05
---

# M10: contextual gates — stack-aware pre-commit generation + hook-tool routing

## Background

The installed Stage-2 gate set is one universal `.pre-commit-config.yaml` template for every repo — cross-stack core (file hygiene, markdownlint, gitleaks, commitlint) **plus hard-coded Node local hooks** (`typecheck`/`test` declared-only wrappers). Two real-world findings expose the gap:

- **A Python + Node monorepo** runs a deeply stack-aware config: `backend/` → ruff + pylint (--fail-under=9) + pip-audit + pytest; `frontend/` → lint-staged + eslint + prettier + tsc + vitest + npm ci + build; `specs/` → markdownlint + spec validation; commitlint on commit-msg. Its 7 CI workflows mirror the local hooks (CI parity is a design goal). Its anti-patterns: auto-fix (`--fix`/`--write`) and `pip install --upgrade <tool>` hooks — non-deterministic, against our philosophy.
- **A pure-TypeScript browser extension** does **not** use pre-commit at all — it uses **husky + lint-staged** (npm-native: `"prepare": "husky"` installs hooks on `npm install`, no Python runtime needed).

The pattern: **hook tool follows the repo's ecosystem** (pre-commit = Python-native, husky = Node-native) and **the hook set follows the stack's actual tooling**. Our current transform is blind to both — a pure-Node repo gets a Python-dependent gate file (dead or foreign), a Python repo gets Node hooks that skip via declared-only masking, and no repo gets its stack's real lint/format/test gates locally. This is the same class of error M8 fixed for CI platforms (`.github/workflows` on GitLab = dead file) — but applied to git hooks, it is still unfixed.

Design principles this spec pins:

- **What audit credits, transform installs**: the generator mirrors the audit's tool detection (`cfg-lint`/`cfg-format`/`cfg-test`/`cfg-hooks`) — one detection source, and audit → transform parity becomes visible.
- **No dead hooks**: a hook is emitted only for tooling actually detected in the repo (eslint config present → eslint hook; tsconfig → tsc; pyproject + tests → ruff + pytest). Tool-absent → hook absent. The declared-only discipline (CI lint-test job, existing local hooks) extends to the whole config.
- **Deterministic and check-only — with one deliberate exemption**: rev-pinned hook repos (pre-commit installs pinned versions), no `--fix`, no `--write`, no `upgrade-to-latest` hooks (monorepo anti-patterns). A hook may fail a commit; it may never mutate files or versions. **The sole exemption is prettier**: a repo declaring prettier gets a LOCAL `--write` hook running the project's own prettier (`node_modules/.bin/prettier`) — prettier is a deterministic formatter (same input → same output, unlike eslint/ruff `--fix`), auto-formatting is what the developer would run anyway, and a `--write` hook is the industry norm for prettier. The local form is deliberate: the mirrors-prettier managed hook lags prettier releases (v3.1.0 max at the time of writing vs 3.9.x in the wild), which would re-introduce the check-set mismatch the hook exists to close. A missing `node_modules` is not a failing build (pip-audit pattern): skip with an explicit notice; CI's declared lint remains the hard check. **SKILL.md authors** (a SKILL.md at the root or under `skills/`) additionally get a local skills-ref validation hook (same missing-tool skip pattern) — the CI-only spec check becomes local.
- **Same M8 treatment for hook tools as for CI platforms**: the probe gains the hook-tool question; a repo whose owner keeps husky/lefthook (or an existing hook tool) gets a skip with an explicit notice — never a foreign gate file.
- **The config becomes a generated artifact** (AGENTS.md class, spec 0004): deterministic generation at transform time; sync reports "generated — re-run transform stage 2", never byte-compares; the manifest records it with `templateVersion`.

## Goal (one sentence)

Stage 2 generates a stack-aware, tooling-detected pre-commit config (cross-stack core + the repo's real lint/format/typecheck/test gates, check-only, rev-pinned) and routes the hook tool from probed context — pre-commit installs it, husky/lefthook/keep-existing repos get a skip with an explicit notice.

## Scope

- **Probe extension (SKILL.md + spec 0008 revision)**: the context questionnaire gains a 6th question — "Which git-hook tool does this repo prefer? pre-commit / husky / lefthook / keep the existing setup". Modes unchanged (full / no-workflow / audit-only); hook-tool routing happens inside Stage 2 of full mode.
- **Detection (transform.ts)**: reuse the audit's tool signals — lint configs (eslint.config.*, .pylintrc, ruff/pyproject, golangci), formatters (prettier, ruff format), test frameworks (pytest/vitest/jest/unittest/go test/mvn), typecheck (tsconfig), package scripts; plus hook-ecosystem signals (`.husky/` directory (husky v7+) or `husky` devDependency + `husky` package.json field (v4) → husky; existing `.pre-commit-config.yaml` → pre-commit; `lefthook.yml` → lefthook; `yorkie` devDependency + `yorkie` package.json field, or the legacy `gitHooks` field (vue-cli 2/3 schema yorkie reads) → yorkie). A bare dependency name without hooks configuration is a **dead dependency** (husky in devDependencies, no `.husky/`, no field — vue2 upgrade leftovers) and does NOT skip the gate install.
- **GitHub reachability**: the generated config's hook repos are fetched from GitHub when pre-commit runs — with GitHub unreachable (no mirror/proxy), pre-commit cannot prepare the hook environment and commits are **blocked**. The generated header documents this; it is the tool's architecture, not a config bug — CI (GitHub Actions) is unaffected.
- **Generator `generatePreCommitConfig(root)`** (deterministic, zero-dependency):
  - **Cross-stack core (always)**: file hygiene (trailing-whitespace, end-of-file-fixer, check-yaml/json/merge-conflict/added-large-files/symlinks), markdownlint-cli2, gitleaks, commitlint (commit-msg stage) — all rev-pinned.
  - **Stack gates (only when tooling detected)**, check-only, `stages: [pre-commit]`:
    - python: ruff + ruff-format (`astral-sh/ruff-pre-commit` rev v0.16.1, managed — runs in CI too, no SKIP) + pytest (local system hook, if pytest config/tests dir) + pip-audit (local, if requirements*.txt)
    - node: eslint (`pre-commit/mirrors-eslint` rev v10.0.3, `--max-warnings 0`, managed, `types: []` — the repo-scoped js/ts files pattern decides; mirrors-eslint's javascript default would filter .ts out, if eslint config) + typecheck (local, `npx tsc --noEmit` when tsconfig exists, else the declared typecheck-script wrapper) + test (local, declared script)
    - go: gofmt -l + go vet ./... + go test (local system hooks, if go.mod)
    - java: local `mvn -q -B test` / `gradle build` hook (if pom.xml / build.gradle)
    - rust: cargo fmt --check + cargo clippy --all-targets (no `-D warnings` — soft) + cargo test (local system hooks, if Cargo.toml; spec 0011)
    - **local stack hooks are SKIP'd in the stack workflow templates** (CI pre-commit job has no repo toolchain — same mechanism as `typecheck,test`): python adds `pytest,pip-audit`, go adds `gofmt,go-vet,go-test`, java adds `java-test`; node adds `eslint` (managed — its config deps like typescript-eslint resolve from repo node_modules, which the CI pre-commit job lacks; lint runs in lint-test); managed hooks (ruff/eslint) run in CI without SKIP
    - mixed stacks (e.g. python + node at the repo root): file-type scoped `files:` patterns (`\.py$` vs `\.[jt]sx?$`) combining the stacks' hooks; subdirectory scoping (monorepo-style `^frontend/`) is a **documented boundary** — consistent with detect's root-only scan (spec 0008), demand-driven later
  - **Routing** (mirrors CI-platform routing): probe answer or detected ecosystem → pre-commit → install the generated config; husky/lefthook/keep → **skip the config with an explicit notice**, manifest records what was actually installed; existing differing config → `conflict` (never overwrite) — **unless the installed bytes equal the pre-M10 universal template (tool-owned) → `write` (upgrade, not conflict)**; unsupported stack → cross-stack core only (current behavior, now generated).
- **Manifest / sync / drift-gate contract (spec 0004 revision)**: the pre-commit config joins the `generated` class (AGENTS.md/CLAUDE.md): manifest records file + `templateVersion`; sync reports `generated` and points at `transform --stage 2`; the CI drift gate still checks existence.
- **TOOL_VERSION bump** (generator ships new behavior + config bytes change): bump + baked `EXPECTED` sync in the workflow templates + a `docs/08` ledger row (spec 0004/0005 contract).
- **SKILL.md**: stage-2 procedure gains the hook-tool question, the "config is generated — re-run stage 2 to regenerate" note, and the verify step already covers real execution (`pre-commit run --all-files`).

## Non-goals

- husky/lefthook **config generation** (v1 answer = skip + notice; generation is demand-driven — WXT-repo evidence documented, not shipped)
- Auto-fix hooks (`--fix`, `--write`, `--update`) — deterministic check-only is a hard line (monorepo anti-pattern)
- Tool-level config detection beyond the audit's existing signals (decision #4 red line)
- Monorepo multi-stack beyond python+node (monorepo-style directory routing for other combinations — demand-driven)
- pre-push stage (community convention splits heavy checks to pre-push; our "green pre-commit implies green CI" guarantee keeps the declared test in pre-commit)

## Acceptance criteria (all must pass for shipped)

1. **Python routing**: fixture with pyproject + pytest config + requirements → config contains ruff + ruff-format + pytest + pip-audit hooks, **no** eslint/tsc hooks
2. **Node routing**: fixture with eslint.config + tsconfig + `test` script → config contains eslint (`--max-warnings 0`) + tsc --noEmit + declared test hooks, **no** ruff/pylint
3. **Tool-absent discipline**: fixture with package.json but no eslint/tsconfig → cross-stack core only, **no dead hooks**
4. **Go routing**: fixture with go.mod → gofmt -l + go vet + go test hooks
5. **Java routing**: fixture with pom.xml → local `mvn -q -B test` hook
6. **Unsupported stack**: fixture with a ruby `Gemfile` → cross-stack core only + explicit notice (rust moved to the deep tier in spec 0011)
7. **Husky routing**: fixture with `.husky/` + `husky` in package.json + probe answer "keep husky" → pre-commit config **not** installed, explicit skip notice, manifest records the decision
8. **Conflict vs legacy upgrade**: existing `.pre-commit-config.yaml` with user-edited content → `conflict`, never overwritten; existing bytes **equal to the pre-M10 universal template** → `write` (tool-owned upgrade path)
9. **Determinism**: two runs on the same fixture → byte-identical config
10. **Check-only**: generated config contains no `--fix`/`--write` args and no upgrade hooks (asserted on all fixture outputs)
11. **Sync class**: manifest-recorded generated config → sync reports `generated` ("re-run transform stage 2"), never byte-compares
12. **Audit parity**: after install, `cfg-hooks` scores 1/1 (gate-active — hooks actually installed)
13. **Spec revisions**: spec 0002 Stage-2 contract gains the generated-config + hook-tool routing rule; spec 0008 probe gains the hook-tool question; spec 0004 generated class gains the pre-commit config
14. **Regression + contract**: typecheck + markdownlint + full suite green; TOOL_VERSION bumped with EXPECTED sync + docs/08 ledger row; stack workflow templates' SKIP lists extended per stack (python: pytest,pip-audit / go: gofmt,go-vet,go-test / java: java-test); **self-apply**: stage-2 dry-run on this repo reports its own config as `conflict` (the repo-specific manifest-consistency hook is user-owned — the red line working as designed), while the legacy-upgrade path and determinism are covered by dedicated fixtures

## Slice plan

| Slice | Content                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------- |
| 1     | Spec + SKILL.md probe question (hook tool) + spec 0008 revision                                     |
| 2     | transform.ts detection + `generatePreCommitConfig` + routing + spec 0002 revision                   |
| 3     | Manifest/sync generated class + TOOL_VERSION bump + acceptance fixtures + spec 0004 revision + ship |

## Risks

- Over-generation (detecting tooling that doesn't run) — mitigation: generation mirrors the audit's proven detection; hooks are check-only and rev-pinned; determinism fixtures guard the matrix
- Dead hooks on tool-absent repos — mitigation: acceptance #3 (tool-absent → no hook); the declared-only wrapper pattern for script hooks
- Pure-Node repos forced onto Python-dependent pre-commit — mitigation: probe routes to skip + notice (WXT-repo evidence); husky generation stays a documented demand-driven candidate
- Auto-fix configs leaking in from community examples — mitigation: acceptance #10 asserts check-only on every fixture
- Scope creep into husky generation / multi-stack combos / pre-push stages (non-goals section)
