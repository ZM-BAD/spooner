---
name: spooner
description: Audit a codebase's AI coding readiness — detect the stack, score it out of 20 with a gap list and maturity assessment, using deterministic zero-build scripts. Use when the user asks to audit or improve a repository's readiness for AI coding agents, or to run the audit / transform / check / sync workflow.
license: MIT
compatibility: Node.js >= 22.18 + git (scripts are TypeScript run natively via type stripping — no build step, zero third-party dependencies)
---

# Spooner

> Audit a codebase's **AI coding readiness**, score it, then transform it in place — install CI gates, generate an AGENTS.md, adopt a spec-driven workflow. Every step verifiable, never breaking the existing build.
>
> **Status: M1 (audit) + M2 (transform) + M3 (check) + M4 (sync) + M5 (CI drift gate) + M6 (multi-stack) shipped — `detect`, `audit`, `transform`, `check`, `sync` available; the installed CI workflow hard-gates manifest consistency; transform supports node / python / go / java; the installed commitlint gate enforces (hook install step + CI commit-msg check + gate-active audit).**

## Workflow

| Step | Available | Scripts / status |
|---|---|---|
| audit — detect and score readiness (repeatable health check) | ✅ M1 | `scripts/detect.ts` + `scripts/audit.ts` |
| transform — incremental, verifiable, rollback-able changes (gates → AGENTS.md → SDD) | ✅ M2 | `scripts/transform.ts` |
| check — continuously detect drift (repeatable, with records) | ✅ M3 | `scripts/check.ts` |
| sync — re-sync installed templates when the tool advances (versioned, one-click) | ✅ M4 | `scripts/sync.ts` |

## Prerequisites

- **Node.js >= 22.18** — the scripts are TypeScript run natively via type stripping; there is no build step. On older Node, `audit.ts` prints an upgrade hint and exits.
- **git** — freshness checks and maturity gating read commit history.
- **Stack toolchains** — stage 2's verification and the installed CI gate run the stack's lifecycle commands (`npm` / `python3 -m unittest` / `go build` / `mvn`), so the stack toolchain must be available where `transform` runs (CI sets it up itself via setup-node / setup-python / setup-go / setup-java).
- The scripts are **zero-dependency** (Node builtins only). `detect` and `audit` are **read-only**; `transform`, `check` and `sync` write only what they declare (installed template files / the `.ai-native.yml` manifest / the `.ai-native/baseline.json` ledger).

## Running the scripts

Both scripts accept `--root <path>` (default: the current working directory) and can be run from anywhere:

```sh
node <skill-dir>/scripts/detect.ts --root /path/to/repo
node <skill-dir>/scripts/audit.ts --root /path/to/repo [--format json|markdown]
node <skill-dir>/scripts/transform.ts --root /path/to/repo [--stage 2|3|4|all] [--dry-run] [--format json|markdown]
node <skill-dir>/scripts/check.ts --root /path/to/repo [--format json|markdown]
node <skill-dir>/scripts/sync.ts --root /path/to/repo [--dry-run] [--format json|markdown]
```

(When developing this skill inside the spooner repo, `<skill-dir>` is `skills/spooner`.)

- `detect.ts` always prints JSON: `{ root, stacks, manifests }` — the detected stacks plus one entry per known manifest (`package.json`, `pyproject.toml`, `go.mod`, …) with an `exists` flag.
- `audit.ts` defaults to JSON (machine-parseable); `--format markdown` prints the human-readable report.
- `transform.ts` defaults to `--stage all` status; `--stage 2|3|4` applies one stage, `--dry-run` shows the plan without writing anything.
- `check.ts` re-runs the audit, compares against the stored baseline and the manifest, and reports drift — defaults to JSON; `--format markdown` for humans.
- `sync.ts` compares manifest-recorded template files against the current skill templates and re-syncs them — defaults to **apply** (replaces outdated, restores missing); `--dry-run` shows the per-file plan without writing.

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
| 2 — gates (warn-only) | commitlint + pre-commit (markdownlint + gitleaks) + **stack-aware** CI workflow (warn-only quality jobs; hard gates: declared lifecycle commands executable + `.ai-native.yml` consistency — drift turns CI red) | `.commitlintrc.json`, `.pre-commit-config.yaml`, `.markdownlint-cli2.yaml`, `.github/workflows/ai-native.yml` (per-stack template) |
| 3 — agent files | AGENTS.md generated from **real commands only** (package.json scripts / Makefile / stack lifecycle: `mvn`, `go`, `python3 -m unittest`) + CLAUDE.md bridge | `AGENTS.md`, `CLAUDE.md` (symlink; `@AGENTS.md` import on Windows) |
| 4 — SDD (optional) | spec/plan/tasks templates + SDD convention in AGENTS.md + spec-existence CI gate | `docs/sdd/*.md`, `.github/workflows/sdd.yml`, AGENTS.md convention |

### Stack support (M6)

| Stack | detect | audit | transform gates + CI workflow | AGENTS.md commands |
|---|---|---|---|---|
| node (incl. React/Vue/Next) | ✅ | ✅ | ✅ `npm run build/test` lifecycle | package.json scripts + Makefile |
| python | ✅ | ✅ | ✅ `python3 -m unittest discover` | pyproject/requirements → `python3 -m unittest discover` |
| go | ✅ | ✅ | ✅ `go build ./...` + `go test ./...` | go.mod → `go build/test/vet ./...` |
| java (Maven + Gradle) | ✅ | ✅ | ✅ `mvn -q -B test` / `gradle build` | pom.xml → `mvn`, build.gradle → `gradle` |
| rust / ruby / php / swift / dotnet | ✅ | ✅ (under-scores only, never over) | ⚠️ cross-stack gates only + explicit "not supported yet" notice | — |

