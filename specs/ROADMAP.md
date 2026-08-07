# specs/ROADMAP.md — planning index (four tiers)

> This file is the **planning layer**: registration and indexing only, never a substitute for a spec.
> The spec directory (`specs/<nnn>-<name>/`) only holds specs that can state **scope + acceptance criteria**; the authoritative stage is the frontmatter `status` (proposed → approved → in-progress → shipped).
> Update this file whenever a spec is created or changed (rules in specs/README.md).

## ✅ Shipped

> 编号 0007 空缺：M7（commitlint 真实门禁）并入 spec 0001/0002 就地修订，未建 spec 目录——历史编号缺口，说明见 docs/08（2026-08-06）。

| ID | Name | Status | Notes |
|---|---|---|---|
| 0001 | m1-audit-core | shipped | audit: stack detection (9 stacks) + 10-point quality scoring (17 checks, weighted categories + normalization layer; 9.5 = excellent benchmark, 10 almost unreachable) + maturity gating + JSON/markdown reports |
| 0002 | m2-transform | shipped | transform stages 2-4 (gates → AGENTS.md + CLAUDE.md symlink → SDD) + `.ai-native.yml` manifest; stack-aware lifecycle commands; git-hook install step |
| 0003 | m3-check | shipped | re-run audit + baseline delta + manifest drift + fixed suggestions; `.ai-native/baseline.json` ledger |
| 0004 | m4-sync | shipped | version-aware template re-sync + one-click apply; manifest `templateVersion` extension; check "run sync" suggestion |
| 0005 | m5-drift-gate | shipped | 5th hard-gate job in the installed CI workflow: manifest file drift + template staleness → CI red |
| 0006 | m6-multi-stack | shipped | stack-aware transform: node/python/go/java/rust workflows + lifecycle commands + unsupported notice + stage-3 commands + audit credit |
| 0008 | m8-situational-transform | shipped | context-aware transform: SKILL.md context probe (full / no-workflow / audit-only modes) + CI-platform routing in stage 2 (non-GitHub skips the workflow with an explicit notice) |
| 0009 | m9-badge | shipped | readiness badge: badge.ts zero-dep renderer, 5 shields styles, README style probe (majority decision + `--style` override), pinned tier/color mapping, assets artifacts |
| 0010 | m10-contextual-gates | shipped | stack-aware pre-commit generation (tooling-detected, check-only, rev-pinned) + hook-tool routing (pre-commit vs husky skip+notice, M8 treatment) |
| 0011 | m11-rust-deep | shipped | rust joins the deep tier: cargo lifecycle (build/test) + ci-workflow-rust.yml + AGENTS.md cargo commands + audit credit + M10 pre-commit gates (fmt/clippy/test) |
| 0012 | m12-manifest-gate-hook | shipped | self-contained manifest-consistency hook (baked EXPECTED) in the generated pre-commit cross-stack core — mirrors the CI hard gate locally, closes the M10 incident class for users, first manifest gate for no-workflow repos; tool-owned marker rule + gate-script parity test |
| 0013 | m13-report-truth-scoring | shipped | report truth + quality scoring: 10-point scale × 0.1 granularity (full marks 10, almost unreachable — 9.5 is the excellent benchmark, 8 = good), 17 checks grade deterministic quality signals (command traceability / CI job depth / hook install state / manifest consistency), fix-hints two-sourced (transform vs manual action), suggestion filtering, monorepo `subStacks` note, stage-2 hook prompt, stage-3 conflict note, build-verification honesty, badge re-map, schemaVersion 3 (weighted category normalization + activity checks removed, 2026-08-07; from the DAG-chat + headroom + kuan-chat + spooner dogfoods + owner decisions) |

## 🟢 Current (in-progress)

Nothing in progress — 0001-0006 + 0008-0013 shipped (audit/transform/check/sync complete + CI drift gate + multi-stack + gate-active commit discipline + situational transform + readiness badge + contextual gates + rust deep + local manifest gate + report truth & quality scoring); next: launch prep (docs/06), or vision/ideas.

## 🟡 Next

Nothing spec'd as next — launch prep (docs/06) remains the main line, not spec'd.

## 🔵 Vision — the end state (完全态)

The finished Spooner, defined by six stable dimensions. Work either advances a dimension or it is not the product; the loop dimension is already complete and closed.

| Dimension | End state | Position (2026-08-04) |
|---|---|---|
| Workflow loop | audit → transform → check → sync + CI drift gate, stable and closed — no new core mechanisms | ✅ complete (specs 0001-0006) |
| Stack coverage | Deep transform (gates + CI + AGENTS.md + gate-verified lifecycle) for mainstream stacks, demand-driven; other stacks stay detect+audit with explicit notices | node/python/go/java/rust deep (M6 + M11); ruby/php/swift/dotnet detect+audit only |
| Distribution | GitHub repo + git tag + release notes → `npx skills add` → Claude plugin marketplace → ClawHub (MIT-0 decision pending) | pre-launch (docs/07) |
| Distribution engine | before/after comparison image, SVG readiness badge, readiness leaderboard (only if differentiated — hsnice16/agent-friendly-code already occupies the per-model ranking niche), multi-agent comparison | badge shipped (0009); image pre-launch |
| Calibration & trust | scores calibrated against expert references (kardo-core r=0.828) and real multi-stack repos; every point carries evidence | 5 external repos at M1; multi-stack calibration pending |
| Scale | multi-repo batch checks + trend records (vision-stage shape) | not started |

**Boundaries (the end state excludes)**: CLI form (stays a skill, decision #1), LLM semantic gates (100% deterministic, decision #5), per-tool config detection (decision #4 red line), commercialization (decision #3), automatic/scheduled sync (operator-confirmed only).

## 💡 Ideas (immature, one line each)

- multi-agent audit comparison on the same repo (amplifies the "compatible with 10+ agents" differentiator)
- SDD template pack extension (spec / plan / tasks templates into templates/)
- interactive dry-run preview for transform's `.ai-native.yml`
