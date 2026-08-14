---
status: shipped # proposed → approved → in-progress → shipped
target: M16
date: 2026-08-10
---

# M16: multi-agent contract files — the agent-setup checks serve the whole ecosystem

## Background

The agent-setup checks (`agents-md` / `agents-bridge` / `agents-length`, plus the maturity gate) must not recognize only two contract files — `AGENTS.md` and `CLAUDE.md` — with a fixed priority (AGENTS.md first) and a one-directional bridge rule (CLAUDE.md must reference AGENTS.md). The agent ecosystem is wider and a fixed priority penalizes real repos:

- **Qwen-only repos** (Alibaba-internal style — Qwen Code + Qwen LLM only) carry `QWEN.md` as their contract; the old rule scored them 0 on `agents-bridge` ("CLAUDE.md: missing") despite a complete, dedicated contract.
- **Claude Code does NOT read AGENTS.md natively** — its contract file is CLAUDE.md; **Gemini CLI needs explicit config to read AGENTS.md** (its primary is GEMINI.md); Copilot reads `.github/copilot-instructions.md`; Cursor/Windsurf legacy single-file rules are `.cursorrules` / `.windsurfrules`; Aider defaults to `CONVENTIONS.md`; Cline reads `.clinerules`. `AGENT.md` is the open standard's backward-compat variant (agents.md — read natively by Codex/Jules/Cursor/Copilot/Devin/Kilo/Augment/Windsurf/Cline/Qwen).
- **Direction is not sacred**: repos may link AGENTS.md → CLAUDE.md (the reverse of spooner's convention); any-direction unification is what matters.
- The old bridge check compared symlink targets by exact name string — `CLAUDE.md → ./AGENTS.md` (or `../AGENTS.md`) scored as "no bridge".

## Goal (one sentence)

The agent-setup checks recognize the ecosystem's contract files, pick the repo's primary contract by content (most traceable commands, then longest), and score bridging as any-direction unification — so a repo with a complete contract for its actual agents never under-scores.

## Scope

1. **`AGENT_FILES` enumeration** (audit.ts, official-doc verified): `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `QWEN.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.windsurfrules`, `CONVENTIONS.md`, `.clinerules`. Directory rule sets (`.cursor/rules/`, `.windsurf/rules/`, `.amazonq/rules/`…) are scoped rules, not the agent contract — out of scope (roadmap candidate).
2. **`primaryAgentFile`**: the most content-rich present file — most traceable commands (the `traceableCommandsOf` count), then longest; ties break by enumeration order (deterministic). No fixed file priority: a Qwen-only repo's primary is QWEN.md; an AGENTS.md + thin QWEN.md repo keeps AGENTS.md (the open standard). All consumers that previously used the old single-file lookup (`agents-md`, `agents-length`, `agents-sdd`, the maturity gate) now read the primary.
3. **`agents-bridge` semantics** (three states):
   - no agent file → 0 ("agent file: missing")
   - exactly one agent file → 0.5 (a single contract is complete by itself — no bridge needed)
   - multiple files → unification in ANY direction, matched by **realpath** (not the literal readlink string): symlink pair → 0.5; `@import` pair (line-start `@<file>`) → 0.5; content reference (case-insensitive name mention) → 0.3; coexisting without any bridge → 0 ("agents read different contracts")
4. **Behavior change note**: this is a user-visible score change (AGENTS.md-only repos move from 0 to 0.5 on `agents-bridge`; CLAUDE.md-only repos score full instead of 0) — a correctness fix, not an inflation: the check measures "do the repo's agents read one contract?", not "does the repo follow spooner's convention".

## Non-goals

- **No transform change**: stage 3 still generates AGENTS.md + the CLAUDE.md bridge for the tool's own convention; the audit stops _demanding_ it.
- **No directory rule sets** (`.cursor/rules/` etc.) — scoped rules are a different artifact; roadmap candidate.
- **No content sniffing** of contract files beyond the existing traceable-command regexes.
- **No version chain**: audit-only change, no template bytes, no TOOL_VERSION bump.

## Acceptance criteria (verifiable)

1. Every `AGENT_FILES` entry is official-doc sourced (comment in code)
2. A Qwen-only repo (QWEN.md with traceable commands) scores `agents-md` 0.5 naming QWEN.md and `agents-bridge` 0.5 ("single agent file")
3. AGENTS.md-only and CLAUDE.md-only repos score `agents-bridge` 0.5
4. Relative symlink (`CLAUDE.md → ./AGENTS.md`) and reverse symlink (AGENTS.md → CLAUDE.md) both score 0.5 by realpath
5. `@AGENTS.md` import between any two files scores 0.5; content-only reference scores 0.3; coexisting files without a bridge score 0
6. `primaryAgentFile` is deterministic (most traceable, then longest) — thin AGENTS.md + rich QWEN.md resolves QWEN.md; regression tests pin it
7. `agents-length` / `agents-sdd` / maturity gate read the primary file (GEMINI.md 42-line fixture scores agents-length 0.5)
8. Regression: typecheck + markdownlint + full suite green; determinism double-run diff empty
9. Docs current-state: specs 0001 + 0013 check definitions in place (no acceptance logs)

## Slice plan (each slice independently verifiable)

| Slice | Content                                                                                      |
| ----- | -------------------------------------------------------------------------------------------- |
| 1     | AGENT_FILES enumeration + agentFiles/primaryAgentFile + consumers migrated                   |
| 2     | agents-bridge three states (single-file full, any-direction realpath unification, 0)         |
| 3     | Regression tests (Qwen-only / GEMINI.md / relative + reverse symlinks / @import / no bridge) |
| 4     | Contract docs (specs 0001 + 0013 in-place revisions)                                         |

## Risks

- **Bridge score inflation**: multi-file repos without any bridge still score 0 — the "coexist without any bridge" fixture pins it; a repo with AGENTS.md + CLAUDE.md (two full copies) still under-scores honestly until unified
- **Primary-file ambiguity**: a repo with two rich contracts picks one by deterministic tie-break — evidence names the winner, so the score is auditable
- **`AGENT.md` false positives**: `AGENT.md` is a common name for other artifacts — exact-match only, no content sniffing (the enumeration is the boundary)
