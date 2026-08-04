---
status: shipped
target: M4
date: 2026-08-04
---

# M4: sync (template re-sync — one-click apply)

## Background

M1 ships the audit, M2 the transform, M3 the check. The fourth command closes the loop (docs/02 §8, local-only): installed templates go stale — pre-commit rev pins, actions versions, gate configs — and nothing re-syncs them. sync = template versioning: compare installed vs current templates, one-click apply the new ones (the productization of the pre-commit rev-pin staleness problem). Naming: originally "upgrade" in the archive; renamed to `sync` by decision #12 after a naming-ambiguity review — `upgrade` collides with "AI-ification of the repo" (that's transform) and "upgrading the tool itself" (that's replacing the skill package, distribution per docs/07). The ecosystem precedent is exact: uv uses `sync` for reconciling installed state to declared state and `self update` for the tool; pre-commit named the same rev-sync feature `autoupdate` rather than a generic verb.

Design basis: docs/02 §8 (versioned template updates, one-click apply after check detects drift), docs/03 P7 + decision #7 (`.ai-native.yml` records what/version/date — the drift/sync foundation; M2 recorded files and dates but not versions — this spec completes it), decision #5 (100% deterministic, zero AI dependency), decision #10 (every step verified, rollback-able). M2 already seeded the machinery: the manifest lists installed files per stage; transform.ts byte-compares installed vs template (keep/conflict). **This spec pins the manifest `templateVersion` extension and the sync report schema — the slices must implement exactly this, no drift.**

## Goal (one sentence)

For any repository with a `.ai-native.yml` manifest, compare installed template files against the current skill templates, report per-file status deterministically, and apply the current templates with one command — zero build, never overwriting user-modified files.

## Scope

