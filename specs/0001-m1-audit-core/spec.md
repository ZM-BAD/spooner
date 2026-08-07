---
status: shipped
target: M1
date: 2026-08-03
---

# M1: audit core (stack detection + scoring + reporting)

## Background

M1 goal as defined in the session handoff: stack detection + scoring + report output, demoable on its own (score any repo live). Design basis: the internal scope archive (docs/02-scope.md, local-only): audit checks, gate matrix, maturity gating. **This spec pins the scoring matrix and the report schema — slices 2/3 must implement exactly this, no drift.**

## Goal (one sentence)

For any repository, output an AI-Readiness score (/10) + gap list + maturity assessment — fully deterministic, zero build.

## Scope

- Stack detection (Node/TS, Python, Go, Rust, Java, .NET, Ruby, PHP, Swift)
- Scoring per the audit checks: **matrix below (v1, pinned)**
- Report output (JSON + markdown, **schema below (v1, pinned)**)
- Commands derived from real files; evidence traceable

## Non-goals

- transform / check (M2+)
- Deep non-Node stack support (v1: generic templates + explicit "not supported yet")
- LLM semantic layer (gates must be deterministic)

## Scoring matrix (M13 revision, AI-Readiness out of 10)

Weight structure follows kardo-core (r=0.828 expert-calibrated): Freshness 30% / Configuration 25% / Integrity 20% / Agent Setup 15% / Structure 10%, mapped to **3 / 2.5 / 2 / 1.5 / 1 = 10 points**. Scores are **quality-graded, not existence-based** (M13): every check scores `max × coefficient` with coefficients in {0, 0.2, 0.4, 0.6, 0.8, 1.0} — every score is a 0.1 multiple. Quality means **deterministic signals only** (command traceability, CI job depth, hook installation state, manifest consistency, length bands, content structure) — no LLM judgment (determinism red line). Per-check band details are pinned in spec 0013; the table below is the summary. **Every item must carry evidence (real file/command); no evidence → 0.**

### Agent Setup (3) — the product's edge, highest weight

| ID | Max | Quality signal (summary) |
|---|---|---|
| agents-md | 0.5 | content depth + command traceability (commands trace to scripts/Makefile) |
| agents-bridge | 0.5 | real symlink / @AGENTS.md import (content reference scores lower) |
| agents-length | 0.5 | optimal band 30-200 lines; thin/short and over-long drop bands |
| agents-commands | 1 | build+test traceable → full stack lifecycle → documented in AGENTS.md |
| agents-sdd | 0.5 | declaration → + spec files → + state frontmatter → + CI spec gate |

### Configuration (2.5) — tools & gates

| ID | Max | Quality signal (summary) |
|---|---|---|
| cfg-lint | 0.5 | config + command + CI job depth |
| cfg-format | 0.5 | config + command + CI job depth (tool names only, no --format noise) |
| cfg-hooks | 0.5 | mechanism → + discipline config → + hooks installed → + commit-msg stage |
| cfg-ci | 0.5 | lint only / lint+test / lint+test+security job |
| cfg-test | 0.5 | framework/command → + test files → + assertions |

### Integrity (2) — security & consistency

| ID | Max | Quality signal (summary) |
|---|---|---|
| sec-env | 0.5 | .env absent/ignored full; unignored or tracked drop |
| sec-scan | 0.5 | gitleaks mentioned → declared hook → + actually installed |
| sec-ci | 0.5 | tool mentioned vs dedicated security job |
| drift | 0.5 | manifest exists → + version == tool → + declared files present |

### Freshness (1.5) — maintenance activity (transform cannot fix)

| ID | Max | Quality signal (summary) |
|---|---|---|
| fresh-recent | 0.5 | last commit ≤90d / ≤180d / older |
| fresh-active | 0.5 | activity ≤30d / ≤90d / older |
| fresh-deps | 0.5 | pinned + lockfile / pinned only / wildcard; go: go.sum checksum lockfile; rust: Cargo.lock; java: manifest-version pin (no lockfile convention) |

### Structure (1) — engineering structure

| ID | Max | Quality signal (summary) |
|---|---|---|
| struct-readme | 0.5 | content with ≥3 section headings / content only / <50 chars |
| struct-layout | 0.5 | src / lib / packages subdir or equivalent (human-fixable) |

