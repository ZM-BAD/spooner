# AGENTS.md — Spooner repository agent contract

> **Single source of truth**: this file. `CLAUDE.md` is a symlink to it (Claude Code reads it through the symlink; on Windows, where symlinks may be unavailable, create a `CLAUDE.md` containing `@AGENTS.md`).
> Read this file first, then `README.md` and `specs/` for the live work contract. The internal design archive (`docs/`, `HANDOFF.md`) is kept local-only and is not published.

## What this project is

Spooner audits a codebase's **AI coding readiness** (audit), transforms it in place with incremental, verifiable steps (transform: CI gates / AGENTS.md / SDD workflow), continuously detects drift (check), and re-syncs installed templates when the tool advances (sync). Product form = an Agent Skills (SKILL.md) package at `skills/spooner/` — not a CLI. Resume/star-driven; not commercialized.

## Current status (2026-08-04)

- Product design frozen (internal archive `docs/`, `HANDOFF.md` — local only)
- Engineering scaffold ready: TypeScript 6 zero-build, SDD workflow (`specs/`), pre-commit + markdownlint + commitlint, GitHub Actions
- M1-M6 shipped (2026-08-04): specs 0001-0006 acceptance verified — the audit → transform → check → sync loop is complete, the installed CI workflow hard-gates manifest consistency (drift → red), transform supports node/python/go/java (decision #13), and the installed commitlint gate is real (install step + CI commit-msg check + gate-active audit — spec 0001/0002 revisions); next candidates: launch prep (docs/06)

## Commands (all real and executable)

| Command | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (TS 6, zero build) |
| `npm run lint:md` | markdownlint-cli2 over all Markdown |
| `npm run check` | typecheck + lint:md |
| `npm run verify` | check + full pre-commit run (one-shot verification) |
| `pre-commit run --all-files` | run all pre-commit hooks |
| `node skills/spooner/scripts/detect.ts` | stack detection (M1; optional `--root <path>`) |
| `node skills/spooner/scripts/audit.ts` | AI-Readiness scoring (/20, M1; optional `--root <path>` / `--format markdown`) |
| `node skills/spooner/scripts/check.ts` | drift check (M3: baseline delta + manifest drift; optional `--root <path>` / `--format markdown`) |
| `node skills/spooner/scripts/transform.ts` | transform workflow (M2: stages 2-4 + manifest consistency; optional `--root <path>` / `--stage 2/3/4/all` / `--dry-run` / `--format markdown`) |
| `node skills/spooner/scripts/sync.ts` | template re-sync (M4: version-aware diff of installed vs current templates + one-click apply; optional `--root <path>` / `--dry-run` / `--format markdown`) |
| `.venv/bin/agentskills validate skills/spooner` | SKILL.md spec validation (`.venv` via `python3 -m venv .venv && .venv/bin/pip install skills-ref`; CI pins the same version) |

## Layout

```text
spooner/
├── AGENTS.md / CLAUDE.md   # this contract (symlink)
├── README.md / zh-CN.md    # bilingual project overview
├── docs/                   # local-only internal design archive (not published)
├── specs/                  # SDD work contracts (live docs: README + ROADMAP + templates/ + <nnn>-<name>/)
├── skills/spooner/         # the distributable unit: SKILL.md + scripts/ + templates/
│   ├── SKILL.md            # Agent Skills standard entry (name matches directory)
│   ├── scripts/            # zero-dependency scripts (TS run natively by Node)
│   └── templates/          # output templates (AGENTS.md, etc.)
└── .github/workflows/      # CI
```

## Development workflow (SDD)

1. Every feature starts as a spec: `specs/<nnn>-<name>/spec.md` (template `specs/templates/spec.md`), state `proposed → approved → in-progress → shipped`; **register/update it in `specs/ROADMAP.md`** (current / next / vision / ideas)
2. Implement only after approval (approved); ship in independently verifiable slices
3. Changing frozen design: review the internal decision log (`docs/05`, local-only) first, then update `HANDOFF.md` (local)

## Technical constraints

- **TypeScript 6 only** (`^6.0.0`, major locked; not 7 — typescript-eslint and friends still require the 6.0 API until TS 7.1)
- **Zero build**: Node >= 22.18 runs `.ts` natively via type stripping; **erasable syntax only** — no `enum`, `namespace`, constructor parameter properties, or `import =` (Node throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX)
- Skill scripts are **zero-dependency** (Node builtins + git only); relative imports must carry the `.ts` extension
- **Version ledger**: dependency upgrades go through the local ledger (`docs/08`, not published) — update it and mention the upgrade in the commit; no opportunistic upgrades
- Repo docs are English-first; the internal archive (`docs/`, `HANDOFF.md`) is Chinese and local-only

## Red lines (re-check while developing)

- Commands must be real and executable — derived from actual files, never invented (AGENTS.md command executability is the killer gate)
- Every step verified and rollback-able — never break an existing build
- Long docs stay within 100-200 lines (AGENTS.md class); SKILL.md body < 500 lines
- Skill safety floor: no `curl | bash`; scripts only do what they declare
- Commits follow Conventional Commits (commitlint enforced): feat/fix/docs/chore/test/refactor/perf

## Docs

| File | Content |
|---|---|
| `README.md` / `README.zh-CN.md` | Bilingual project overview: compatibility matrix, install, development |
| `specs/README.md` | SDD workflow: states, conventions, two-layer structure |
| `specs/ROADMAP.md` | Planning index: current / next / vision / ideas |
| `specs/0001-m1-audit-core/spec.md` | M1 audit contract: scoring matrix, report schema, acceptance |
| `specs/0004-m4-sync/spec.md` | M4 sync contract: templateVersion extension, sync report schema, acceptance |
| `specs/0005-m5-drift-gate/spec.md` | M5 drift gate contract: CI hard gate job, baked-version rule, acceptance |
| `specs/0006-m6-multi-stack/spec.md` | M6 multi-stack contract: stack model, per-stack workflows/lifecycle, unsupported notice, acceptance |
| `skills/spooner/SKILL.md` | The distributable skill entry |
