---
status: in-progress
target: M1
date: 2026-08-03
---

# M1: audit core (stack detection + scoring + reporting)

## Background

M1 goal as defined in the session handoff: stack detection + scoring + report output, demoable on its own (score any repo live). Design basis: the internal scope archive (docs/02-scope.md, local-only): audit checks, gate matrix, maturity gating. **This spec pins the scoring matrix and the report schema — slices 2/3 must implement exactly this, no drift.**

## Goal (one sentence)

For any repository, output an AI-Readiness score (/20) + gap list + maturity assessment — fully deterministic, zero build.

## Scope

- Stack detection (Node/TS, Python, Go, Rust, Java, .NET, Ruby, PHP, Swift)
- Scoring per the audit checks: **matrix below (v1, pinned)**
- Report output (JSON + markdown, **schema below (v1, pinned)**)
- Commands derived from real files; evidence traceable

## Non-goals

- transform / check (M2+)
- Deep non-Node stack support (v1: generic templates + explicit "not supported yet")
- LLM semantic layer (gates must be deterministic)

## Scoring matrix (v1, AI-Readiness out of 20)

Weight structure follows kardo-core (r=0.828 expert-calibrated): Freshness 30% / Configuration 25% / Integrity 20% / Agent Setup 15% / Structure 10%, mapped to **6 / 5 / 4 / 3 / 2 = 20 points**; checks re-mapped to audit goals (internal archive docs/02 §1, §5). Steps: 0 / 0.5 / 1 per item (agents-commands 0 / 1 / 2); the total advances in 0.5 steps. **Every item must carry evidence (real file/command); no evidence → 0.**

### Agent Setup (6) — the product's edge, highest weight

| ID | Check | Criteria | Evidence source |
|---|---|---|---|
| agents-md | AGENTS.md or CLAUDE.md present | present 1 / missing 0 | filesystem |
| agents-bridge | CLAUDE.md symlink or @AGENTS.md bridge | yes 1 / no 0 | file type / content |
| agents-length | Length compliance | ≤200 lines 1; >200 lines 0.5; >40K chars 0 | line/byte counts |
| agents-commands | Executable build/test commands traceable to real files | commands found in package.json scripts / Makefile / existing CI 2; commands present but untraceable 1; none 0 | command ↔ file cross-check |
| agents-sdd | Declares a spec/SDD workflow | yes 1 / no 0 | content match |

### Configuration (5) — tools & gates

| ID | Check | Criteria |
|---|---|---|
| cfg-lint | lint config exists and the command is real | 1 / 0 |
| cfg-format | formatter config exists and the command is real | 1 / 0 |
| cfg-hooks | local commit gate (pre-commit / lefthook / husky, incl. commitlint or markdownlint) | 1 / 0 |
| cfg-ci | CI exists with lint + test | 1 / 0 |
| cfg-test | test framework + real test command | 1 / 0 |

### Integrity (4) — security & consistency

| ID | Check | Criteria |
|---|---|---|
| sec-env | .env not committed (ignored via .gitignore or absent) | 1 / 0 |
| sec-scan | secret scanning configured (gitleaks etc.) | 1 / 0 |
| sec-ci | CI has a security job | 1 / 0 |
| drift | .ai-native.yml manifest present and consistent | present & consistent 1; no manifest 0 |

### Freshness (3) — maintenance activity (transform cannot fix; only 15% weight)

| ID | Check | Criteria |
|---|---|---|
| fresh-recent | last commit | ≤90d 1; ≤180d 0.5; older 0 |
| fresh-active | default-branch activity | commits in 30d 1; ≤90d 0.5; older 0 |
| fresh-deps | dependency declaration | version-pinned + lockfile 1; pinned only 0.5; else 0 |

### Structure (2) — engineering structure

| ID | Check | Criteria |
|---|---|---|
| struct-readme | README present with >50 chars of real content (not a placeholder) | 1 / 0 |
| struct-layout | sources organized (src / lib / packages subdir or equivalent) | 1 / 0 |

**Calibration note**: weights are an expert-set first version (kardo-core r=0.828 structure); after the slice 2 implementation, cross-check on ≥3 real repos and record corrections here — the calibration loop is the differentiator (internal archive docs/04 insight #1), not a one-off.

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
  "schemaVersion": 1,
  "root": ".",
  "stacks": ["node"],
  "maturity": "stable",
  "maturityNote": null,
  "score": {
    "total": 6,
    "max": 20,
    "byCategory": {
      "agent-setup": { "score": 1, "max": 6 },
      "configuration": { "score": 2, "max": 5 },
      "integrity": { "score": 1, "max": 4 },
      "freshness": { "score": 1, "max": 3 },
      "structure": { "score": 1, "max": 2 }
    }
  },
  "items": [
    {
      "id": "agents-md",
      "category": "agent-setup",
      "score": 0,
      "max": 1,
      "evidence": "agent file: missing",
      "fix": "transform Stage 3"
    }
  ],
  "gaps": ["agents-md", "agents-commands", "cfg-ci"],
  "suggestions": ["Run transform Stage 2 to install commit discipline gates (commitlint + pre-commit)."]
}
```

Conventions: `items` expands all 19 checks; `gaps` = ids where score < max; `suggestions` = per-category **fixed copy** (deterministic, no LLM generation).

### Markdown (`--format markdown`, for humans)

```markdown
# AI-Readiness Report

- Stack: node · Maturity: stable · Score: **6/20**

## Score by category

| Category | Score | Max |
|---|---|---|
| Agent Setup | 1 | 6 |
| Configuration | 2 | 5 |
| Integrity | 1 | 4 |
| Freshness | 1 | 3 |
| Structure | 1 | 2 |

## Gaps

| Check | Score | Evidence | Fix |
|---|---|---|---|
| agents-md | 0/1 | agent file: missing | transform Stage 3 |

## Suggestions

- Run transform Stage 3 to generate an AGENTS.md derived from real commands (with a CLAUDE.md symlink).
```

## Acceptance criteria (all commands below must pass for shipped)

1. **Determinism**: `node scripts/audit.ts --root . > /tmp/a.json && node scripts/audit.ts --root . > /tmp/b.json && diff /tmp/a.json /tmp/b.json` → no diff
2. **Structure assertable**: JSON contains `score.total` / `score.max` / `items` / `gaps`; `jq -e '.score.total <= 20'` passes
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
| 4 | Full SKILL.md instructions + examples | [ ] |

## Calibration record (slice 2, 2026-08-03)

First pass over 5 real repositories (read-only):

| Repo | Stack | Maturity | Score | Gaps |
|---|---|---|---|---|
| DAG-chat | node | stable | 16/20 | 4 |
| headroom | node | stable | 14.5/20 | 6 |
| kite | node | skeleton | 17/20 | 3 |
| kuan-chat | node | stable | 12/20 | 8 |
| starraft | — | stable | 8.5/20 | 11 |

Verdict: scores spread 8.5-17, discrimination is healthy, no systematic bias; 0.5 steps work; maturity gating behaves as designed (kite is well set up but <5 commits → skeleton). **Weights v1 are usable, no change yet**; re-review once more external samples exist.

## Risks

- Scoring becomes yet another 0-100: closing the loop (score → fix) + calibration is the differentiator (internal archive docs/04 insight #1) — the calibration loop lives inside slice 2
- Invented commands: every command must derive from real files (killer gate) — agents-commands exists to enforce this
- Arbitrary weights: v1 borrows kardo-core's structure but the check mapping is not yet empirically calibrated — the ≥3-repo review in slice 2 is the stop-loss
