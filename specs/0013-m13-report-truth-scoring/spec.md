---
status: approved
target: M13
date: 2026-08-06
---

# M13: report truth + quality scoring (10-point scale, 0.1 granularity)

## Background

Four dogfood audits (DAG-chat / headroom / kuan-chat / spooner, 2026-08-06 — full copies, AI-readiness artifacts stripped, transform applied end-to-end) plus two owner decisions converge on one finding: **the audit report and the transform report must be truthful — scores must reflect quality, not existence, and every hint must name an action the toolset actually delivers.**

1. **Existence checks overstate readiness** — a 16/20 repo with 7 hand-built workflows scored *below* a freshly transformed 18/20 copy; a 220-line user-written AGENTS.md docked 0.5 while a 42-line generated one scored full; a lint-only CI scored the same as lint+test+security; a stale/drifting manifest scored the same as a consistent one.
2. **Owner decision: 10-point scale** — readiness scores conventionally read as x/10; the model becomes 0–10 with 0.1 granularity (each check's score is `max × quality coefficient`, coefficients step by 0.2, so every possible score is a 0.1 multiple).
3. **Fix hints transform cannot deliver** — `cfg-format`/`struct-layout` said "transform Stage 2" though stage 2 never touches them; `cfg-test` said "transform Stage 2 (add a test command)" while transform never invents commands (killer-gate red line: the CI template is declared-scripts-only) and the audit itself recorded "no test framework found"; `agents-length` said "trim AGENTS.md" with no target. A repo following the report gets stuck — trust damage.
4. **Fixed suggestion copy decoupled from per-check scores** — "Add a README" fired on repos with four READMEs; fully-scoring categories repeated their copy.
5. **Silent boundaries** — on a root-node + `backend/`-python monorepo the generated gate is near-idle (no stack hooks, hard gate skipped) while the report says nothing about the sub-stack; hook installation depends on a manual `pre-commit install` with no post-apply prompt; stage 3 on a user-written AGENTS.md reports only "conflict kept".
6. **transform's own report lied once** — stage 2's build-verification message said "build green before+after" while `buildCheck.before` was false (the spooner self-dogfood caught it; the parity test reads the installed workflow, ENOENT on a zero-state tree).

"Quality" here is strictly bounded by the determinism red line: **no LLM judgment, no subjective opinion** — every signal is a verifiable fact (command traceability, file content structure, CI job presence, manifest consistency, hook installation state, git history).

## Goal (one sentence)

The audit scores readiness on a 0–10 scale with 0.1 granularity where each of the 19 checks grades deterministic quality signals instead of bare existence; fix hints and suggestions name only deliverable actions; the report surfaces monorepo sub-stacks; transform's reports prompt the manual hook step, explain user-written conflicts, and never contradict their own data.

## Scope (what it does)

- **Scale**: `SCORE_MAX` 20 → 10; category maxima 6/5/4/3/2 → 3/2.5/2/1.5/1 (×0.5, same ratios); per-check maxima 0.5 (most) or 1.0 (`agents-commands`); coefficient set {0, 0.2, 0.4, 0.6, 0.8, 1.0}
- **Per-check quality matrix** (deterministic signals):
  - **agents-md** (0.5): content depth + command traceability — a command table tracing to package.json scripts / Makefile scores 0.5; bare existence 0.1–0.2
  - **agents-bridge** (0.5): real symlink to AGENTS.md (or `@AGENTS.md` import) 0.5; content reference only 0.3
  - **agents-length** (0.5): optimal band 30–200 lines 0.5 (the generated contract at ~40 lines and a well-kept 160-line contract both score full); 20–30 / 200–300 → 0.3; 10–20 / 300–400 → 0.2; <10 / >400 → 0.1
  - **agents-commands** (1.0): nothing 0; commands untraceable 0.2; one command traceable 0.4; build+test 0.6; full stack lifecycle 0.8; lifecycle + AGENTS.md documentation 1.0
  - **agents-sdd** (0.5): AGENTS.md mentions a spec workflow 0.2; + spec directory 0.3; + state frontmatter 0.4; + CI spec gate 0.5
  - **cfg-lint / cfg-format** (0.5 each): config and command 0.4; + CI job 0.5; config or command alone 0.2
  - **cfg-hooks** (0.5): mechanism 0.1; + discipline config 0.2; + hooks installed 0.4; + commit-msg stage installed 0.5
  - **cfg-ci** (0.5): empty CI 0.1; lint only 0.2; lint+test 0.4; lint+test+security 0.5
  - **cfg-test** (0.5): framework config or command 0.2; both 0.3; + test files exist 0.4; + non-empty (assertions/cases) 0.5
  - **sec-env** (0.5): no `.env` or ignored 0.5; unignored 0.1; tracked 0 (unchanged semantics, rescaled)
  - **sec-scan** (0.5): gitleaks mentioned 0.2; pre-commit hook declared 0.3; + hook installed 0.5
  - **sec-ci** (0.5): tool mentioned in CI 0.2; dedicated security job 0.5
  - **drift** (0.5): manifest exists 0.2; + version matches TOOL_VERSION 0.3; + declared files present 0.5
  - **fresh-recent / fresh-active** (0.5 each): thresholds rescaled (≤90d 0.5, ≤180d 0.2; ≤30d 0.5, ≤90d 0.2)
  - **fresh-deps** (0.5): lockfile 0.5; manifest without lockfile 0.2
  - **struct-readme** (0.5): content with ≥3 headings 0.5; content only 0.3; <50 chars 0.1
  - **struct-layout** (0.5): src/lib/packages 0.5; otherwise 0 (unchanged, human-fixable)
- **Fix-hint alignment (two-sourced)**: fix strings become one source of truth per check, validated against a transform-capability list — "transform Stage N" only where stage N delivers; otherwise plain manual actions with no `transform` wording ("add a formatter config (prettier/biome) + format command", "organize sources under src/, lib/, or packages/", "trim AGENTS.md to ≤200 lines — merge content, don't delete it", "add a test framework + test script (transform never invents commands)"). `cfg-test`, `cfg-format`, `agents-length`, `struct-layout` are manual-action by rule
- **Suggestion filtering**: category suggestions emit only when that category has a below-max check
- **Monorepo sub-stack note**: bounded one-level scan for known manifests in subdirectories (excluding `node_modules`/`.venv`); report gains `subStacks` (JSON field + markdown line) — "detected sub-stack(s): python (backend/) — root detection only; transform installs the root stack's gates; run transform per sub-stack"
- **Stage-2 hook-install prompt**: after apply (and on dry-run report), when no `pre-commit`/`commit-msg` hook exists in `.git/hooks/` — "hooks not installed — run `pre-commit install --hook-type pre-commit --hook-type commit-msg`" (prompt only; transform never installs hooks)
- **Stage-3 user-written conflict note**: existing differing AGENTS.md → report names both line counts and the merge option ("existing AGENTS.md is user-written (N lines); the generated contract is M lines of real commands — keep yours or merge")
- **Build-verification report honesty**: stage 2's message distinguishes green-both / pre-existing-failure-then-green / after-failure-rollback; "green before+after" never appears when `before` was false
- **Report schema**: JSON `schemaVersion` 1 → 2 (score ≤10, fractional per-item max, `subStacks`)
- **Badge re-map** (spec 0009 revision): tiers AI-Native ≥9 / AI-Friendly ≥7 / AI-Curious ≥5 / AI-Aware ≥3 / AI-Absent 0; colors green ≥8, yellow ≥5, red <5; message `x/10`
- **Consumers**: check.ts baseline deltas adapt; v1 baselines re-baselined on first v2 run with a notice; docs (SKILL.md / README / AGENTS.md examples, the launch-plan before/after narrative) update to 10-scale
- **Version contract** (spec 0004/0005): TOOL_VERSION 0.5.0 → 0.6.0 + baked `EXPECTED`×5 + docs/08 ledger row + dogfood `sync` + regenerated badge

## Non-goals (explicitly out)

- **LLM/subjective quality** — no semantic scoring, no style/architecture opinions (determinism red line)
- **Adding or removing checks** — the 19-check set stays; only scoring semantics + copy change
- **Arguing per-check weights** — the matrix is pinned by this spec; calibration (kardo r=0.828) is the vision's job
- **CI workflow YAML parsing depth** — cfg-ci counts job presence via text signals, not parsed job graphs
- **Sub-stack transforms** — root-only transform model stays (spec 0008); this spec makes the boundary visible
- **Auto-installing git hooks** — the agent-driven `pre-commit install` step is product design
- **Deep CI health inspection** (does CI actually run green?) — stays a vision/calibration candidate

## Acceptance criteria (verifiable, itemized)

1. **Scale**: JSON `score.max === 10`; category maxima 3/2.5/2/1.5/1; every item `score` is a 0.1 multiple and `score <= max`
2. **Quality grading**: spooner repo scores 9.0±0.2 with the full matrix (determinism double-run diff empty); a generated-contract fixture scores agents-md/length/bridge at top bands
3. **Length banding**: 220-line AGENTS.md → `agents-length` 0.3; 42-line → 0.5
4. **CI depth**: lint-only workflow → cfg-ci 0.2; lint+test → 0.4; +security → 0.5
5. **Drift quality**: stale manifest (version != tool) → drift 0.2 (existence band, never full); version matching → 0.3; consistent (version + files) → 0.5
6. **Hook quality**: config without installed hooks → cfg-hooks 0.2; hooks incl. commit-msg → 0.5
7. **Monorepo note**: root `package.json` + `backend/pyproject.toml` fixture → `subStacks` names python with its directory; flat repo → empty; scan one level deep, vendored dirs excluded, determinism diff empty
8. **Fix alignment + source audit**: no formatter config → `cfg-format` fix without "transform Stage 2"; no test command → `cfg-test` fix names the manual action without `transform` wording (and a full transform leaves it 0/1 — the hint's honesty); across all 19 checks, no fix copy references `transform` for a check stages 2/3/4 cannot deliver
9. **Suggestion filtering**: README scoring full → "Add a README" copy absent; README missing → present
10. **Hook prompt**: no `.git/hooks/pre-commit` → stage-2 report contains the install prompt; hooks present → absent
11. **Conflict note**: longer user-written AGENTS.md → stage-3 report names both line counts + merge option; absent file → plain write, no note
12. **Build-verification honesty**: fixture failing before / passing after → message says pre-existing-failure-then-green, never "green before+after"; green both → wording unchanged; failing after → rollback wording unchanged
13. **Badge + baseline**: tierOf(9.0)=AI-Native / tierOf(6.5)=AI-Friendly / tierOf(4.0)=AI-Curious; colorOf(8) green / (5) yellow / (4) red; badge message `x/10`; check.ts writes v2 baselines, re-baselines v1 with a notice
14. **Docs + artifacts**: no "out of 20"/"x/20" left in SKILL.md/README/AGENTS.md; `assets/` regenerated; TOOL_VERSION 0.6.0 (imported dynamically in tests, never hard-coded) + EXPECTED×5 + docs/08 row
15. **Regression**: full suite green (count per `node --test` output); determinism double-run on two fixtures

## Slice plan (each slice independently verifiable)

| Slice | Content | Status |
|---|---|---|
| 1 | audit.ts: schema v2 + quality matrix + fix two-sourcing + suggestion filtering + `subStacks` + tests (1–9) | [ ] |
| 2 | badge.ts re-map + check.ts v2 baseline + tests (13) | [ ] |
| 3 | transform.ts: hook prompt + build-verification honesty + conflict note + TOOL_VERSION 0.6.0 + EXPECTED×5 + docs/08 row + docs cleanup + dogfood sync + badge regen (10–12, 14, 15) | [ ] |

## Risks

- **Score deflation perception**: x/10 looks lower than x/20 (18/20 → 9.0/10 exact at full marks; quality banding can drop some repos further) — the matrix is the contract; the launch narrative must be rewritten honestly
- **Test churn**: every audit/badge test asserts scores/copy — slices 1–2 rewrite them; version assertions keep importing `TOOL_VERSION` dynamically
- **check.ts baseline migration**: v1 baselines delta against v2 scores — re-baseline on first v2 run with a notice
- **Threshold debates**: band boundaries (30–200 lines, 90/180 days) are pinned by acceptance; calibration is the vision's job
- **Suggestion/fix copy tests rot**: assertions import from the same modules they test (single source of truth), never literal copies