**Primary stack rule**: node > python > go > java for mixed repos (one workflow per repo). Non-supported stacks get an explicit notice — never silent npm gates. The audit's `agents-commands` check credits the stack lifecycle commands too (go/java repos can now score 2/2).

`check` (M3) makes the loop repeatable: re-run `scripts/check.ts --root <path>` any time — in CI, before a release, or when the user says "is anything drifting?". First run records a baseline (`.ai-native/baseline.json`); later runs report the score delta, manifest drift (files the manifest declares but that are missing, mapped back to the transform stage that installs them), and fixed suggestions. Check only reports — transform does the fixing (same separation as audit/transform). When installed templates go stale (see sync below), check's suggestions say so and `sync` applies the current ones.

The installed CI workflow (Stage 2) enforces this as a hard gate too: the `manifest-consistency` job fails the build when a manifest-listed file is missing (naming the file and the restoring transform stage) or when the installed templates are older than the workflow's baked version (pointing at `sync`) — drift turns CI red until transform/sync fixes it.

## sync — the workflow (M4)

When spooner itself advances — a new skill version whose templates changed (newer pre-commit rev pins, actions versions, gate configs) — the template files it installed earlier go stale. `sync` is the versioned re-sync: compare installed vs current templates, one-click apply. **Naming**: `sync` not "upgrade" — transform is the AI-ification of the repo; upgrading spooner itself is replacing the skill package (distribution, not a command); sync re-syncs the installed artifacts to the current tool version (uv `sync` semantics).

**Agent-driven procedure:**

1. **Dry-run first, always**: `node <skill-dir>/scripts/sync.ts --root <path> --dry-run` — classifies every manifest-recorded file per the table below; nothing is written.
2. **Confirm the plan with the user, then apply**: `node <skill-dir>/scripts/sync.ts --root <path>` — replaces `outdated` files with the current template bytes, restores `missing` ones, stamps the touched stages in `.ai-native.yml` (`templateVersion` + date), and reports post-apply manifest consistency plus the rollback command (`git restore …`).
3. **Never overwrite user edits**: a file that differs from the template at the same version is `modified` — reported and left alone (the same red line as transform's conflicts).
4. **No manifest**: a repo without `.ai-native.yml` is not synced — the report says to run `transform --stage 2` first.
5. **Generated files are out of scope**: AGENTS.md / CLAUDE.md are reported as `generated` and never written — re-run `transform --stage 3` to regenerate them.

| Status | Meaning | sync (apply) action |
|---|---|---|
| `up-to-date` | installed bytes == current template | nothing |
| `outdated` | installed from an older template version (version pair in the report) | replace with the current template |
| `modified` | same version, bytes differ (user edits) | never touch |
| `missing` | manifest records it, file is gone | restore from the template |
| `generated` | AGENTS.md / CLAUDE.md — not template-managed | never touch (re-run `transform --stage 3`) |

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

### Check report, first run (real output — the spooner repo itself, 2026-08-04)

```markdown
# Check Report

- Score: **16/20** · Maturity: stable · Root: .

- Baseline: none (first run)

- Manifest drift: none

- Gaps: agents-commands, cfg-format, cfg-test, struct-layout

## Suggestions

- First check — baseline recorded. Re-run later to see readiness drift.
```

The second run on the same repo reports `delta: 0` and "Readiness unchanged"; after a gap is fixed (e.g. a lint config added), it reports `delta: +1`; if a manifest-listed file is deleted, it reports `Manifest drift: <file>` and "re-run transform stage N to restore them".

### Sync report, dry-run (real output — synthetic fixture with a stale install, 2026-08-04)

```markdown
# Sync Report

- Root: . · Dry-run: true · Templates: installed 0.1.1 → current 0.1.1

| File | Stage | Status | Version |
|---|---|---|---|
| .commitlintrc.json | 2 | up-to-date | — |
| .pre-commit-config.yaml | 2 | outdated | 0.0.9 → 0.1.1 |
| AGENTS.md | 3 | generated | — |
| CLAUDE.md | 3 | generated | — |
| docs/sdd/spec.md | 4 | up-to-date | — |

- Manifest consistency: consistent

dry-run: 1 outdated (apply replaces), 0 missing (apply restores), 0 modified (user edits — never touched), 2 generated (not template-managed), 5 tracked file(s)
```

The fixture simulated an older install (`templateVersion: "0.0.9"` + a changed pre-commit rev pin). Apply (without `--dry-run`) replaces the one `outdated` file with the current template bytes, stamps `templateVersion` on the stage, and reports `rollback: git restore .pre-commit-config.yaml`. A user-edited file at the same version reports `modified` and is never touched.

## Red lines

- Commands are derived from real files, never invented — a gap is reported, never faked
- Every step is verified and rollback-able — never break an existing build
- audit is read-only — it never writes to the audited repository
- The report is deterministic — no timestamps, no LLM-generated suggestions (fixed copy)
- transform never overwrites an existing file whose content differs — conflicts are reported, the user decides
- sync never overwrites a `modified` file (user edits at the current template version) — it replaces only `outdated`/`missing` template files and reports the rollback command (`git restore …`)
- transform verifies the declared build/test commands before and after each applied stage; on failure it names the rollback command (`git restore …`)
- Scripts are zero-dependency and only do what they declare (scan + report + install)
