---
status: shipped
target: M8
date: 2026-08-04
---

# M8: situational transform (CI-platform awareness + agent-side context probing)

## Background

Owner insight (company-repo scenario): the installed CI workflow assumes the target repo lives on GitHub — `.github/workflows/ai-native.yml` is a dead file on GitLab / Jenkins / self-hosted CI repos (never triggered, possibly against company CI governance), and writing `.github/` may itself violate approval flows. For a legacy Java/Spring repo the whole transform can read as overreach ("僭越") when the owner cannot upgrade Spring, cannot touch CI, or simply does not want gates installed. The audit is already honest across platforms (`cfg-ci` scans gitlab-ci/circleci/travis/Jenkins/azure), but transform only ever produces GitHub Actions — an asymmetry.

Design principles this spec pins:

- **Determinism stays in the scripts**; context probing lives in the **agent layer** (SKILL.md) — the Skill form can ask questions a CLI cannot. transform.ts stays deterministic; the _mode_ it runs in is decided by the agent + user from probed context.
- **Transformation permission comes from the repo owner's situation, not the tool's assumption.** The default answer to "should we install gates?" may be "no, just audit."

## Goal (one sentence)

Transform asks the right context questions first (CI platform, GitHub vs internal, hook policy, tech-debt constraints, gate strictness), then adapts Stage 2 — GitHub repos install the workflow as today; non-GitHub repos install cross-stack gates only with an explicit skipped-workflow notice; audit-only repos get nothing written.

## Scope

- **SKILL.md — context probe (agent step)**: before Stage 2, the agent asks the context questions (below) and picks the mode:
  1. CI platform? (GitHub Actions / GitLab CI / Jenkins / none)
  2. Is the repo on GitHub? (decides whether `.github/workflows` applies)
  3. May local git hooks be installed? (commit-msg hook policy)
  4. Tech-debt constraints? (Spring/Node major upgrades, dependency policy)
  5. Gate strictness? (warn-only / hard / audit-only)
  6. Git-hook tool preference? (pre-commit / husky / lefthook / keep the existing setup — decides whether Stage 2 installs the generated pre-commit config or skips with a notice, spec 0010)
     Mode table: **full** (GitHub + allowed → current behavior) / **no-workflow** (non-GitHub → cross-stack gates only) / **audit-only** (nothing written, report + suggestions).
