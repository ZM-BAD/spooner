# AGENTS.md — Spooner repository agent contract

> **Single source of truth**: this file. `CLAUDE.md` is a symlink to it (Claude Code reads it through the symlink; on Windows, where symlinks may be unavailable, create a `CLAUDE.md` containing `@AGENTS.md`).
> Read this file first, then `README.md` and `specs/` for the live work contract. The internal design archive (`docs/`, `HANDOFF.md`) is kept local-only and is not published.

## What this project is

Spooner audits a codebase's **AI coding readiness** (audit), transforms it in place with incremental, verifiable steps (transform: CI gates / AGENTS.md / SDD workflow), and continuously detects drift (check). Product form = an Agent Skills (SKILL.md) package at `skills/spooner/` — not a CLI. Resume/star-driven; not commercialized.

## Current status (2026-08-03)

- Product design frozen (internal archive `docs/`, `HANDOFF.md` — local only)
- Engineering scaffold ready: TypeScript 6 zero-build, SDD workflow (`specs/`), pre-commit + markdownlint + commitlint, GitHub Actions
- In development: M1 (audit) — spec `specs/0001-m1-audit-core/`; slices 1-3 done (stack detection + scoring/reporting), slice 4 (full SKILL.md instructions) pending

## Commands (all real and executable)

| Command | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (TS 6, zero build) |
| `npm run lint:md` | markdownlint-cli2 over all Markdown |
| `npm run check` | typecheck + lint:md |
| `npm run verify` | check + full pre-commit run (one-shot verification) |
| `pre-commit run --all-files` | run all pre-commit hooks |
| `node skills/spooner/scripts/detect.ts` | stack detection (M1 slice 1; optional `--root <path>`) |
| `node skills/spooner/scripts/audit.ts` | AI-Readiness scoring (/20, slices 2-3; optional `--root <path>` / `--format markdown`) |
| `agentskills validate skills/spooner` | SKILL.md spec validation (requires `pip install skills-ref`) |

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
| `skills/spooner/SKILL.md` | The distributable skill entry |
