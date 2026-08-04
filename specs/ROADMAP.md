# specs/ROADMAP.md — planning index (four tiers)

> This file is the **planning layer**: registration and indexing only, never a substitute for a spec.
> The spec directory (`specs/<nnn>-<name>/`) only holds specs that can state **scope + acceptance criteria**; the authoritative stage is the frontmatter `status` (proposed → approved → in-progress → shipped).
> Update this file whenever a spec is created or changed (rules in specs/README.md).

## ✅ Shipped

| ID | Name | Status | Notes |
|---|---|---|---|
| 0001 | m1-audit-core | shipped | Acceptance passed 2026-08-04 (criteria 1-6; hasCi false positive fixed during the run) — audit: stack detection + scoring/reporting + full SKILL.md instructions |
| 0002 | m2-transform | shipped | Acceptance passed 2026-08-04 (criteria 1-9, 14 assertions; two dogfood defects fixed) — stages 2-4 (gates → AGENTS.md + symlink → SDD) + `.ai-native.yml` manifest |
| 0003 | m3-check | shipped | Acceptance passed 2026-08-04 (criteria 1-8, 11 assertions) — re-run audit + baseline delta + manifest drift + fixed suggestions; `.ai-native/baseline.json` ledger |
| 0004 | m4-sync | shipped | Acceptance passed 2026-08-04 (criteria 1-12, 31 assertions) — version-aware template re-sync + one-click apply; manifest `templateVersion` extension; check "run sync" suggestion |
| 0005 | m5-drift-gate | shipped | Acceptance passed 2026-08-04 (criteria 1-11, 21 assertions; manifest-restore defect fixed during the run) — 5th hard-gate job in the installed CI workflow: manifest file drift + template staleness → CI red; TOOL_VERSION 0.1.1 |

## 🟢 Current (in-progress)

Nothing in progress — 0001-0005 shipped (audit/transform/check/sync complete + CI drift gate); next: launch prep (docs/06), or vision/ideas.

## 🟡 Next

Nothing spec'd as next — candidates: launch prep (docs/06), SVG readiness badge.

## 🔵 Vision (not yet spec'd)

| Item | Notes |
|---|---|
| Multi-stack templates | v1 deeply supports Node/TS only; other stacks get generic templates + explicit "not supported yet" (v1 red line); extend Python/Go/Rust templates as demand shows up |
| Readiness leaderboard | hsnice16-style public leaderboard (rate 100 star repos per thread = distribution engine); evaluate after launch feedback |
| Multi-repo batch checks | audit/check are single-repo local today; batch checks and trend records are a vision-stage shape, depending on 0001/0002 landing |

## 💡 Ideas (immature, one line each)

- audit result badge (SVG badge for README headers)
- multi-agent audit comparison on the same repo (amplifies the "compatible with 10+ agents" differentiator)
- SDD template pack extension (spec / plan / tasks templates into templates/)
- interactive dry-run preview for transform's `.ai-native.yml`
