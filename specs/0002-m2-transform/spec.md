---
status: shipped
target: M2
date: 2026-08-04
---

# M2: transform (in-place readiness upgrade: gates → AGENTS.md → SDD)

## Background

M1 ships the audit: deterministic scoring + report. M2 ships the other half of the product identity (decision #10: an "execute" plan, not a "suggest" plan — score, then fix in place; every step verified, rollback-able). Design basis: the internal scope archive (docs/02 §2/§5/§6, local-only) and the decision log (#2 maturity gating replaces init; #6 AGENTS.md single source + CLAUDE.md symlink; #7 .ai-native.yml manifest). **This spec pins the transform workflow, the per-stage outputs, and the manifest schema — the slices must implement exactly this, no drift.**

## Goal (one sentence)

For a mature repository, upgrade its AI coding readiness in place through three verified, confirmable, rollback-able stages (gates → agent files → SDD), each leaving the build green, with a manifest recording what was installed.

## Scope

- Agent-driven workflow: Stage 1 = audit (existing, M1) → plan → user confirms the stage order → stages 2-4 applied one at a time, each verified + confirmed
- Stage 2 gates installer: commitlint + pre-commit (markdownlint + gitleaks) + a new CI workflow (warn-only quality jobs + declared-commands hard gate + a commit-msg commitlint check on the last commit; the manifest-consistency hard gate ships separately); warn-only defaults, build stays green. **After apply, the agent installs the git hooks**: `pre-commit install --hook-type commit-msg` — plain `pre-commit install` installs only the pre-commit stage and leaves the commitlint hook dead (a config file alone is not an active gate; spec 0001's `cfg-hooks` scores only installed hooks)
- Stage 3 agent files: AGENTS.md generated from real commands (package.json scripts / Makefile / CI), ≤200 lines / <40K chars; CLAUDE.md symlink (Windows: `@AGENTS.md` import)
- Stage 4 (optional) SDD: `docs/sdd/` templates (spec/plan/tasks), AGENTS.md workflow convention, optional CI spec-existence gate
- `.ai-native.yml` manifest: written/updated by every applied stage; consistency verification
- `transform.ts` CLI: `--root` / `--stage 2|3|4` / `--dry-run` / `--format json|markdown`; zero-build, zero-dependency (Node >= 22.18)
- SKILL.md: full transform instructions + examples (slice 5)

## Non-goals

- `check` (drift detection as a repeatable health check) — future spec; only manifest consistency verification ships here
- `upgrade` (template version updates) — v2 candidate
- Python/Go/Rust deep support: generic templates + explicit "not supported yet"
- LLM semantic layer (gates stay deterministic, decision #5)
- Writing business code / refactoring
- init mode (decision #2): skeleton repos get the "too early" response from Stage 1
- Non-git repos (git is required for verification and rollback)

## Workflow contract (agent-driven)

| Step | Actor | Output |
|---|---|---|
| Stage 1 audit | script (M1) | report + plan; skeleton → "too early", stop |
| Confirmation | agent + user | stage order agreed; every stage needs explicit confirmation before apply |
| Stage 2/3/4 apply | transform.ts | dry-run diff shown first, then apply; build-green verified before + after; manifest updated |
| Rollback | agent | every stage's changes are git-visible; rollback = `git restore` of the listed files (documented per stage) |

## Per-stage outputs (pinned)

### Stage 2 — gates (warn-only, never breaks the build)

| Output file | Source template |
|---|---|
| `.commitlintrc.json` (if absent) | `templates/commitlintrc.json.tpl` |
| `.pre-commit-config.yaml` (if absent) | `templates/pre-commit-config.yaml.tpl` (markdownlint + gitleaks + hygiene hooks) |
| `.markdownlint-cli2.yaml` (if absent) | `templates/markdownlint-cli2.yaml.tpl` |
| `.github/workflows/ai-native.yml` (new file, never edits existing CI) | `templates/ci-workflow.yml.tpl` (warn-only lint/test/security jobs + declared-commands hard gate + a commit-msg commitlint check on the last commit) |

Rules: existing configs are never overwritten without explicit user confirmation (conflicts are reported, not silently replaced); CI lint/test jobs default to warn-only so a pre-existing failing lint can't hard-fail the repo. The declared-commands gate runs self-contained families only (`build/compile/typecheck/test/spec`) — never meta commands (`check`/`verify`) that chain external tooling missing from a clean CI checkout. The node lint-test job runs **declared scripts only** (`lint`/`test` when they exist; undeclared scripts are skipped, not failed) — the same trust model as the declared-commands gate; the stack workflows (python/go/java) use standard stack commands that always exist. The commit-msg commitlint check writes the last commit into `.git/COMMIT_EDITMSG` and runs `pre-commit run --hook-stage commit-msg --commit-msg-filename .git/COMMIT_EDITMSG` (the filename argument is required by pre-commit for this hook stage). After apply, install the git hooks so commitlint actually enforces: `pre-commit install --hook-type commit-msg` (commitlint runs on the commit-msg stage, which plain `pre-commit install` misses).

### Stage 3 — agent files

- AGENTS.md: generated from README + CI + manifests via **real-command extraction** (package.json scripts / Makefile / CI steps); the command block only contains traceable commands; ≤200 lines / <40K chars
- CLAUDE.md: symlink → AGENTS.md; on Windows (symlink unavailable): a real file containing `@AGENTS.md`
- Existing AGENTS.md: never overwritten without explicit user confirmation

### Stage 4 — SDD (optional)

- `docs/sdd/`: `spec.md` / `plan.md` / `tasks.md` templates (from `templates/sdd/`)
- AGENTS.md: spec-driven workflow convention appended
- Optional CI gate: spec-file existence check

## Manifest `.ai-native.yml` (pinned schema v1)

```yaml
schemaVersion: 1
tool: spooner
version: "0.2.1"
stages:
  2:
    date: "2026-08-04"
    warnOnly: true
    files: [".commitlintrc.json", ".pre-commit-config.yaml", ".markdownlint-cli2.yaml", ".github/workflows/ai-native.yml"]
  3:
    date: "2026-08-04"
    files: ["AGENTS.md", "CLAUDE.md"]
```

Idempotent: re-running an installed stage reports "already installed" and writes nothing.

## Acceptance criteria (all must pass for shipped)

1. **Dry-run purity**: `transform.ts --stage 2 --dry-run` writes nothing (git status unchanged); two identical dry-runs produce identical output
2. **Build-green invariant**: on a repo with build/test commands, each applied stage runs them before and after; failure after → the stage reports the offending files and the rollback command (`git restore`), non-zero exit
3. **Real commands only**: the generated AGENTS.md command block is fully traceable (package.json scripts / Makefile / CI); the audit re-score on the transformed repo shows `agents-commands` = 2/2 (build + test)
4. **Symlink bridge**: CLAUDE.md is a symlink to AGENTS.md (or `@AGENTS.md` import on Windows)
5. **Idempotence**: applying an already-installed stage is a reported no-op; the second run leaves git status clean
6. **Manifest consistency**: `.ai-native.yml` lists exactly the files each stage wrote; verification passes (files present match the manifest)
7. **Warn-only**: Stage 2 installs never hard-fail on pre-existing lint/test issues; the repo stays green
8. **Zero build**: Node >= 22.18 runs `transform.ts` directly; zero third-party dependencies
9. **SKILL.md**: full transform instructions + examples land and are executable (commands traceable to real files)

## Slice plan

| Slice | Content | Status |
|---|---|---|
| 1 | `transform.ts` scaffold: CLI (`--root`/`--stage`/`--dry-run`/`--format`), manifest model + read/write, stage status reporting | [ ] |
| 2 | Stage 2 gates installer + templates + pre/post build-green verification | [x] |
| 3 | Stage 3 AGENTS.md generation (real-command extraction) + CLAUDE.md bridge | [x] |
| 4 | Stage 4 SDD adoption (`docs/sdd/` templates + AGENTS.md convention + optional CI gate) | [x] |
| 5 | Manifest consistency verification + SKILL.md transform instructions + examples | [x] |

## Risks

- AGENTS.md generation invents commands — the killer gate (mitigation: strict extraction + acceptance #3 cross-checks with the audit)
- Transform breaks the build (mitigation: pre/post verification, warn-only defaults, documented rollback)
- Overwriting user configs (mitigation: explicit confirmation, never silent, conflicts reported)
- Windows symlink (mitigation: `@AGENTS.md` import fallback; CI runs on macOS)
- Scope creep into check/upgrade (non-goals section)
- Skeleton repos can't demo transform (maturity gating is by design — demo on ≥5-commit repos; spooner itself dogfoods once it has enough commits)
