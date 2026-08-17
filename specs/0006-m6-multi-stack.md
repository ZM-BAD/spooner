---
status: shipped
target: M6
date: 2026-08-04
---

# M6: multi-stack transform (node / python / go / java / rust)

## Background

Transform supports the mainstream stacks: Java/Spring, Go, Python, React/Vue/Next. React/Vue/Next are node-stack (package.json tooling); the stack families are **python, go, java (Maven + Gradle)**, plus rust in the deep tier (spec 0011 — one of the three AI-stakes languages). `detect.ts` recognizes all of them (9 stacks), `audit.ts` scores any stack (under-estimates, never over-estimates — verified on a synthetic Java repo), and Stage 4 is stack-agnostic. The gaps are transform Stages 2-3, which are node-only: Stage 2 silently installs npm gates on non-node repos (the known ⚠️ — the npm CI workflow breaks non-node CI), and Stage 3's AGENTS.md command table is empty for non-node repos. The "branch hell" risk (decision #4) is mitigated by a deliberately small per-stack surface: one workflow template + one set of standard lifecycle commands per stack, verified by the CI hard gate — the same trust model as package.json scripts (a command is "real and executable" because the gate actually runs it). **Publish contract (version-ledger rule 五.6)**: template set changes require a TOOL_VERSION bump (feature bumps recorded in the ledger). **This spec pins the stack model, the per-stack lifecycle commands, and the unsupported-stack notice — the slices must implement exactly this, no drift.**

## Goal (one sentence)

For any node / python / go / java / rust repository, transform installs stack-correct gates and generates an AGENTS.md with executable, traceable commands; other detected stacks get an explicit "not supported yet" notice instead of silent npm gates.

## Scope

- **Stack model**: `primaryStack(root)` — first of `[node, python, go, java, rust]` present in `detect(root).stacks` (node first: JS frameworks and mixed repos; rust appended in M11, spec 0011). Multi-stack repos get one primary workflow; cross-stack gates apply to all.
- **Stage 2 — stack-aware**:
  - Cross-stack gates (unchanged, installed for every stack): `.commitlintrc.json`, `.pre-commit-config.yaml`, `.markdownlint-cli2.yaml`
  - Per-stack workflow → `.github/workflows/ai-native.yml`: `templates/ci-workflow-{node,python,go,java}.yml` (renamed from `ci-workflow.yml`), chosen by `primaryStack`. Job structure shared across stacks: `pre-commit` (warn-only, incl. a commit-msg commitlint check on the last commit), `lint-test` (warn-only, stack commands), `security` (warn-only, gitleaks), `declared-commands` (hard gate, stack lifecycle), `manifest-consistency` (hard gate, baked `EXPECTED`). The three non-node workflows are generated from the node template so the shared jobs stay byte-identical across stacks
  - **Lifecycle commands** (per stack; local verification and the CI hard gate run the same set):
    - node: declared build/test families from package.json (existing behavior, unchanged)
    - python: `python -m unittest discover` (stdlib — deterministic; no pytest dependency; pytest repos keep working, the gate verifies executability not coverage)
    - go: `go build ./...` + `go test $(go list ./... | grep -v /test/e2e)` (e2e-aware — a test/e2e dir holds integration specs needing live infra; without one the pipeline is behavior-identical to `go test ./...`; a plain `go test ./...` would sweep 60 Ginkgo e2e specs into the gate)
    - java: `./mvnw -q -B test` if the wrapper exists else `mvn -q -B test`; `./gradlew build` if a gradle project is present (`build.gradle(.kts)` at the root, or `settings.gradle(.kts)` — kotlin/Android module layouts keep their build files in module dirs; wrapper preference, runner-provided maven/gradle fallback); the local `java-test` hook trigger set includes `.kt`/`.kts`
    - rust: `cargo build` + `cargo test` (spec 0011)
  - **Unsupported / unknown stacks** (ruby, php, swift, dotnet, none): cross-stack gates installed; the workflow is **not** installed; the stage message says "stack X: transform not supported yet — audit works; supported stacks: node/python/go/java/rust" (fixes the silent-npm-gates ⚠️)
  - **Wrong-stack workflow conflict**: if the installed workflow's bytes match a different stack's template, it's reported as `conflict` with a hint naming the installed stack (delete it and re-run)
