# Spooner

<p style="text-align:center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

> **Make this git repository ready for AI** — so AI coding agents can work in it from the first run. Audit its AI coding readiness, score it out of 10, then transform it in place: CI gates, AGENTS.md, a spec-driven workflow. Every step verifiable, never breaking the existing build.

<p style="text-align:center">
  <img src="https://img.shields.io/badge/agents-10%2B-8A2BE2.svg?style=flat-square" alt="Compatible with 10+ coding agents"/>
  <img src="https://img.shields.io/badge/Agent%20Skills-%E2%9C%93-green.svg?style=flat-square" alt="Agent Skills standard"/>
  <img src="https://img.shields.io/badge/CI-passing-brightgreen.svg?style=flat-square" alt="CI passing"/>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"/></a>
  <a href="assets/audit-report.md"><img src="assets/badge.svg" alt="AI readiness: AI-Native · 9.2/10"/></a>
</p>

An AI-native repository generally comes with complete quality gates and AI guidance: **pre-commit hooks**, **lint / formatter checks that actually run**, **CI that agrees with the local gates**, an **AGENTS.md** that tells the agent how things run, and a **spec-driven contract** (SDD templates) — to name a few. New quality gates, as they emerge, join the readiness score.

**Spooner is an [Agent Skills](https://agentskills.io/specification) (SKILL.md) built for coding agents. Named after Detective Del Spooner in _I, Robot_ (2004), whose left arm is robotic and serves him well — Spooner evaluates which of the above your repository is missing (AI readiness /10), adds them incrementally, and keeps them from drifting.**

## What one run does

<p style="text-align:center">
  <a href="assets/audit-report.md"><img src="assets/before-after.svg" alt="AI readiness: 4.3/10 AI-Aware → 9.2/10 AI-Native after one transform"/></a>
</p>

The "before" is a zero-state copy of this repository — the same code, minus everything spooner installs (no AGENTS.md, no pre-commit/commitlint gates, no drift gate, no SDD workflow). One run of the pipeline takes it from **4.3/10 (AI-Aware) to 9.2/10 (AI-Native)** — a score with evidence, not an opinion ([full report](assets/audit-report.md)).

The score is on a 10-point scale, grouped into five tiers:

| Tier        | Score | What it means                                                                                   |
| ----------- | ----- | ----------------------------------------------------------------------------------------------- |
| AI-Native   | 9–10  | Ready from the first run — AGENTS.md, real gates, CI that agrees with the local hooks, no drift |
| AI-Friendly | 7–8.9 | Most facilities in place, one or two gaps left (dead hooks, CI that disagrees, no AGENTS.md)    |
| AI-Curious  | 5–6.9 | Some AI-oriented setup exists, but incomplete                                                   |
| AI-Aware    | 3–4.9 | Readable by an AI agent, nothing prepared for it                                                |
| AI-Absent   | 0–2.9 | Hard for an AI to even understand — no README, no structure, no traceable commands              |

## The workflow

| Command     | What it does                                                                                                                  | When                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `audit`     | Detect and score AI coding readiness (repeatable — a health check)                                                            | Any repo, anytime                         |
| `transform` | Incremental, verifiable, rollback-able transformations (stack-aware CI gates incl. the manifest drift gate / AGENTS.md / SDD) | Once — the surgery                        |
| `check`     | Continuously detect drift (repeatable, with records)                                                                          | Every CI run                              |
| `sync`      | Re-sync installed templates to the current tool version (version-aware, one-click)                                            | When the tool advances                    |
| `badge`     | Render a readiness badge matched to your README's badge style (5 shields styles, links to the audit report)                   | After transform, whenever the score moves |

## Stack support

| Stack                       | detect + audit               | transform (gates + CI + AGENTS.md)       |
| --------------------------- | ---------------------------- | ---------------------------------------- |
| node (incl. React/Vue/Next) | ✅                           | ✅ `npm` lifecycle                       |
| python                      | ✅                           | ✅ `python3 -m unittest discover`        |
| go                          | ✅                           | ✅ `go build/test ./...`                 |
| java (Maven + Gradle)       | ✅                           | ✅ `mvn -q -B test` / `gradle build`     |
| rust                        | ✅                           | ✅ `cargo build/test` (fmt/clippy gates) |
| ruby / php / swift / dotnet | ✅ (audit under-scores only) | ⚠️ cross-stack gates + explicit notice   |

## Compatibility

All 10+ mainstream coding agents natively support the SKILL.md standard; AGENTS.md is nearly universal:

| Agent        | AGENTS.md                       | Skills directory     |
| ------------ | ------------------------------- | -------------------- |
| Claude Code  | via CLAUDE.md (symlink)         | `.claude/skills/`    |
| OpenAI Codex | native                          | `.agents/skills/`    |
| OpenCode     | native                          | `.opencode/skills/`  |
| Qwen Code    | native                          | `.qwen/skills/`      |
| Kimi Code    | native                          | `.kimi-code/skills/` |
| CodeBuddy    | fallback (CODEBUDDY.md primary) | `.codebuddy/skills/` |
| Trae         | via toggle                      | `.trae/skills/`      |
| Qoder        | native                          | `.qoder/skills/`     |
| ZCode        | native                          | `.zcode/skills/`     |
| Cursor       | native                          | `.cursor/skills/`    |
| VS Code      | native                          | `.github/skills/`    |

Universal strategy: **AGENTS.md** at repo root holds persistent facts (≤200 lines), **SKILL.md** holds on-demand procedures, per-agent rules files handle single-tool constraints.

## Install

The skill is a single directory (`skills/spooner/`) — no build step, just Node.js >= 22.18 (scripts are TypeScript run natively via type stripping).

### One-line install (skills CLI)

```sh
npx skills add ZM-BAD/spooner
```

The [skills CLI](https://github.com/vercel-labs/skills) copies `skills/spooner/` into your agent's skills directory and detects your agent from the environment. Useful flags:

| Flag                     | Meaning                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `-g` / `--global`        | install to the user-level skills directory (available to all projects) |
| `-a` / `--agent <agent>` | target a specific agent (`claude-code`, `codex`, `opencode`, …)        |
| `-s` / `--skill <name>`  | install only the `spooner` skill                                       |

### Manual install (any agent)

Copy the `skills/spooner/` directory into your agent's skills directory (see the compatibility table above). User-level examples:

```sh
# Claude Code — all projects
mkdir -p ~/.claude/skills
cp -R skills/spooner ~/.claude/skills/

# OpenAI Codex — all projects
mkdir -p ~/.agents/skills
cp -R skills/spooner ~/.agents/skills/

# OpenCode — all projects
mkdir -p ~/.config/opencode/skills
cp -R skills/spooner ~/.config/opencode/skills/
```

To share the skill with a specific repo, copy it to the project-level path from the table above (e.g. `.claude/skills/spooner/`).

### Verify

List skills in an agent session (`/skills` in Claude Code and Codex), then run the audit on a repo:

```sh
node skills/spooner/scripts/audit.ts
```

## Project layout

```text
spooner/
├── AGENTS.md / CLAUDE.md   # agent contract (single source of truth; CLAUDE.md is a symlink)
├── README.md / README.zh-CN.md   # bilingual docs
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
npm run check       # typecheck + lint:md + tests
pre-commit install --hook-type commit-msg   # enforce Conventional Commits on every commit
pre-commit run --all-files
node skills/spooner/scripts/detect.ts   # slice 1: stack detection
```

**Constraints:** TypeScript 6 only (major locked — the toolchain still requires the 6.0 API until TS 7.1), erasable syntax only (no `enum`/`namespace`), zero-dependency scripts, Conventional Commits (commitlint enforced).

## Distribution

Distributed from this GitHub repository — `npx skills add ZM-BAD/spooner` installs the skill directly. The Claude Code plugin marketplace and community registries are planned next.

## Documentation

| Doc                                | Content                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `AGENTS.md`                        | Agent contract (single source of truth; CLAUDE.md is a symlink) |
| `specs/README.md`                  | SDD workflow: states, conventions, two-layer structure          |
| `specs/ROADMAP.md`                 | Planning index: current / next / vision / ideas                 |
| `specs/0001-m1-audit-core/spec.md` | M1 audit contract: scoring matrix, report schema, acceptance    |
| `skills/spooner/SKILL.md`          | The distributable skill entry                                   |

## Contributors

Thanks to the users whose trial feedback shaped this project — each release lists the people whose reports were fixed:

<a href="https://github.com/shellRaining"><img src="https://avatars.githubusercontent.com/shellRaining?v=4" title="shellRaining" width="50" height="50" alt="shellRaining"></a>

## License

[MIT](LICENSE)
