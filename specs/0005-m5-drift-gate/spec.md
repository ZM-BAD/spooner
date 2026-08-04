---
status: shipped
target: M5
date: 2026-08-04
---

# M5: drift gate (manifest consistency as a hard CI gate)

## Background

docs/02 §5's gate matrix promised a consistency job in the installed CI workflow; M2 shipped only four jobs (three warn-only quality jobs + the declared-commands hard gate), and the gap was logged as a functional candidate (HANDOFF §三/§四 #1). The loop is otherwise complete: `check` (M3) detects drift but only when someone runs it; `sync` (M4) repairs stale templates but needs a trigger. The drift gate is the enforcement leg: the installed `ai-native.yml` workflow grows a fifth, hard job that fails the build when the `.ai-native.yml` manifest is inconsistent with reality — missing files, or installed templates older than the workflow's baked version. README's workflow table already promises check "Every CI run"; this spec delivers it as a gate. **Publish contract (docs/08 五.6)**: template content changes require a TOOL_VERSION bump, recorded in the ledger (current: 0.2.1). **This spec pins the gate's exact failure conditions and the baked-version maintenance rule — the slices must implement exactly this, no drift.**

## Goal (one sentence)

For any repository with the installed CI workflow, fail the build when the `.ai-native.yml` manifest declares files that are missing, or when the installed templates are older than the workflow's baked version — so drift turns CI red and `transform`/`sync` become the fix path.

## Scope

- **5th job `manifest-consistency`** in `templates/ci-workflow.yml`: hard gate (no `continue-on-error`), self-contained `node -e` script (node builtins only — CI has no skill package), same inline style as the `declared-commands` job
- **Check 1 — manifest presence + schema**: `.ai-native.yml` missing or unparseable (schemaVersion ≠ 1 / tool ≠ spooner / stages malformed) → fail with "run transform stage 2" guidance
- **Check 2 — file drift**: every manifest-listed file must exist on disk; any missing → fail, naming the files and the transform stage that restores them (the same `stageHint` mapping as check.ts: sdd → 4, AGENTS.md/CLAUDE.md → 3, else 2)
- **Check 3 — template staleness**: baked `EXPECTED` version constant in the job vs the manifest top-level `version` (the last tool version that wrote the manifest — `writeManifest` always stamps it) → older → fail with "run sync" guidance
- **Version contract**: TOOL_VERSION (transform.ts constant; the baked `EXPECTED` must equal it) + docs/08 ledger row + maintenance rule: every TOOL_VERSION bump must update the baked `EXPECTED` in the template
- **Manifest restore**: `transform --stage 2` restores a deleted `.ai-native.yml` even when no files are written (the manifest is the ledger — a deleted manifest must not dead-end the gate's "run transform stage 2" remediation)
- SKILL.md / README / AGENTS.md: stage-2 gate description + status sync (slice 3)

## Non-goals

- Score-delta gating (baseline score drops fail CI) — v2 candidate; the gate checks manifest consistency, not readiness score
- Byte-level template comparison in CI (no skill package in the target repo — only existence + version checks)
- Per-stage templateVersion gating (top-level version is the deterministic signal; per-stage granularity stays local via sync)
- Changing the other four jobs (byte-identical, verified in acceptance)
- Python / multi-stack, LLM involvement, batch gating — existing non-goals hold

## Gate job (pinned behavior)

```yaml
  manifest-consistency:
    name: manifest consistency + template version (hard gate)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.1
      - run: |
          node -e '<self-contained script: parse .ai-native.yml (pinned schema v1),
                    fail on missing/unparseable manifest, missing files (with the
                    restoring stage), or version older than the baked EXPECTED>'
```

Exit 0 + a one-line "consistent (N stage(s) at vX)" summary on green; exit 1 + the specific remediation on red. Deterministic: same repo state → same outcome.

## Acceptance criteria (all must pass for shipped)

1. **Gate job present**: `ci-workflow.yml` has a fifth job `manifest-consistency`, no `continue-on-error`, script uses node builtins only (no third-party require)
2. **Pass on consistent repo**: fixture with an intact manifest at the current version → extracted gate script exits 0 with the summary line
3. **Fail on file drift**: a manifest-listed file deleted → exit non-zero, names the file and the restoring transform stage
4. **Fail on missing manifest**: no `.ai-native.yml` → exit non-zero, "run transform stage 2"
5. **Fail on stale templates**: manifest `version` older than the baked `EXPECTED` → exit non-zero, "run sync"
6. **Schema guard**: unparseable/wrong-schema manifest → exit non-zero
7. **Baked version == TOOL_VERSION**: the job's `EXPECTED` constant equals transform.ts `TOOL_VERSION` (currently "0.2.1")
8. **Version bump + ledger**: TOOL_VERSION bump recorded in docs/08 §七, maintenance rule documented
9. **Dogfood**: `sync --root .` on spooner classifies the installed workflow `outdated` and applies it; spooner's manifest is stamped with the current TOOL_VERSION; the extracted gate script passes on spooner itself
10. **Other jobs untouched**: the four existing jobs in `ci-workflow.yml` are byte-identical to the pre-M5 template (git diff)
11. **YAML + docs green**: check-yaml and markdownlint pass; SKILL.md/README/AGENTS.md updated; agentskills validate passes

## Slice plan

| Slice | Content | Status |
|---|---|---|
| 1 | `ci-workflow.yml` fifth job (self-contained parser + file-drift + version-staleness gates) + TOOL_VERSION bump + docs/08 ledger + maintenance rule | [x] |
| 2 | Dogfood: sync spooner (workflow replaced + manifest stamped) + gate script verified against fixtures (green / drift / no-manifest / stale / bad-schema) | [x] |
| 3 | SKILL.md/README/AGENTS/ROADMAP/HANDOFF sync + acceptance + ship | [x] |

## Risks

- CI cannot byte-compare templates (no skill package) → existence + baked-version checks only; byte drift stays local (sync reports it) — documented boundary
- Baked `EXPECTED` drifts from TOOL_VERSION (mitigation: ledger maintenance rule + acceptance criterion 7 re-checks equality)
- Gate reds on repos that intentionally dropped the manifest (mitigation: the workflow itself is manifest-managed — removing the manifest without removing the workflow is genuine drift; the message names the restore path)
- Scope creep into score gating / per-stage checks (non-goals section)
- Template change without bump (mitigation: this spec bumps — the contract is self-applied, and the dogfood sync exercises the mechanism)
