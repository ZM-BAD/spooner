---
status: shipped
target: M8
date: 2026-08-04
---

# M8: situational transform (CI-platform awareness + agent-side context probing)

## Background

Owner insight (2026-08-04, company-repo scenario): the installed CI workflow assumes the target repo lives on GitHub — `.github/workflows/ai-native.yml` is a dead file on GitLab / Jenkins / self-hosted CI repos (never triggered, possibly against company CI governance), and writing `.github/` may itself violate approval flows. For a legacy Java/Spring repo the whole transform can read as overreach ("僭越") when the owner cannot upgrade Spring, cannot touch CI, or simply does not want gates installed. The audit is already honest across platforms (`cfg-ci` scans gitlab-ci/circleci/travis/Jenkins/azure), but transform only ever produces GitHub Actions — an asymmetry.

Design principles this spec pins:

- **Determinism stays in the scripts**; context probing lives in the **agent layer** (SKILL.md) — the Skill form can ask questions a CLI cannot. transform.ts stays deterministic; the *mode* it runs in is decided by the agent + user from probed context.
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
- **transform.ts — CI-platform detection + Stage-2 routing**:
  - Detect the repo's CI platform (`.gitlab-ci.yml` → gitlab, `Jenkinsfile` → jenkins, `.github/workflows/*.yml` → github, `azure-pipelines.yml` / `.circleci` → other, none) — the same file families the audit already scans.
  - Stage 2: GitHub (or no conflicting CI detected) → current behavior (workflow + cross-stack gates). Non-GitHub platform detected → **skip the workflow**, install the three cross-stack gates, report "CI workflow skipped: detected <platform> (non-GitHub) — cross-stack gates installed" and record the manifest without the workflow file (the manifest's `files` list is the record of what was actually installed — no schema change).
  - Stage 2 message and transform report carry the skip reason explicitly.
- **spec 0002 revision** (living document): Stage-2 contract gains the platform-routing rule and the skip notice.
- No TOOL_VERSION bump (template bytes unchanged — the routing is transform.ts behavior + SKILL.md instructions, not template content).

## Non-goals

- GitLab CI / Jenkins workflow templates (demand-driven later; skip + explicit notice is the v1 answer)
- Dependency-upgrade suggestions (Spring major versions etc. — existing non-goal: no business-code/refactor suggestions)
- Manifest schema change (files list already records what was installed)
- A separate audit-only script mode (the audit IS the mode; SKILL.md tells the agent when to stop after Stage 1)

## Acceptance criteria (all must pass for shipped)

1. **GitLab routing**: fixture with `.gitlab-ci.yml` → stage 2 installs the three cross-stack gates, **no** `.github/workflows/ai-native.yml`, message says "CI workflow skipped" and names the platform, manifest `files` lacks the workflow
2. **Jenkins routing**: fixture with `Jenkinsfile` → same skip behavior
3. **GitHub regression**: fixture with `.github/workflows/` → current behavior (workflow installed, byte-identical to the template)
4. **No-CI routing**: fixture with no CI files → workflow installed (GitHub assumption holds for greenfield/no-CI repos — the default is still full mode)
5. **Determinism**: two runs on the same fixture produce identical output
6. **SKILL.md probe**: the context questions + mode table land in the transform procedure
7. **spec 0002**: Stage-2 contract describes platform routing + skip notice
8. **Regression**: typecheck + markdownlint + skills-ref green; M6 acceptance re-run

## Slice plan

| Slice | Content | Status |
|---|---|---|
| 1 | Spec + SKILL.md context probe (questions + mode table) | [x] |
| 2 | transform.ts CI-platform detection + Stage-2 routing + manifest/report behavior | [x] |
| 3 | Acceptance (fixtures) + spec 0002 revision + ROADMAP/AGENTS/HANDOFF sync + ship | [x] |

## Risks

- Over-detection (a stray `Jenkinsfile` in a GitHub repo skips the workflow) — mitigation: GitHub presence wins; the skip is explicit and re-runnable (`transform --stage 2` after deleting the stray file restores full mode)
- The probe slows the agent flow — mitigation: five fixed questions, mode table is deterministic; the probe is one turn, not a survey
- Users on GitLab still want the gates — mitigation: cross-stack gates install; only the workflow is skipped, and the notice names exactly what to re-enable
- Scope creep into CI templates / upgrade suggestions (non-goals section)
