---
name: spooner
description: Make a git repository ready for AI — audit its AI coding readiness, score it out of 10 with a gap list and maturity assessment, using deterministic zero-build scripts. Use when the user asks to audit or improve a repository's readiness for AI coding agents, or to run the audit / transform / check / sync workflow.
license: MIT
compatibility: Node.js >= 22.18 + git (scripts are TypeScript run natively via type stripping — no build step, zero third-party dependencies)
---

# Spooner

> Audit a codebase's **AI coding readiness**, score it, then transform it in place — install CI gates, generate an AGENTS.md, adopt a spec-driven workflow. Every step verifiable, never breaking the existing build.
>
> **Status: all milestones shipped — `detect`, `audit`, `transform`, `check`, `sync`, `badge` available; the installed CI workflow hard-gates manifest consistency; transform supports node / python / go / java / rust; the installed commitlint gate enforces (hook install step + CI commit-msg check + gate-active audit); transform is context-aware (SKILL.md context probe + CI-platform routing — non-GitHub repos skip the workflow with an explicit notice; the generated pre-commit config follows the repo's detected tooling — husky/lefthook/yorkie ecosystems keep their own hooks (yorkie includes the legacy gitHooks field; a dead husky dependency with no hooks config does not block the gate install)); the badge matches the README's existing badge style (5 shields styles + probe).**

## Workflow

| Step | Available | Scripts / status |
|---|---|---|
| audit — detect and score readiness (repeatable health check) | ✅ M1 | `scripts/detect.ts` + `scripts/audit.ts` |
| transform — incremental, verifiable, rollback-able changes (gates → AGENTS.md → SDD) | ✅ M2 | `scripts/transform.ts` |
| check — continuously detect drift (repeatable, with records) | ✅ M3 | `scripts/check.ts` |
| sync — re-sync installed templates when the tool advances (versioned, one-click) | ✅ M4 | `scripts/sync.ts` |
| badge — render a readiness badge matched to the README's existing style | ✅ M9 | `scripts/badge.ts` |

## Prerequisites

- **Node.js >= 22.18** — the scripts are TypeScript run natively via type stripping; there is no build step. On older Node, `audit.ts` prints an upgrade hint and exits.
- **git** — freshness checks and maturity gating read commit history.
- **GitHub reachability for pre-commit** — the generated `.pre-commit-config.yaml` fetches its hook repos (pre-commit-hooks, markdownlint-cli2, commitlint, gitleaks) from GitHub when pre-commit runs. With GitHub unreachable (no mirror/proxy configured), pre-commit cannot prepare the hook environment and commits are **blocked** — the generated config's header says so. CI (GitHub Actions) is unaffected.
- **Android/kotlin builds need environment config, not a broken build** — the java stack gate runs `./gradlew build`; an Android project without the SDK configured (ANDROID_HOME / local.properties) fails verification. Stage 2's report names this and the escape hatch: local commits can proceed with `SKIP=java-test`; the CI hard gate needs the SDK configured (or a setup-android step).
- **Stack toolchains** — stage 2's verification and the installed CI gate run the stack's lifecycle commands (`npm` / `python3 -m unittest` / `go build` / `mvn` / `cargo`), so the stack toolchain must be available where `transform` runs (CI sets it up itself via setup-node / setup-python / setup-go / setup-java / dtolnay-rust-toolchain).
- The scripts are **zero-dependency** (Node builtins only). `detect` and `audit` are **read-only** by default; `audit --verify` additionally **executes** the traced lifecycle commands to verify them (see below); `transform`, `check`, `sync` and `badge` write only what they declare (installed template files / the `.ai-native.yml` manifest / the `.ai-native/baseline.json` ledger / `assets/badge.svg` + `assets/audit-report.md`).

## Running the scripts

Both scripts accept `--root <path>` (default: the current working directory) and can be run from anywhere:

```sh
node <skill-dir>/scripts/detect.ts --root /path/to/repo
node <skill-dir>/scripts/audit.ts --root /path/to/repo [--format json|markdown] [--verify]
node <skill-dir>/scripts/transform.ts --root /path/to/repo [--stage 2|3|4|all] [--dry-run] [--ci github|gitlab|none] [--format json|markdown]
node <skill-dir>/scripts/check.ts --root /path/to/repo [--format json|markdown]
node <skill-dir>/scripts/sync.ts --root /path/to/repo [--dry-run] [--format json|markdown]
node <skill-dir>/scripts/badge.ts --root /path/to/repo [--style flat|flat-square|plastic|for-the-badge|social] [--format json|markdown]
```

(When developing this skill inside the spooner repo, `<skill-dir>` is `skills/spooner`.)

- `detect.ts` always prints JSON: `{ root, stacks, manifests }` — the detected stacks plus one entry per known manifest (`package.json`, `pyproject.toml`, `go.mod`, …) with an `exists` flag.
- `audit.ts` defaults to JSON (machine-parseable); `--format markdown` prints the human-readable report. Command tracing is **static** — `agents-commands` evidence marks "static trace, not executed"; `--verify` actually runs the traced lifecycle commands (build/test, same strings as transform stage 2) and the evidence reports passed / FAILED (exit + stderr) / tool not installed (exit 127 — a missing local tool is not a failing build).
- `transform.ts` defaults to `--stage all` status; `--stage 2|3|4` applies one stage, `--dry-run` shows the plan without writing anything.
- `check.ts` re-runs the audit, compares against the stored baseline and the manifest, and reports drift — defaults to JSON; `--format markdown` for humans.
- `sync.ts` compares manifest-recorded template files against the current skill templates and re-syncs them — defaults to **apply** (replaces outdated, restores missing); `--dry-run` shows the per-file plan without writing.
- `badge.ts` re-runs the audit (never a stale score), renders a shields-style readiness badge into `assets/badge.svg`, writes the audit report as `assets/audit-report.md` (the badge links to it), and prints the README insertion snippet — probing the root README and matching the dominant existing badge style (`--style` overrides).

## The audit workflow (M1)

1. **Detect the stack** (optional — for context): `node <skill-dir>/scripts/detect.ts --root <path>`. The audit re-runs detection internally, so this is only needed if you want manifest details up front.
2. **Score the repository**: `node <skill-dir>/scripts/audit.ts --root <path> --format markdown`.
3. **Read the report**:
   - **Score out of 10** — full marks is 10, but a 10 requires every one of the 17 checks to max out (existence + quality signals + per-stack attainable ceilings), which makes it almost unreachable in practice — the pylint case: the standard library scores 9.x, never 10. **A 9.5 is the excellent benchmark; 8 = good.** Weighted categories: Agent Setup 4.5 (AI-specific core) · Configuration 2 · Integrity 1.5 (generic devops — helpful to AI but not AI-specific, deliberately weighted lower) · Freshness 0.5 (deps-locking only — code activity is **not** scored: a dormant repo is not worse than an active one) · Structure 1.5. Every check scores `max × coefficient` (0.2 steps → 0.1 granularity), grading **deterministic quality signals** — command traceability, CI job depth, hook installation state, manifest consistency — not bare existence. **Every point carries evidence** — a real file, git state, or a command traceable to the repo. No evidence → 0.
   - **Maturity** decides what to tell the user (below).
   - **Gaps** are the checks scoring below max; each has `evidence` and a `fix` hint. **Suggestions** are fixed copy per category pointing at transform stages.
4. **Never invent commands**: a command may only be reported as evidence if it exists in the repo (package.json scripts / Makefile / CI config). If it can't be traced, that's a gap — not a reason to fabricate.

### Maturity gating — what to tell the user

| Maturity | Deterministic rule | Response |
|---|---|---|
| skeleton | fewer than 5 commits | The score is still reported, with a "too early" note. Tell the user the repo is too young to transform and to re-run after it stabilizes. |
| stable | ≥ 5 commits, with a buildable command (or an agent file / CI present) | Normal path: report → suggest transform (Stage 2 gates first, then Stage 3 AGENTS.md). |
| legacy | ≥ 5 commits, no agent file, no CI | Normal path with **conservative Stage 2**: the install is warn-only — a pre-existing broken build is reported **with the reason** (stderr + exit code) and the gates still install; the installed hooks are hard gates by design (local ⊇ CI — commits stay blocked until the build is fixed) |

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

0. **Probe the context first** (spec 0008 + spec 0010): before planning, ask the owner six questions and pick the mode:
   1. CI platform? (GitHub Actions / GitLab CI / Jenkins / none)
   2. Is the repo on GitHub? (decides whether `.github/workflows` applies)
   3. May local git hooks be installed? (commit-msg hook policy)
   4. Tech-debt constraints? (Spring/Node major upgrades, dependency policy)
   5. Gate strictness? (warn-only / hard / audit-only)
   6. Git-hook tool preference? (pre-commit / husky / lefthook / keep the existing setup — decides whether Stage 2 installs the generated pre-commit config or skips with a notice)
   Modes: **full** (GitHub + allowed → the stages below), **no-workflow** (non-GitHub CI → cross-stack gates only; the CI workflow is skipped with an explicit notice — see Stage 2), **audit-only** (nothing written — deliver the Stage 1 report and stop). The scripts stay deterministic; the mode is the agent's call from the probed context. **Transformation permission comes from the owner's situation, not the tool's assumption** — on a legacy repo whose owner cannot touch CI, "just audit" is a valid outcome.
1. **Stage 1 = the audit** (above): report + plan. Show the user the score and the gap list; agree on the stage order. Default order: Stage 2 (gates) → Stage 3 (agent files) → Stage 4 (SDD).
2. **Dry-run first, always**: `node <skill-dir>/scripts/transform.ts --root <path> --stage 2 --dry-run` — prints the exact plan (files to write / keep / conflict) and the build command that will be verified. Nothing is written.
3. **Apply with user confirmation**: `--stage 2` writes the missing gate files and verifies the repo's declared build/test commands **before and after**; if the post-apply check fails, the report lists the files and the rollback command (`git restore …`) and exits non-zero. **Then install the git hooks**: `pre-commit install --hook-type commit-msg` — plain `pre-commit install` installs only the pre-commit stage and leaves the commitlint hook dead (config ≠ enforcement); the commit-msg hook is what actually checks every commit.
4. **Respect conflicts**: an existing file whose content differs from the template is **never overwritten** — it's reported as `conflict` and left to the user's decision.
5. **Re-run freely**: applying an already-installed stage is a reported no-op (idempotent). The `.ai-native.yml` manifest records what each stage installed (date, files); `transform.ts --stage all` reports per-stage status plus **manifest consistency** (installed files vs the manifest — the drift seed).
6. **Verify it took effect — not just that files were written** (the config ≠ enforcement lesson, productized): after each applied stage, prove the gates are real.
   - Re-run the audit: `cfg-hooks` must now score **1/1** (the git hooks are actually installed — the gate-active check), and the configuration/integrity scores reflect the installed gates.
   - Run `pre-commit run --all-files` once — the hooks execute; nothing is silently dead.
   - **A first run that fails on pre-existing repo debt is the gate working, not an install failure** — hard gates are local ⊇ CI by design, so legacy repo docs (markdownlint violations — MD040/MD012/MD014 are the common ones) block the first full run. **Triage by scale**: a handful of violations (≤ ~20) → fix them; a large debt (real-world corpora run to thousands — dogfood review 2026-08-09: a Go monorepo, 24 files / ~21k errors across MD022/MD032/MD024) → fixing is not realistic in one pass — run with `SKIP=markdownlint-cli2` and report it as a finding, or extend the generated `.markdownlint-cli2.yaml` `ignores` list for vendored/upstream docs. Either way the owner decides; never roll back the install (a Makefile-less Go repo's 5 violations = fixable, a Go monorepo's ~21k = SKIP — same gate, different triage).
   - In full mode, prove commitlint actually rejects: write a deliberately invalid message (e.g. `echo "bad commit message" > .git/COMMIT_EDITMSG`), run `pre-commit run --hook-stage commit-msg --commit-msg-filename .git/COMMIT_EDITMSG` — it must **fail**; restore the file afterwards (`git log -1 --format=%B > .git/COMMIT_EDITMSG`).

| Stage | What it does | Outputs |
|---|---|---|
| 2 — gates (install warn-only; active hooks hard) | commitlint + pre-commit (markdownlint + gitleaks + **stack-aware generated config**: the pre-commit hook set follows the repo's detected tooling — ruff/pytest for python, eslint/tsc for node, gofmt/vet for go, mvn for java, cargo fmt/clippy for rust; check-only, rev-pinned; **the config hard-gates the `.ai-native.yml` ledger locally** — a self-contained manifest-consistency hook (baked EXPECTED) mirroring the CI drift gate, so stale/drifting ledgers turn local pre-commit red (runs on python3 — guaranteed wherever pre-commit runs); **husky/lefthook/yorkie ecosystems keep their own hooks — the config is skipped with an explicit notice; a dead husky dependency (no .husky/, no package.json field) installs the gates**) + **stack-aware** CI workflow (warn-only quality jobs; hard gates: declared lifecycle commands executable + `.ai-native.yml` consistency — drift turns CI red). **No-workflow mode** (non-GitHub CI, spec 0008): the three cross-stack gates only — the workflow is skipped with an explicit "CI workflow skipped: detected <platform>" notice, and the manifest records the gates without the workflow file. Platform detection reads local CI files first, then the origin remote host (a greenfield repo on a GitLab remote no longer receives a dead `.github/workflows` file); the auto-detection is overridable with `--ci github\|gitlab\|none` (the Stage 0 questionnaire's answer lands on the CLI — no hand-editing the manifest) | `.commitlintrc.json`, `.pre-commit-config.yaml` (generated — re-run `--stage 2` to regenerate), `.markdownlint-cli2.yaml`, `.github/workflows/ai-native.yml` (per-stack template; absent in no-workflow mode) |
| 3 — agent files | AGENTS.md generated from **real commands only** (package.json scripts / Makefile / stack lifecycle: `mvn`, `go`, `python3 -m unittest`, `cargo`) + CLAUDE.md bridge | `AGENTS.md`, `CLAUDE.md` (symlink; `@AGENTS.md` import on Windows) |
| 4 — SDD (optional) | spec/plan/tasks templates + SDD convention in AGENTS.md + spec-existence CI gate (**platform-routed like stage 2** — the gate installs only where the GitHub workflow applies; skipped with "… (SDD spec gate)" otherwise, 2026-08-07) | `docs/sdd/*.md`, `.github/workflows/sdd.yml` (absent in no-workflow mode), AGENTS.md convention |

### Stack support (M6)

| Stack | detect | audit | transform gates + CI workflow | AGENTS.md commands |
|---|---|---|---|---|
| node (incl. React/Vue/Next) | ✅ | ✅ | ✅ `npm run build/test` lifecycle | package.json scripts + Makefile |
| python | ✅ | ✅ | ✅ `python3 -m unittest discover` | pyproject/requirements → `python3 -m unittest discover` |
| go | ✅ | ✅ | ✅ `go build ./...` + `go test` (e2e-aware — excludes /test/e2e) | go.mod → `go build/test/vet ./...` |
| java (Maven + Gradle, incl. kotlin/Android `build.gradle.kts` / `settings.gradle(.kts)`) | ✅ | ✅ | ✅ `mvn -q -B test` / `gradle build` | pom.xml → `mvn`, build.gradle(.kts) → `gradle` |
| rust | ✅ | ✅ | ✅ `cargo build` + `cargo test` (fmt/clippy via the M10 generated pre-commit gates) | Cargo.toml → `cargo build/test/fmt/clippy` |
| php | ✅ | ✅ (composer.lock / phpunit / phpcs / phpstan / php-cs-fixer signals score; the full-lifecycle band is unreachable) | ⚠️ cross-stack gates only + explicit "not supported yet" notice | — |
| ruby / swift / dotnet | ✅ | ✅ (under-scores only, never over) | ⚠️ cross-stack gates only + explicit "not supported yet" notice | — |

**Primary stack rule**: node > python > go > java > rust for mixed repos (one workflow per repo). Non-supported stacks get an explicit notice — never silent npm gates. The audit's `agents-commands` check credits the stack lifecycle commands too (go/rust/java repos can now score 2/2); php test signals (phpunit.xml / phpunit in composer.json) are traced beyond the primary stack in mixed node+php repos.

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

## badge — the workflow (M9)

The badge is the recurring-impression asset: pasted once into the README, it renders on every page load and links to the full audit report (every point carries evidence). Run it after transform, once the score reflects the installed gates.

**Agent-driven procedure:**

1. **Generate**: `node <skill-dir>/scripts/badge.ts --root <path>` — re-runs the audit, renders `assets/badge.svg`, writes `assets/audit-report.md`, and prints the README snippet + the probe decision.
2. **Review the probe decision**: the script matches the root README's dominant existing badge style (strict majority of recognized shields.io `style=` values; no signal or tie → `flat` — one style per row is the ecosystem convention, and consistency > freshness: a dated existing style is matched, not corrected). The evidence line shows what was found and decided.
3. **Override when the owner prefers another style**: `--style <name>` always wins over the probe.
4. **Insert with the user's confirmation**: paste the printed snippet into the README badge row (or start a new row when the README has no badges). The badge links to `assets/audit-report.md` — the score's evidence.
5. **Re-generate after meaningful change**: re-run badge.ts after transform stages or whenever the audit score moves. The badge is a static file regenerated on demand — no external badge service, no data leaves the repo.

## Examples

### Markdown report (real output — the spooner repo itself)

```markdown
# AI-Readiness Report

- Stack: node · Maturity: stable · Score: **9.2/10**

## Score by category

| Category | Score | Max |
|---|---|---|
| Agent Setup | 4.5 | 4.5 |
| Configuration | 1.9 | 2 |
| Integrity | 1.5 | 1.5 |
| Freshness | 0.5 | 0.5 |
| Structure | 0.8 | 1.5 |

## Gaps

| Check | Score | Evidence | Fix |
|---|---|---|---|
| cfg-format | 0.4/0.5 | .prettierrc + format | transform Stage 2 (CI format job) |
| struct-layout | 0/0.5 | no src/, lib/, or packages/ directory | organize sources under src/, lib/, or packages/ (not covered by transform) |

## Suggestions

- Configuration: transform Stage 2 (CI format job)
- Structure: organize sources under src/, lib/, or packages/ (not covered by transform)
```

### JSON output (abridged — `items` holds all 17 checks; the first three are shown)

```json
{
  "schemaVersion": 3,
  "root": ".",
  "stacks": ["node"],
  "maturity": "stable",
  "maturityNote": null,
  "score": {
    "total": 9.2,
    "max": 10,
    "byCategory": {
      "agent-setup": { "score": 4.5, "max": 4.5 },
      "configuration": { "score": 1.9, "max": 2 },
      "integrity": { "score": 1.5, "max": 1.5 },
      "freshness": { "score": 0.5, "max": 0.5 },
      "structure": { "score": 0.8, "max": 1.5 }
    }
  },
  "items": [
    {
      "id": "agents-md",
      "category": "agent-setup",
      "score": 0.5,
      "max": 0.5,
      "evidence": "AGENTS.md: 166 lines, 5 traceable commands",
      "fix": "keep commands in AGENTS.md traceable to real scripts/Makefile"
    },
    {
      "id": "agents-bridge",
      "category": "agent-setup",
      "score": 0.5,
      "max": 0.5,
      "evidence": "CLAUDE.md: symlink to AGENTS.md",
      "fix": "transform Stage 3"
    },
    {
      "id": "agents-length",
      "category": "agent-setup",
      "score": 0.5,
      "max": 0.5,
      "evidence": "AGENTS.md: 166 lines (optimal band 30-200)",
      "fix": "trim AGENTS.md to ≤200 lines — merge content, don't delete it"
    }
  ],
  "gaps": ["cfg-format", "struct-layout"],
  "suggestions": [
    "Configuration: transform Stage 2 (CI format job)",
    "Structure: organize sources under src/, lib/, or packages/ (not covered by transform)"
  ]
}
```

All 17 check ids: `agents-md`, `agents-bridge`, `agents-length`, `agents-commands`, `agents-sdd`, `cfg-lint`, `cfg-format`, `cfg-hooks`, `cfg-ci`, `cfg-test`, `sec-env`, `sec-scan`, `sec-ci`, `drift`, `fresh-deps`, `struct-readme`, `struct-layout`.

### Transform status (real output — the spooner repo itself)

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

### Check report, first run (real output — the spooner repo itself)

```markdown
# Check Report

- Score: **9.2/10** · Maturity: stable · Root: .

- Baseline: none (first run)

- Manifest drift: none

- Gaps: cfg-format, struct-layout

## Suggestions

- First check — baseline recorded. Re-run later to see readiness drift.
```

The second run on the same repo reports `delta: 0` and "Readiness unchanged"; after a gap is fixed (e.g. a lint config added), it reports `delta: +1`; if a manifest-listed file is deleted, it reports `Manifest drift: <file>` and "re-run transform stage N to restore them".

### Sync report, dry-run (real output — synthetic fixture with a stale install)

```markdown
# Sync Report

- Root: . · Dry-run: true · Templates: installed 0.9.0 → current 0.10.0

| File | Stage | Status | Version |
|---|---|---|---|
| .commitlintrc.json | 2 | outdated | 0.9.0 → 0.10.0 |
| .pre-commit-config.yaml | 2 | generated | — |
| AGENTS.md | 3 | generated | — |
| CLAUDE.md | 3 | generated | — |
| docs/sdd/spec.md | 4 | up-to-date | — |

- Manifest consistency: consistent

dry-run: 1 outdated (apply replaces), 0 missing (apply restores), 0 modified (user edits — never touched), 3 generated (not template-managed), 5 tracked file(s)
```

The fixture simulated an older install (`templateVersion: "0.8.0"` + a changed commitlint config). Apply (without `--dry-run`) replaces the one `outdated` file with the current template bytes, stamps `templateVersion` on the stage, and reports `rollback: git restore .commitlintrc.json`. The pre-commit config is **generated-class since M10** — sync never writes it; re-run `transform --stage 2` to regenerate from the repo's detected tooling. A user-edited file at the same version reports `modified` and is never touched.

## Red lines

- Commands are derived from real files, never invented — a gap is reported, never faked
- Every step is verified and rollback-able — never break an existing build
- audit is read-only — it never writes to the audited repository
- The report is deterministic — no timestamps, no LLM-generated suggestions (fixed copy)
- transform never overwrites an existing file whose content differs — conflicts are reported, the user decides
- sync never overwrites a `modified` file (user edits at the current template version) — it replaces only `outdated`/`missing` template files and reports the rollback command (`git restore …`)
- transform verifies the declared build/test commands before and after each applied stage; on failure it names the rollback command (`git restore …`)
- Scripts are zero-dependency and only do what they declare (scan + report + install)
- badge.ts writes only `assets/badge.svg` + `assets/audit-report.md` and never modifies the README — insertion is the agent's step with user confirmation
- The pre-commit config is **generated from detected tooling** (M10) — re-run `transform --stage 2` to regenerate; `sync` reports it as `generated` and never rewrites it
