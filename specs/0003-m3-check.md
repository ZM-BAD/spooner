---
status: shipped
target: M3
date: 2026-08-04
---

# M3: check (drift detection — the repeatable loop)

## Background

M1 ships the audit (score) and M2 ships the transform (in-place fix). The third command closes the loop: readiness decays — AGENTS.md goes stale, CI gates get deleted, lint gets bypassed. Without check, the skill is a one-shot migration script; with it, detection becomes a repeatable health check with records. Design basis: re-run audit and compare, manifest vs actual drift, suggested actions; decision #7 (`.ai-native.yml` manifest + rerunnable). M2 already seeded the drift machinery: `transform.ts` reports manifest consistency; `audit.ts` produces the deterministic score. **This spec pins the check report schema and the baseline store — the slices must implement exactly this, no drift.**

## Goal (one sentence)

For any repository, re-score AI readiness, compare against the stored baseline and the `.ai-native.yml` manifest, and report drift with deterministic suggested actions — repeatable, zero build.

## Scope

- `check.ts` CLI: `--root <path>` / `--format json|markdown`; zero-dependency, Node >= 22.18
- Re-runs the M1 audit (imports `runAudit` from audit.ts — exported for reuse)
- **Baseline store**: `.ai-native/baseline.json` (schema pinned below) — written on every check run; first run records a baseline and says so
- **Drift report**: manifest entries vs actual files (reuses `checkConsistency` from transform.ts — exported for reuse) + score delta vs baseline + gap diff
- **Fixed suggestions** (deterministic copy, no LLM): restore missing manifest files via transform stage N / readiness dropped / first-run note / no-manifest note
- SKILL.md: full check instructions + examples (slice 3)

## Non-goals

- Trend history / multi-run charts (v2 candidate — v1 stores only the latest baseline)
- `upgrade` (template version updates) — v2 candidate
- Multi-repo batch checks — vision stage
- LLM semantic layer (gates stay deterministic, decision #5)
- Writing business code / fixing drift automatically (check reports; transform fixes — same separation as audit/transform)

## Baseline store `.ai-native/baseline.json` (pinned schema v1)

```json
{
  "schemaVersion": 1,
  "date": "2026-08-04",
  "score": { "total": 16, "max": 20, "byCategory": { "agent-setup": { "score": 5, "max": 6 } } },
  "gaps": ["cfg-format"]
}
```

Written on every run (the ledger, like the manifest — the date is allowed here); read-only inputs are the repo state and the manifest.

## Check report (pinned schema v1)

```json
{
  "schemaVersion": 1,
  "root": ".",
  "score": { "total": 16, "max": 20, "byCategory": {} },
  "maturity": "stable",
  "gaps": ["cfg-format"],
  "baseline": { "present": true, "date": "2026-08-04", "total": 16, "delta": 0 },
  "drift": { "consistent": true, "missing": [] },
  "suggestions": ["..."]
}
```

`delta` = current total − baseline total. Deterministic: same repo state + same baseline → identical output.

## Acceptance criteria (all must pass for shipped)

1. **First run**: no baseline → baseline is recorded and the report says "baseline recorded — re-run to see drift"
2. **Stable re-run**: second run on an unchanged repo → `delta == 0`, `drift.consistent == true`, output identical to itself (determinism: run twice, diff)
3. **Score delta**: between runs, a gap is fixed (e.g., a lint config added) → `delta > 0` and the gap leaves the report's gaps list
4. **Drift detection**: a manifest-listed file is deleted → `drift.consistent == false`, `missing` names it, and a suggestion says to re-run the transform stage that installs it
5. **Baseline ledger**: `.ai-native/baseline.json` exists after the first run, parses per the pinned schema, and holds the latest score
6. **No-manifest note**: a repo without `.ai-native.yml` → report notes "run transform stage 2 to install the manifest"
7. **Zero build**: Node >= 22.18 runs check.ts directly; zero third-party dependencies
8. **SKILL.md**: check instructions + examples land and are executable (commands traceable to real files)

## Slice plan

| Slice | Content                                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `check.ts` scaffold: CLI (`--root`/`--format`), baseline model read/write, audit re-run integration (export `runAudit` from audit.ts, `checkConsistency` from transform.ts) |
| 2     | Drift report: score delta + gap diff + manifest drift + fixed suggestions + markdown render                                                                                 |
| 3     | SKILL.md check instructions + examples + acceptance + ship                                                                                                                  |

## Risks

- Baseline goes stale or lies (mitigation: baseline is a deterministic record of the latest run, never hand-edited; schema-validated on read)
- Check becomes a second audit (mitigation: the differentiator is the comparison + drift + suggestions — the loop, not the score)
- Scope creep into upgrade/batch (non-goals section)
- Manifest absent in most repos → check's drift half is inert (mitigation: the no-manifest suggestion points at transform stage 2; check still reports score + baseline drift)