**Calibration note**: weights are an expert-set first version (kardo-core r=0.828 structure); the calibration loop (cross-check on real repos, see "Calibration status") is the differentiator (internal archive docs/04 insight #1), not a one-off.

## Maturity assessment (deterministic rules)

| Rule | Result |
|---|---|
| git commit count < 5 or no history | **skeleton**: score still reported + "too early" note + expected-output list |
| ≥5 commits and a buildable command exists (scripts / Makefile) | **stable**: normal audit → transform |
| ≥5 commits and no AGENTS.md and no CI | **legacy**: suggest conservative transform Stage 2 |

## Report output (pinned schema)

### JSON (stdout; **deterministic: no timestamps, root normalized to `.`**)

```json
{
  "schemaVersion": 2,
  "root": ".",
  "stacks": ["node"],
  "maturity": "stable",
  "maturityNote": null,
  "score": {
    "total": 6,
    "max": 10,
    "byCategory": {
      "agent-setup": { "score": 2, "max": 3 },
      "configuration": { "score": 1.5, "max": 2.5 },
      "integrity": { "score": 1, "max": 2 },
      "freshness": { "score": 1, "max": 1.5 },
      "structure": { "score": 0.5, "max": 1 }
    }
  },
  "subStacks": [],
  "items": [
    {
      "id": "agents-md",
      "category": "agent-setup",
      "score": 0,
      "max": 0.5,
      "evidence": "agent file: missing",
      "fix": "transform Stage 3"
    }
  ],
  "gaps": ["agents-md", "agents-commands", "cfg-ci"],
  "suggestions": ["Configuration: add a test framework + test script (transform never invents commands)"]
}
```

Conventions: `items` expands all 19 checks; `gaps` = ids where score < max; `suggestions` = per-category, built from the missing checks' fix hints, deduped (deterministic, no LLM generation).

### Markdown (`--format markdown`, for humans)

```markdown
# AI-Readiness Report

- Stack: node · Maturity: stable · Score: **9.4/10**

## Score by category

| Category | Score | Max |
|---|---|---|
| Agent Setup | 3 | 3 |
| Configuration | 2 | 2.5 |
| Integrity | 2 | 2 |
| Freshness | 1.5 | 1.5 |
| Structure | 0.5 | 1 |

## Gaps

| Check | Score | Evidence | Fix |
|---|---|---|---|
| cfg-format | 0/0.5 | formatter config: missing, command: missing | add a formatter config + format command (prettier/biome) |

## Suggestions

- Configuration: add a formatter config + format command (prettier/biome)
```

## Acceptance criteria (all commands below must pass for shipped)

1. **Determinism**: `node scripts/audit.ts --root . > /tmp/a.json && node scripts/audit.ts --root . > /tmp/b.json && diff /tmp/a.json /tmp/b.json` → no diff
2. **Structure assertable**: JSON contains `score.total` / `score.max` / `items` / `gaps`; `jq -e '.score.total <= 10'` passes
3. **Demoable**: `node scripts/audit.ts --root <repo> --format markdown` outputs a score table + gap list
4. **Gaps traceable**: every `gaps` entry has a matching `items[]` `evidence` (real file/command)
5. **Skeleton note**: empty repo → `maturity == "skeleton"` with a "too early" note
6. **Zero build**: Node >= 22.18 runs it directly, no compile step

## Slice plan

| Slice | Content | Status |
|---|---|---|
| 1 | scripts/detect.ts stack detection | [x] |
| 2 | scripts/audit.ts scoring (per matrix + maturity rules) + real-repo calibration | [x] |
| 3 | Report output (JSON + markdown, per schema) | [x] |
| 4 | Full SKILL.md instructions + examples | [x] |

## Calibration status

Weights v1 (kardo-core r=0.828 structure) calibrated on 5 real repositories (2026-08-03; scores 8.5-17): discrimination healthy, no systematic bias, 0.5 steps work, maturity gating behaves as designed. Re-review once more external samples exist (multi-stack calibration is a launch prerequisite).

## Risks

- Scoring becomes yet another 0-100: closing the loop (score → fix) + calibration is the differentiator (internal archive docs/04 insight #1) — the calibration loop lives inside slice 2
- Invented commands: every command must derive from real files (killer gate) — agents-commands exists to enforce this
- Arbitrary weights: v1 borrows kardo-core's structure but the check mapping is not yet empirically calibrated — the ≥3-repo review in slice 2 is the stop-loss
