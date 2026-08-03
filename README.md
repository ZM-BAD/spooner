# Spooner

> Audit a codebase's **AI coding readiness**, score it, then transform it in place — install CI gates, generate an AGENTS.md, adopt a spec-driven workflow. Every step verifiable, never breaking the existing build.

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-6.0-3178C6.svg?style=flat-square" alt="TypeScript 6.0"/>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.18-339933.svg?style=flat-square" alt="Node.js >= 22.18"/>
  <img src="https://img.shields.io/badge/build-zero%20build-brightgreen.svg?style=flat-square" alt="Zero build"/>
  <img src="https://img.shields.io/badge/agents-10%2B-8A2BE2.svg?style=flat-square" alt="Compatible with 10+ coding agents"/>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/workflow-Spec--Driven-blue.svg?style=flat-square" alt="Spec-driven workflow"/>
  <img src="https://img.shields.io/badge/Agent%20Skills-%E2%9C%93-green.svg?style=flat-square" alt="Agent Skills standard"/>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"/></a>
  <img src="https://img.shields.io/badge/CI-passing-brightgreen.svg?style=flat-square" alt="CI passing"/>
</p>

Spooner is an [Agent Skills](https://agentskills.io/specification) (SKILL.md) built for coding agents. Named after the detective who keeps robots in line in *I, Robot* (2004) — Spooner keeps AI coding in line.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

**Status (2026-08-03):** product design frozen; engineering scaffold ready (TypeScript 6, zero-build, SDD workflow, full lint + CI); **M1 (audit) in development**.

## The workflow

| Command | What it does | When |
|---|---|---|
| `audit` | Detect and score AI coding readiness (repeatable — a health check) | Any repo, anytime |
| `transform` | Incremental, verifiable, rollback-able transformations (CI gates / AGENTS.md / SDD) | Once — the surgery |
| `check` | Continuously detect drift (repeatable, with records) | Every CI run |

## Compatibility

All 10+ mainstream coding agents natively support the SKILL.md standard; AGENTS.md is nearly universal:

| Agent | AGENTS.md | Skills directory |
|---|---|---|
| Claude Code | via CLAUDE.md (symlink) | `.claude/skills/` |
| OpenAI Codex | native | `.agents/skills/` |
| OpenCode | native | `.opencode/skills/` |
| Qwen Code | via config | `.qwen/skills/` |
| Kimi Code | native | `.kimi-code/skills/` |
| CodeBuddy | fallback (CODEBUDDY.md primary) | `.codebuddy/skills/` |
| Trae | via toggle | `.trae/skills/` |
| Qoder | native | SKILL.md native |
| Cursor | native | `.cursor/skills/` |
| VS Code | native | `.github/skills/` |

Universal strategy: **AGENTS.md** at repo root holds persistent facts (≤200 lines), **SKILL.md** holds on-demand procedures, per-agent rules files handle single-tool constraints.

## Install

Copy `skills/spooner/` into your agent's skills directory (see the table above), or use the skills CLI:

```sh
npx skills add <owner>/spooner
```

Requires Node.js >= 22.18: scripts are TypeScript run natively via type stripping — **no build step**.

## Project layout

```text
spooner/
├── AGENTS.md / CLAUDE.md   # agent contract (single source of truth; CLAUDE.md is a symlink)
├── README.md / zh-CN.md    # bilingual docs
├── docs/                   # local-only internal design archive (not published)
├── specs/                  # SDD work contracts (live docs: README + templates/ + <nnn>-<name>/)
├── skills/spooner/         # the distributable unit: SKILL.md + scripts/ + templates/
│   ├── SKILL.md            # Agent Skills standard entry (name matches directory)
│   ├── scripts/            # zero-dependency scripts (TS run natively by Node)
│   └── templates/          # output templates (AGENTS.md, etc.)
└── .github/workflows/      # CI: pre-commit, typecheck, commitlint, SKILL.md validation
```

## Development

**Spec-driven (SDD):** every feature starts as a spec in `specs/<nnn>-<name>/spec.md` (`proposed → approved → in-progress → shipped`), implemented in independently verifiable slices. Template: `specs/templates/spec.md`.

```sh
npm run typecheck   # tsc --noEmit (TypeScript 6, zero build)
npm run lint:md     # markdownlint-cli2
npm run check       # typecheck + lint:md
pre-commit run --all-files
node skills/spooner/scripts/detect.ts   # slice 1: stack detection
```

**Constraints:** TypeScript 6 only (major locked — the toolchain still requires the 6.0 API until TS 7.1), erasable syntax only (no `enum`/`namespace`), zero-dependency scripts, Conventional Commits (commitlint enforced).

## Distribution (planned)

Plan: GitHub distribution as the default channel (git tags + the skills CLI), then the Claude Code plugin marketplace and community registries at the launch milestone. Packaging research is kept in the internal archive (local-only).

## Documentation

| Doc | Content |
|---|---|
| `AGENTS.md` | Agent contract (single source of truth; CLAUDE.md is a symlink) |
| `specs/README.md` | SDD workflow: states, conventions, two-layer structure |
| `specs/ROADMAP.md` | Planning index: current / next / vision / ideas |
| `specs/0001-m1-audit-core/spec.md` | M1 audit contract: scoring matrix, report schema, acceptance |
| `skills/spooner/SKILL.md` | The distributable skill entry |

## License

[MIT](LICENSE)
