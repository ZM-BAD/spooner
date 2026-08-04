---
name: spooner
description: Audit a codebase's AI coding readiness — detect the stack, score it out of 20 with a gap list and maturity assessment, using deterministic zero-build scripts. Use when the user asks to audit or improve a repository's readiness for AI coding agents, or to run the audit / transform / check workflow.
license: MIT
compatibility: Node.js >= 22.18 + git (scripts are TypeScript run natively via type stripping — no build step, zero third-party dependencies)
---

# Spooner

> Audit a codebase's **AI coding readiness**, score it, then transform it in place — install CI gates, generate an AGENTS.md, adopt a spec-driven workflow. Every step verifiable, never breaking the existing build.
>
> **Status: M1 (audit) + M2 (transform) shipped — `detect`, `audit`, `transform` available. `check` lands in a later milestone.**

## Workflow

| Step | Available | Scripts / status |
|---|---|---|
| audit — detect and score readiness (repeatable health check) | ✅ M1 | `scripts/detect.ts` + `scripts/audit.ts` |
| transform — incremental, verifiable, rollback-able changes (gates → AGENTS.md → SDD) | ✅ M2 | `scripts/transform.ts` |
| check — continuously detect drift (repeatable, with records) | ⏳ later | not yet available |

## Prerequisites

- **Node.js >= 22.18** — the scripts are TypeScript run natively via type stripping; there is no build step. On older Node, `audit.ts` prints an upgrade hint and exits.
- **git** — freshness checks and maturity gating read commit history.
- The scripts are **zero-dependency** (Node builtins only) and **read-only** — running them never modifies the target repository.

## Running the scripts

Both scripts accept `--root <path>` (default: the current working directory) and can be run from anywhere:

```sh
node <skill-dir>/scripts/detect.ts --root /path/to/repo
node <skill-dir>/scripts/audit.ts --root /path/to/repo [--format json|markdown]
node <skill-dir>/scripts/transform.ts --root /path/to/repo [--stage 2|3|4|all] [--dry-run] [--format json|markdown]
```

(When developing this skill inside the spooner repo, `<skill-dir>` is `skills/spooner`.)

- `detect.ts` always prints JSON: `{ root, stacks, manifests }` — the detected stacks plus one entry per known manifest (`package.json`, `pyproject.toml`, `go.mod`, …) with an `exists` flag.
- `audit.ts` defaults to JSON (machine-parseable); `--format markdown` prints the human-readable report.
- `transform.ts` defaults to `--stage all` status; `--stage 2|3|4` applies one stage, `--dry-run` shows the plan without writing anything.

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

## transform — the workflow (M2)

The audit ends at "what to do"; transform **does it** — in place, one verified, confirmable stage at a time, never breaking the existing build. Run it only on `stable`/`legacy` repos (skeleton repos are "too early" by design).

**Agent-driven procedure:**

1. **Stage 1 = the audit** (above): report + plan. Show the user the score and the gap list; agree on the stage order. Default order: Stage 2 (gates) → Stage 3 (agent files) → Stage 4 (SDD).
2. **Dry-run first, always**: `node <skill-dir>/scripts/transform.ts --root <path> --stage 2 --dry-run` — prints the exact plan (files to write / keep / conflict) and the build command that will be verified. Nothing is written.
3. **Apply with user confirmation**: `--stage 2` writes the missing gate files and verifies the repo's declared build/test commands **before and after**; if the post-apply check fails, the report lists the files and the rollback command (`git restore …`) and exits non-zero. **Then install the git hooks**: `pre-commit install --hook-type commit-msg` — plain `pre-commit install` installs only the pre-commit stage and leaves the commitlint hook dead (config ≠ enforcement); the commit-msg hook is what actually checks every commit.
4. **Respect conflicts**: an existing file whose content differs from the template is **never overwritten** — it's reported as `conflict` and left to the user's decision.
5. **Re-run freely**: applying an already-installed stage is a reported no-op (idempotent). The `.ai-native.yml` manifest records what each stage installed (date, files); `transform.ts --stage all` reports per-stage status plus **manifest consistency** (installed files vs the manifest — the drift seed).

| Stage | What it does | Outputs |
|---|---|---|
| 2 — gates (warn-only) | commitlint + pre-commit (markdownlint + gitleaks) + CI workflow (warn-only quality jobs; hard gate: declared build/test commands executable) | `.commitlintrc.json`, `.pre-commit-config.yaml`, `.markdownlint-cli2.yaml`, `.github/workflows/ai-native.yml` |
| 3 — agent files | AGENTS.md generated from **real commands only** (package.json scripts / Makefile) + CLAUDE.md bridge | `AGENTS.md`, `CLAUDE.md` (symlink; `@AGENTS.md` import on Windows) |
| 4 — SDD (optional) | spec/plan/tasks templates + SDD convention in AGENTS.md + spec-existence CI gate | `docs/sdd/*.md`, `.github/workflows/sdd.yml`, AGENTS.md convention |

