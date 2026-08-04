---
name: spooner
description: Audit a codebase's AI coding readiness — detect the stack, score it out of 20 with a gap list and maturity assessment, using deterministic zero-build scripts. Use when the user asks to audit or improve a repository's readiness for AI coding agents, or to run the audit / transform / check workflow.
license: MIT
compatibility: Node.js >= 22.18 + git (scripts are TypeScript run natively via type stripping — no build step, zero third-party dependencies)
---

# Spooner

> Audit a codebase's **AI coding readiness**, score it, then transform it in place — install CI gates, generate an AGENTS.md, adopt a spec-driven workflow. Every step verifiable, never breaking the existing build.
>
> **Status: M1 (audit) shipped — `detect` + `audit` available, full instructions below. `transform` and `check` land in M2.**

## Workflow

| Step | Available | Scripts / status |
|---|---|---|
| audit — detect and score readiness (repeatable health check) | ✅ M1 | `scripts/detect.ts` + `scripts/audit.ts` |
| transform — incremental, verifiable, rollback-able changes (CI gates → AGENTS.md → SDD) | ⏳ M2 | not yet available |
| check — continuously detect drift (repeatable, with records) | ⏳ M2 | not yet available |

## Prerequisites

- **Node.js >= 22.18** — the scripts are TypeScript run natively via type stripping; there is no build step. On older Node, `audit.ts` prints an upgrade hint and exits.
- **git** — freshness checks and maturity gating read commit history.
- The scripts are **zero-dependency** (Node builtins only) and **read-only** — running them never modifies the target repository.

## Running the scripts

Both scripts accept `--root <path>` (default: the current working directory) and can be run from anywhere:

```sh
node <skill-dir>/scripts/detect.ts --root /path/to/repo
node <skill-dir>/scripts/audit.ts --root /path/to/repo [--format json|markdown]
```

(When developing this skill inside the spooner repo, `<skill-dir>` is `skills/spooner`.)

- `detect.ts` always prints JSON: `{ root, stacks, manifests }` — the detected stacks plus one entry per known manifest (`package.json`, `pyproject.toml`, `go.mod`, …) with an `exists` flag.
- `audit.ts` defaults to JSON (machine-parseable); `--format markdown` prints the human-readable report.

## The audit workflow (M1)

1. **Detect the stack** (optional — for context): `node <skill-dir>/scripts/detect.ts --root <path>`. The audit re-runs detection internally, so this is only needed if you want manifest details up front.
2. **Score the repository**: `node <skill-dir>/scripts/audit.ts --root <path> --format markdown`.
3. **Read the report**:
   - **Score out of 20** across five categories: Agent Setup 6 · Configuration 5 · Integrity 4 · Freshness 3 · Structure 2. Checks score 0 / 0.5 / 1 (`agents-commands` 0 / 1 / 2). **Every point carries evidence** — a real file, git state, or a command traceable to the repo. No evidence → 0.
   - **Maturity** decides what to tell the user (below).
   - **Gaps** are the checks scoring below max; each has `evidence` and a `fix` hint. **Suggestions** are fixed copy per category pointing at transform stages.
4. **Never invent commands**: a command may only be reported as evidence if it exists in the repo (package.json scripts / Makefile / CI config). If it can't be traced, that's a gap — not a reason to fabricate.

### Maturity gating — what to tell the user

| Maturity | Deterministic rule | Response |
|---|---|---|
| skeleton | fewer than 5 commits | The score is still reported, with a "too early" note. Tell the user the repo is too young to transform and to re-run after it stabilizes. |
| stable | ≥ 5 commits, with a buildable command (or an agent file / CI present) | Normal path: report → suggest transform (Stage 2 gates first, then Stage 3 AGENTS.md). |
| legacy | ≥ 5 commits, no agent file, no CI | Normal path with **conservative Stage 2**: warn-only gates, existing build kept green. |

### Determinism

The audit is a health check, not an opinion: the same repository always produces the same report (no timestamps, no LLM-generated text). Verify with:

```sh
node <skill-dir>/scripts/audit.ts --root . > /tmp/a.json
node <skill-dir>/scripts/audit.ts --root . > /tmp/b.json
diff /tmp/a.json /tmp/b.json   # no output = deterministic
```

## transform & check — M2, not yet available

Gap `fix` strings and suggestions reference transform stages:

- **Stage 2 — gates only**: commitlint + pre-commit + gitleaks + markdownlint + CI lint/test/security jobs; warn-only, never touching existing logic.
- **Stage 3 — agent files**: AGENTS.md generated from real commands + a CLAUDE.md symlink.
- **Stage 4 (optional) — SDD**: spec/plan/tasks templates + workflow conventions in AGENTS.md.