- `sync.ts` CLI: `--root <path>` / `--dry-run` / `--format json|markdown`; zero-dependency, Node >= 22.18. Default = **apply** (consistent with transform; `--dry-run` = plan only, writes nothing)
- **Version-aware detection** (reuses transform.ts template maps + manifest model, exported for reuse): per-file status `up-to-date | outdated | modified | missing | generated`, decided by byte comparison plus version comparison (per-stage `templateVersion`, fallback: manifest top-level `version`)
- **Manifest extension (schema v1, additive)**: optional per-stage `templateVersion` (= TOOL_VERSION at install), written by `transform.ts` going forward; `readManifest` accepts absence with fallback — old manifests keep working, no migration
- **Apply engine**: replaces `outdated` with current template bytes, restores `missing` from template, **never touches `modified`**; updates the manifest (templateVersion + date); reports post-apply manifest consistency (reuses `checkConsistency`); git rollback note
- **check.ts integration**: when outdated templates exist, the check report gains a deterministic "run sync" suggestion (docs/02 §3's "update template" action, productized)
- SKILL.md: full sync instructions + examples (slice 3)

## Non-goals

- CI drift gate (HANDOFF candidate #1 — separate feature)
- Standards/conventions versioning beyond templates (docs/02 §8's "规范" part) — v2
- Regenerating AGENTS.md / CLAUDE.md (stage 3: generated, user-owned — re-run `transform --stage 3` instead; sync reports them as `generated`, never writes)
- **Upgrading the tool itself** (getting a newer spooner skill package = distribution: git tag + release notes + `npx skills add`, docs/07 — not a workflow command; sync reconciles the *installed artifacts* after the tool advanced)
- Python / multi-stack templates — v2
- LLM semantic layer (gates stay deterministic, decision #5)
- Multi-repo batch sync — vision stage
- Automatic/scheduled sync (sync is an explicit, operator-confirmed action)

## Manifest extension (pinned schema v1, additive)

```yaml
schemaVersion: 1
tool: spooner
version: "0.1.0"
stages:
  2:
    date: "2026-08-04"
    templateVersion: "0.1.0"   # NEW (optional): tool version at install; absent on pre-M4 manifests
    warnOnly: true
    files:
      - ".commitlintrc.json"
```

`writeManifest` records `templateVersion` = TOOL_VERSION on every stage write; `readManifest` accepts absence and falls back to the manifest top-level `version` (pre-M4 manifests always carry it). **Publish contract**: template content changes are shipped with a TOOL_VERSION bump (docs/08 ledger discipline) — same-version byte diffs mean user edits, older-version diffs mean a stale template.

## Sync report (pinned schema v1)

```json
{
  "schemaVersion": 1,
  "root": ".",
  "dryRun": true,
  "version": { "installed": "0.2.1", "current": "0.2.1" },
  "files": [
    { "file": ".pre-commit-config.yaml", "stage": 2, "status": "outdated", "from": "0.0.9", "to": "0.1.0" }
  ],
  "applied": true,
  "consistency": { "checked": true, "consistent": true, "missing": [] },
  "message": "replaced 1 outdated template(s)"
}
```

`status` ∈ `up-to-date | outdated | modified | missing | generated`. Classification: bytes equal → `up-to-date`; bytes differ + recorded version == current → `modified` (user edits — never overwritten); bytes differ + recorded version < current → `outdated`; recorded but absent on disk → `missing`; stage-3 files (AGENTS.md/CLAUDE.md) → `generated`. Deterministic: same repo + same manifest + `--dry-run` → identical output, nothing written.

**Version-record reconciliation**: a stage whose files are all byte-current but recorded at an older version gets restamped (the ledger must not under-report) — gated to divergent records so in-sync repos still write nothing; generated-only stages (stage 3) keep their record (their currency cannot be byte-verified).

## Acceptance criteria (all must pass for shipped)

1. **No manifest**: repo without `.ai-native.yml` → report says "run transform stage 2 first", exit 0, nothing written
2. **Up-to-date**: all installed files byte-equal to current templates → all `up-to-date`, apply writes nothing (git status unchanged), output deterministic (run twice, diff)
3. **Outdated detection**: fixture with an older recorded version + differing bytes → `outdated` with the version pair (`from`/`to`) in the report
4. **Modified protection**: same-version recorded + differing bytes → `modified`, apply leaves the file byte-identical (never overwritten)
5. **Missing restore**: manifest-recorded file deleted → `missing`, apply restores it from the template
6. **Dry-run purity**: `--dry-run` writes nothing (git status unchanged); two identical dry-runs produce identical output
7. **Apply semantics**: apply replaces `outdated` files with the current template bytes, restores `missing`, updates the manifest (templateVersion + date), and the post-apply `checkConsistency` passes
8. **Stage 3 untouched**: AGENTS.md/CLAUDE.md entries report `generated` and are never written by apply
9. **Backward compat**: a pre-M4 manifest (no per-stage `templateVersion`) reads without error and classifies via the top-level version fallback
10. **Check integration**: with outdated templates present, the check report includes a "run sync" suggestion
11. **Zero build**: Node >= 22.18 runs sync.ts directly; zero third-party dependencies
12. **Manifest contract**: `templateVersion` round-trips through write/read, schemaVersion stays 1, old manifests still parse

## Slice plan

| Slice | Content | Status |
|---|---|---|
| 1 | Manifest extension (transform.ts: write/read `templateVersion`, export TOOL_VERSION + template maps) + `sync.ts` scaffold: CLI, template registry, detection engine, report schema + markdown render | [x] |
| 2 | Apply engine (replace outdated / restore missing / never touch modified, manifest update, post-apply consistency, rollback note) + check.ts integration | [x] |
| 3 | SKILL.md sync instructions + examples + AGENTS.md/README sync + docs/08 ledger note + acceptance + ship | [x] |

## Risks

- User edits on an old-version install, then a template upgrade → apply replaces and loses those edits (mitigation: `--dry-run` preview, the report lists every replaced file, git rollback note; documented contract — sync aligns to the current template)
- Template change shipped without a TOOL_VERSION bump → same-version diff misclassified as `modified` and never applied (mitigation: publish contract + docs/08 ledger discipline)
- Pre-M4 manifest fallback ambiguity (mitigation: the top-level version fallback is deterministic and conservative — same-version diffs are never overwritten)
- Scope creep into CI drift gate / standards versioning (non-goals section)
- sync becomes a second transform (mitigation: the differentiator is version-aware diffing + one-command re-sync, not re-installation)