`check` (drift detection as a repeatable health check) is a later milestone — its seed is the manifest consistency report above.

## Examples

### Markdown report (real output — the spooner repo itself, 2026-08-04)

```markdown
# AI-Readiness Report

- Stack: node · Maturity: stable · Score: **16/20**

## Score by category

| Category | Score | Max |
|---|---|---|
| Agent Setup | 5 | 6 |
| Configuration | 3 | 5 |
| Integrity | 4 | 4 |
| Freshness | 3 | 3 |
| Structure | 1 | 2 |

## Gaps

| Check | Score | Evidence | Fix |
|---|---|---|---|
| agents-commands | 1/2 | commands traceable to package.json scripts (build: true, test: false) | add real build/test commands, then document them in AGENTS.md |
| cfg-format | 0/1 | formatter config: missing, command: missing | transform Stage 2 |
| cfg-test | 0/1 | no test framework or test command found | transform Stage 2 (add a test command) |
| struct-layout | 0/1 | no src/, lib/, or packages/ directory | organize sources under src/, lib/, or packages/ |

## Suggestions

- Run transform Stage 3 to generate an AGENTS.md derived from real commands (with a CLAUDE.md symlink).
- Run transform Stage 2 to install lint/format/CI gates (warn-only; keep the existing build green).
- Add a README with real content and organize sources under src/, lib/, or packages/.
```

### JSON output (abridged — `items` holds all 19 checks; the first three are shown)

```json
{
  "schemaVersion": 1,
  "root": ".",
  "stacks": ["node"],
  "maturity": "stable",
  "maturityNote": null,
  "score": {
    "total": 16,
    "max": 20,
    "byCategory": {
      "agent-setup": { "score": 5, "max": 6 },
      "configuration": { "score": 3, "max": 5 },
      "integrity": { "score": 4, "max": 4 },
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
      "evidence": "AGENTS.md: 76 lines",
      "fix": "trim AGENTS.md"
    }
  ],
  "gaps": ["agents-commands", "cfg-format", "cfg-test", "struct-layout"],
  "suggestions": [
    "Run transform Stage 3 to generate an AGENTS.md derived from real commands (with a CLAUDE.md symlink).",
    "Run transform Stage 2 to install lint/format/CI gates (warn-only; keep the existing build green).",
    "Add a README with real content and organize sources under src/, lib/, or packages/."
  ]
}
```

All 19 check ids: `agents-md`, `agents-bridge`, `agents-length`, `agents-commands`, `agents-sdd`, `cfg-lint`, `cfg-format`, `cfg-hooks`, `cfg-ci`, `cfg-test`, `sec-env`, `sec-scan`, `sec-ci`, `drift`, `fresh-recent`, `fresh-active`, `fresh-deps`, `struct-readme`, `struct-layout`.

### Transform status (real output — the spooner repo itself, 2026-08-04)

```markdown
# Transform Status

- Root: . · Stage: all · Dry-run: false

| Stage | Status | Present | Missing |
|---|---|---|---|
| 2 | installed | .commitlintrc.json, .pre-commit-config.yaml, .markdownlint-cli2.yaml, .github/workflows/ai-native.yml | — |
| 3 | installed | AGENTS.md, CLAUDE.md | — |
| 4 | not-installed | — | docs/sdd/spec.md, docs/sdd/plan.md, docs/sdd/tasks.md, .github/workflows/sdd.yml |

- Manifest consistency: consistent
```

A stage 2 dry-run on a repo with no gates reports the plan first, e.g. `dry-run: 4 file(s) to write, 0 conflict(s), 0 already installed; verification command: npm run build && npm run test` — only `--stage 2` (without `--dry-run`) writes, and only after the user confirms.

## Red lines

- Commands are derived from real files, never invented — a gap is reported, never faked
- Every step is verified and rollback-able — never break an existing build
- audit is read-only — it never writes to the audited repository
- The report is deterministic — no timestamps, no LLM-generated suggestions (fixed copy)
- transform never overwrites an existing file whose content differs — conflicts are reported, the user decides
- transform verifies the declared build/test commands before and after each applied stage; on failure it names the rollback command (`git restore …`)
- Scripts are zero-dependency and only do what they declare (scan + report + install)