Until M2 ships, do **not** fabricate these files yourself: the M1 report ends at "what to do", not "do it".

## Examples

### Markdown report (real output — the spooner repo itself, 2026-08-04)

```markdown
# AI-Readiness Report

- Stack: node · Maturity: skeleton · Score: **12/20**

> Fewer than 5 commits — too early to transform. Return once the project stabilizes.

## Score by category

| Category | Score | Max |
|---|---|---|
| Agent Setup | 5 | 6 |
| Configuration | 2 | 5 |
| Integrity | 1 | 4 |
| Freshness | 3 | 3 |
| Structure | 1 | 2 |

## Gaps

| Check | Score | Evidence | Fix |
|---|---|---|---|
| agents-commands | 1/2 | commands traceable to package.json scripts (build: true, test: false) | add real build/test commands, then document them in AGENTS.md |
| cfg-format | 0/1 | formatter config: missing, command: missing | transform Stage 2 |
| cfg-ci | 0/1 | CI present (lint: true, test: false) | transform Stage 2 (CI lint + test jobs) |
| cfg-test | 0/1 | no test framework or test command found | transform Stage 2 (add a test command) |
| sec-scan | 0/1 | no secret scanning configured | transform Stage 2 (gitleaks) |
| sec-ci | 0/1 | CI has no security job | transform Stage 2 (CI security job) |
| drift | 0/1 | .ai-native.yml manifest missing | run transform to install the manifest |
| struct-layout | 0/1 | no src/, lib/, or packages/ directory | organize sources under src/, lib/, or packages/ |

## Suggestions

- Run transform Stage 3 to generate an AGENTS.md derived from real commands (with a CLAUDE.md symlink).
- Run transform Stage 2 to install lint/format/CI gates (warn-only; keep the existing build green).
- Run transform Stage 2 security pass: gitleaks, .env protection, and a CI security job.
- Add a README with real content and organize sources under src/, lib/, or packages/.
```

### JSON output (abridged — `items` holds all 19 checks; the first three are shown)

```json
{
  "schemaVersion": 1,
  "root": ".",
  "stacks": ["node"],
  "maturity": "skeleton",
  "maturityNote": "Fewer than 5 commits — too early to transform. Return once the project stabilizes.",
  "score": {
    "total": 12,
    "max": 20,
    "byCategory": {
      "agent-setup": { "score": 5, "max": 6 },
      "configuration": { "score": 2, "max": 5 },
      "integrity": { "score": 1, "max": 4 },
      "freshness": { "score": 3, "max": 3 },
      "structure": { "score": 1, "max": 2 }
    }
  },
  "items": [
    {
      "id": "agents-md",
      "category": "agent-setup",
      "score": 1,
      "max": 1,
      "evidence": "agent file: AGENTS.md",
      "fix": "transform Stage 3"
    },
    {
      "id": "agents-bridge",
      "category": "agent-setup",
      "score": 1,
      "max": 1,
      "evidence": "CLAUDE.md: symlink to AGENTS.md",
      "fix": "transform Stage 3"
    },
    {
      "id": "agents-length",
      "category": "agent-setup",
      "score": 1,
      "max": 1,
      "evidence": "AGENTS.md: 75 lines",
      "fix": "trim AGENTS.md"
    }
  ],
  "gaps": ["agents-commands", "cfg-format", "cfg-ci", "cfg-test", "sec-scan", "sec-ci", "drift", "struct-layout"],
  "suggestions": [
    "Run transform Stage 3 to generate an AGENTS.md derived from real commands (with a CLAUDE.md symlink).",
    "Run transform Stage 2 to install lint/format/CI gates (warn-only; keep the existing build green).",
    "Run transform Stage 2 security pass: gitleaks, .env protection, and a CI security job.",
    "Add a README with real content and organize sources under src/, lib/, or packages/."
  ]
}
```

All 19 check ids: `agents-md`, `agents-bridge`, `agents-length`, `agents-commands`, `agents-sdd`, `cfg-lint`, `cfg-format`, `cfg-hooks`, `cfg-ci`, `cfg-test`, `sec-env`, `sec-scan`, `sec-ci`, `drift`, `fresh-recent`, `fresh-active`, `fresh-deps`, `struct-readme`, `struct-layout`.

## Red lines

- Commands are derived from real files, never invented — a gap is reported, never faked
- Every step is verified and rollback-able — never break an existing build
- audit is read-only — it never writes to the audited repository
- The report is deterministic — no timestamps, no LLM-generated suggestions (fixed copy)
- Scripts are zero-dependency and only do what they declare (scan + report)
