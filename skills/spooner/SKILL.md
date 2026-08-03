---
name: spooner
description: Audit a codebase's AI coding readiness, score it, and run incremental, verifiable transformations (CI gates, AGENTS.md, spec-driven workflow). Use when the user asks to audit or improve a repository's readiness for AI coding agents, or to run the audit / transform / check workflow.
license: MIT
compatibility: Node.js >= 22.18 + git (scripts are TypeScript run natively via type stripping — no build step, zero third-party dependencies)
---

# Spooner

> Audit a codebase's **AI coding readiness**, score it, then transform it in place — install CI gates, generate an AGENTS.md, adopt a spec-driven workflow. Every step verifiable, never breaking the existing build.
>
> **Status: M1 (audit) in development.** Full instructions land during M1; currently available: `scripts/detect.ts` (stack detection) and `scripts/audit.ts` (AI-Readiness scoring, /20).

## Workflow

1. **audit** — detect and score readiness (repeatable, a health check)
2. **transform** — incremental, verifiable, rollback-able transformations (CI gates / AGENTS.md / SDD)
3. **check** — continuously detect drift (repeatable, with records)

## Scripts

| Script | Purpose |
|---|---|
| `scripts/detect.ts` | Stack detection: structured JSON (stacks + manifest details) |
| `scripts/audit.ts` | AI-Readiness scoring per the v1 matrix (/20): score + gaps + maturity |

Usage:

```sh
node scripts/detect.ts --root /path/to/repo
node scripts/audit.ts --root /path/to/repo --format markdown
```

## Red lines

- Commands are derived from real files, never invented
- Every step is verified and rollback-able — never break an existing build
