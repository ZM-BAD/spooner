---
status: shipped
target: M9
date: 2026-08-05
---

# M9: readiness badge (5 shields styles + README style probe)

## Background

The distribution engine is the open gap before launch: the before/after image is launch material, the SVG readiness badge is the recurring-impression asset ("a badge pasted once renders on every page load" — README badges are self-distributing brand impressions). The niche is currently empty in the readiness category: two near entries exist (brewmarsh/agent-readiness-scorecard `--badge`, @paladini/harness-score `renderBadge`) but both are CLI/library-form, offline single-SVG generators — neither is wired into an audit → transform → check loop, and neither probes the host README's existing badge style.

Design principles this spec pins:

- **Zero dependency, zero build, deterministic**: the badge is rendered locally as SVG (Node builtins + string templates) from the audit result — no shields.io endpoint, no hosted service, no data exfiltration (company-repo privacy, decision-consistent with M8). "shields-style" geometry (20px height, 11px Verdana, rounded pill) — parity with shields.io rendering is _not_ a goal (the Rust `shields` crate achieves bitwise parity; we don't need to claim it).
- **Fit the host README, don't impose**: the ecosystem convention is "one style per row" (mixed heights look broken — `for-the-badge` ~28px vs `flat` ~20px). The badge must slot into the repo's existing badge row, so the generator probes the root README and matches the dominant existing style; the human always wins via `--style`.
- **Consistency > freshness**: a dated existing style (e.g. `plastic`) is matched anyway — the badge is the owner's reputational asset and the owner's visual choice; the tool follows, it never judges aesthetics.
- **Scripts don't mutate the repo**: badge.ts renders and reports; README insertion is an agent step with user confirmation (transform territory, M8 permission philosophy).

## Goal (one sentence)

Given a repository, render a deterministic shields-style readiness badge (5 styles, fixed metric label + score, evidence link) whose style matches the root README's dominant existing badge style by default — and can be overridden with `--style`.

## Scope

- **`skills/spooner/scripts/badge.ts`** (zero-dependency, runs natively on Node >= 22.18):
  - Reuses the audit module (same shared code path as check.ts) to re-run scoring deterministically at generation time — the badge never shows a stale score.
  - Renders `badge.svg` into `assets/` (the repo-root README asset convention — `.ai-native/` is gitignored as a local ledger, so badge artifacts must be committable for the README to render remotely).
  - Writes the audit markdown report as `assets/audit-report.md` — the badge links to it (every point carries evidence, calibration-and-trust dimension).
  - Prints the README insertion snippet + a probe evidence report.
- **Five styles** (shields.io official set, `--style <name>`): `flat` (default) / `flat-square` / `plastic` / `for-the-badge` / `social` (supported for shields parity; documented as not recommended for a score — its semantics are GitHub count buttons).
- **README style probe** (deterministic, read-only):
  - Parse the root README only (M8 root-stack boundary): markdown images `![alt](url)` and HTML `<img src="...">`.
  - Known style signal = a shields.io URL with `?style=<name>`; everything else (badgen, custom SVG, GitHub-native workflow badges) = unknown.
  - Decision chain: any known styles present → majority wins; tie or no known styles → `flat`. Report the decision with evidence (e.g. "matched flat-square: 5 shields.io badges").
  - `--style` always overrides the probe.
- **Pinned label/color mapping** (label = the fixed metric `AI-Readiness`, message = `x/10`; 10-scale with 9.5 as the excellent benchmark — a 10 is almost unreachable; message-side colors follow the shields convention):

  | Score | Tier label  | Color              |
  | ----- | ----------- | ------------------ |
  | 9-10  | AI-Native   | `#4c1` (green)     |
  | 7-8.9 | AI-Friendly | `#4c1` (green)     |
  | 5-6.9 | AI-Curious  | `#dfb317` (yellow) |
  | 3-4.9 | AI-Aware    | `#e05d44` (red)    |
  | 0-2.9 | AI-Absent   | `#e05d44` (red)    |

  Color bands: >= 8 green, 5-7.9 yellow, < 5 red. Fixed hex colors only (renders correctly in both GitHub themes). The tiers are the score's **semantics** — they live in the report line (`Tier: …`) and the README five-tier table, where one sentence explains what a band means; the **badge itself shows the fixed label + score + color only** (badge revision: a morphing tier label made the badge's identity unstable and disagreed with the color bands — tier boundaries 9/7/5/3 vs color bands 8/5, so 7.2 rendered AI-Friendly/yellow while 8.5 rendered AI-Friendly/green. A fixed metric label is the shields convention and removes the contradiction; the color is purely the score's).

- **SKILL.md**: a badge step (after transform) — run badge.ts, review the snippet + probe report, insert into the README badge row with user confirmation.
- No TOOL_VERSION bump (no workflow-template bytes change — new script + SKILL.md instructions only, same precedent as spec 0008).

## Non-goals

- Hosted/endpoint badges (shields.io URL, shieldcn-style services) — data exfiltration + external dependency, violates zero-dependency/determinism
- Dynamic/auto-updating badges (a static SVG re-generated on demand; a check-side "badge is stale" hint is a future candidate, not part of M9)
- Script-side README mutation (insertion is an agent step with user confirmation)
- Probing beyond the root README (other docs, generated docs)
- Pixel-parity with shields.io rendering
- Readiness leaderboard (separate idea; hsnice16 occupies the per-model ranking niche)

## Acceptance criteria (all must pass for shipped)

1. **Default style**: fixture with a README containing no badges → `flat` badge rendered
2. **Style match**: fixture with >= 2 shields.io `flat-square` badges in the README → `flat-square` rendered
3. **Majority decision**: fixture with mixed known styles (e.g. 2 flat + 1 for-the-badge) → the majority style
4. **Tie fallback**: fixture with equal counts → `flat`
5. **No known style**: fixture with only non-shields badges → `flat`
6. **Override**: `--style for-the-badge` on any of the above → `for-the-badge`, probe evidence still reported
7. **Label/color mapping**: three fixtures scored 9, 6, 1.5 → every badge renders the fixed `AI-Readiness` label with `#4c1` / `#dfb317` / `#e05d44` message sides; the report line still names the tier (AI-Native / AI-Curious / AI-Absent) and no tier name ever appears inside the badge SVG or snippet
8. **SVG validity**: output parses as XML; width adapts to text (no fixed width)
9. **Artifacts**: `assets/badge.svg` + `assets/audit-report.md` written; the printed snippet references both (badge → report link)
10. **Determinism**: two runs on the same fixture → byte-identical SVG + report
11. **SKILL.md**: the badge step (run → review → insert with confirmation) lands in the transform procedure
12. **Regression**: typecheck + markdownlint + full test suite green (existing 23 tests unaffected)

## Slice plan

| Slice | Content                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------- |
| 1     | badge.ts core renderer: 5 style templates + pinned tiers/colors + audit reuse + artifacts + snippet |
| 2     | README style probe + decision chain + `--style` override + evidence report                          |
| 3     | SKILL.md badge step + acceptance fixtures + ROADMAP/HANDOFF sync + ship                             |

## Risks

- Probe false positives (badge-like URLs in comments or code blocks) — mitigation: parse only image syntax, print the probe evidence so the agent can verify
- Matching a dated style (e.g. `plastic`) looks bad to newcomers — mitigation: this is the owner's choice (consistency > freshness); `--style` is the documented escape hatch
- Stale badge after the repo changes (score drifts post-generation) — mitigation: badge.ts re-runs the audit at generation time; a check-side staleness hint is tracked as a future candidate, not promised
- Geometry drifts from shields.io expectations — mitigation: follow the public shields conventions (height/font/pill); exact parity explicitly out of scope
- Scope creep into hosted endpoints / auto-insertion / leaderboard (non-goals section)