- **Stage 3 — per-stack AGENTS.md commands**: node (package.json scripts, existing) + Makefile (all stacks, existing); java: `pom.xml` → `mvn compile` / `mvn test`, `build.gradle` → `gradle build` / `gradle test`; go: `go.mod` → `go build ./...` / e2e-aware `go test` / `go vet ./...`; python: `pyproject.toml` or `requirements.txt` → `python -m unittest discover`
- **audit.ts `checkAgentsCommands`**: command sources extended — AGENTS.md command table entries verified against package.json scripts / Makefile targets / per-stack lifecycle (go/mvn/gradle/unittest when the build file exists) — non-node repos can now credit `agents-commands`
- **sync.ts**: template comparison is stack-aware — `templateFor` resolves the workflow template by `primaryStack` (a python repo's workflow is compared against the python template)
- **TOOL_VERSION 0.2.0** + local version-ledger row + `EXPECTED` constant updated to 0.2.0 in all four workflow templates (rule 五.7)

## Non-goals

- rust/ruby/php/swift/dotnet transform support was detect + audit only (explicit notice); **rust moved to the deep tier in M11 (spec 0011)** — ruby/php/swift/dotnet remain demand-driven later
- Per-tool deep detection (ruff/black/eslint/prettier per-stack config families) — branch hell, decision #4's red line holds; `cfg-lint` keeps its current config families (non-node repos under-score honestly)
- Multi-stack monorepo workflows (primary stack only, documented)
- LLM semantic layer, batch gating, score-delta gating — existing non-goals hold
- Changing Stage 4 (already stack-agnostic) or the cross-stack gate templates

## Acceptance criteria (all must pass for shipped)

1. **Stack selection**: `primaryStack` priority node > python > go > java > rust; per-stack fixtures install the matching workflow byte-identical to its template
2. **Node regression**: a node fixture behaves exactly as before M6 (workflow content, npm verification, drift gate present)
3. **Unsupported notice**: a ruby fixture → stage 2 installs the three cross-stack gates, does **not** install a workflow, and the message says "not supported yet" with the supported list (a rust fixture now installs the rust workflow — spec 0011)
4. **Stage 2 verification per stack**: go fixture → buildCheck command `go build ./...` + the e2e-aware `go test` green before/after; python fixture → `python -m unittest discover` green; java pom fixture → `mvn -q -B test` green (toolchains installed locally)
5. **Stage 3 per stack**: go/java/python fixtures → AGENTS.md command table lists the stack lifecycle commands, each traceable to the build file
6. **Audit credits per-stack commands**: a go fixture whose AGENTS.md lists the e2e-aware `go test` → `agents-commands` evidence; the score reflects it (no longer always 0/2 for non-node)
7. **sync stack-aware**: a python fixture with a stale version + differing workflow bytes → `outdated` and apply restores the **python** template bytes (not the node template)
8. **Version + EXPECTED**: TOOL_VERSION equals the baked `EXPECTED` in all four workflow templates; local version-ledger row records the bump
9. **Drift gate regression**: the M5 gate scenarios still pass against the node workflow template (extracted script: green / drift / no-manifest / stale / bad-schema)
10. **Detect/audit unchanged**: 9 stacks recognized; non-node audit under-scores only (no over-estimation)
11. **Docs**: SKILL.md stack matrix + stage-2/3 tables; README stack support matrix (bilingual); AGENTS.md status
12. **Green**: check-yaml + markdownlint + `agentskills validate`; M4/M5 acceptance suites re-baselined to 0.2.0 and re-run

## Slice plan

| Slice | Content                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Stack model (`primaryStack`, lifecycle commands) + four per-stack workflow templates + stage-2 selection + unsupported notice + wrong-stack conflict hint + TOOL_VERSION bump + ledger + sync stack-aware `templateFor` |
| 2     | Stage 3 per-stack AGENTS.md extraction + audit `checkAgentsCommands` per-stack command sources                                                                                                                          |
| 3     | SKILL.md/README/AGENTS/ROADMAP/HANDOFF sync + per-stack fixtures acceptance + ship                                                                                                                                      |

## Risks

- Branch hell creep (mitigation: fixed 4-stack map + lifecycle commands only — no per-tool detection; a new stack = one template + one map row, documented in the spec)
- Lifecycle command fails on a real repo (mitigation: conservative stdlib choices — `python -m unittest` not pytest; wrapper preference `./mvnw`/`./gradlew`; the gate is the verification, and warn-only jobs keep the failure soft)
- Workflow rename breaks existing installs' sync (mitigation: stack-aware `templateFor`; node repos resolve to the renamed template; M4/M5 suites re-baselined in acceptance)
- Multi-stack repos (mitigation: primary-stack rule documented; cross-stack gates still apply to all)
- Template duplication across four workflows (mitigation: accepted cost of the zero-param verbatim-copy decision; jobs are small and copied verbatim, including the drift gate)