- **`--gates warn-only|hard`**: the strictness answer lands on the CLI like `--ci`. `hard` renders the installed workflow with the quality jobs' `continue-on-error` removed (and the header comment adjusted); `warn-only` (default) installs the template bytes verbatim — **the template files themselves stay warn-only; hard is a transform-time render**. The manifest records the choice per stage-2 entry (`gates: warn-only|hard`, absent in no-workflow mode — the manifest is the ledger of what was actually installed); re-runs without `--gates` use the recorded choice (a strictness change is an explicit decision, `--gates hard`); a strictness switch re-renders the tool-owned workflow (any strictness render of the stack's template is tool-owned — user edits stay conflicts, and the wrong-stack hint keeps its delete-and-re-run UX).
- **transform.ts — CI-platform detection + Stage-2 routing**:
  - Detect the repo's CI platform (`.gitlab-ci.yml` → gitlab, `Jenkinsfile` → jenkins, `.github/workflows/*.yml` → github, `azure-pipelines.yml` / `.circleci` → other, none) — the same file families the audit already scans. **Greenfield (no CI files): the origin remote host decides** (`git config --get remote.origin.url` → github/gitlab/other; no remote → GitHub assumption) — a GitLab remote must not receive a dead `.github/workflows` file.
  - **`--ci github|gitlab|none` overrides the auto-detection** — the probed answer lands on the CLI, no hand-editing the manifest.
  - Stage 2: GitHub (or no conflicting CI detected) → current behavior (workflow + cross-stack gates). Non-GitHub platform detected → **skip the workflow**, install the three cross-stack gates, report "CI workflow skipped: detected <platform> (non-GitHub) — cross-stack gates installed" and record the manifest without the workflow file (the manifest's `files` list is the record of what was actually installed — no schema change).
  - Stage 2 message and transform report carry the skip reason explicitly.
  - **Stage 4 routing**: the SDD spec-existence gate (`.github/workflows/sdd.yml`) follows the same routing as stage 2 — skipped with "… (SDD spec gate)" on non-GitHub platforms; the docs templates still install. `--ci` applies to both stages.
- **spec 0002 revision** (living document): Stage-2 contract gains the platform-routing rule and the skip notice.
- No TOOL_VERSION bump (template bytes unchanged — the routing and the strictness render are transform.ts behavior + SKILL.md instructions, not template content; the warn-only template stays the installed default).

## Non-goals

- GitLab CI / Jenkins workflow templates (demand-driven later; skip + explicit notice is the v1 answer)
- Dependency-upgrade suggestions (Spring major versions etc. — existing non-goal: no business-code/refactor suggestions)
- Manifest schema change (files list already records what was installed)
- A separate audit-only script mode (the audit IS the mode; SKILL.md tells the agent when to stop after Stage 1)

## Acceptance criteria (all must pass for shipped)

1. **GitLab routing**: fixture with `.gitlab-ci.yml` → stage 2 installs the three cross-stack gates, **no** `.github/workflows/ai-native.yml`, message says "CI workflow skipped" and names the platform, manifest `files` lacks the workflow
2. **Jenkins routing**: fixture with `Jenkinsfile` → same skip behavior
3. **GitHub regression**: fixture with `.github/workflows/` → current behavior (workflow installed, byte-identical to the template)
4. **No-CI routing**: fixture with no CI files + no remote → workflow installed (GitHub assumption holds for greenfield/no-CI repos — the default is still full mode)
5. **Greenfield remote routing**: fixture with no CI files + a gitlab origin remote → workflow skipped, message says "origin remote host gitlab"; a github origin remote → workflow installed
6. **--ci override**: `--ci none` on a github-detected repo skips the workflow with the explicit notice; `--ci github` on a gitlab-remote repo installs it
7. **Determinism**: two runs on the same fixture produce identical output
8. **SKILL.md probe**: the context questions + mode table land in the transform procedure
9. **spec 0002**: Stage-2 contract describes platform routing + skip notice
10. **Regression**: typecheck + markdownlint + skills-ref green; M6 acceptance re-run
11. **`--gates hard` render**: fixture installs with `--gates hard` → installed workflow has no `continue-on-error`, header names the hard gates; manifest stage-2 entry records `gates: hard`; re-run without `--gates` keeps the workflow (recorded strictness); a strictness switch (`--gates warn-only` after hard) re-renders to template bytes instead of reporting a conflict; a user-edited workflow stays a conflict
12. **No-workflow + strictness**: gitlab-routed fixture with `--gates hard` records no `gates` field (nothing to be strict about) and installs no workflow

## Slice plan

| Slice | Content                                                                         |
| ----- | ------------------------------------------------------------------------------- |
| 1     | Spec + SKILL.md context probe (questions + mode table)                          |
| 2     | transform.ts CI-platform detection + Stage-2 routing + manifest/report behavior |
| 3     | Acceptance (fixtures) + spec 0002 revision + ROADMAP/AGENTS/HANDOFF sync + ship |

## Risks

- Over-detection (a stray `Jenkinsfile` in a GitHub repo skips the workflow) — mitigation: GitHub presence wins; the skip is explicit and re-runnable (`transform --stage 2` after deleting the stray file restores full mode)
- The probe slows the agent flow — mitigation: five fixed questions, mode table is deterministic; the probe is one turn, not a survey
- Users on GitLab still want the gates — mitigation: cross-stack gates install; only the workflow is skipped, and the notice names exactly what to re-enable
- Scope creep into CI templates / upgrade suggestions (non-goals section)
