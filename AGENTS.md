# AGENTS.md — Spooner repository agent contract

> **Single source of truth**: this file. `CLAUDE.md` is a symlink to it (Claude Code reads it through the symlink; on Windows, where symlinks may be unavailable, create a `CLAUDE.md` containing `@AGENTS.md`).
> Read this file first, then `README.md` and `specs/` for the live work contract. The internal design archive (`docs/`, `HANDOFF.md`) is kept local-only and is not published.

## What this project is

Spooner audits a codebase's **AI coding readiness** (audit), transforms it in place with incremental, verifiable steps (transform: CI gates / AGENTS.md / SDD workflow), continuously detects drift (check), and re-syncs installed templates when the tool advances (sync). Product form = an Agent Skills (SKILL.md) package at `skills/spooner/` — not a CLI. Resume/star-driven; not commercialized.

## Current status

- Product design frozen (internal archive `docs/`, `HANDOFF.md` — local only; milestone history lives there + docs/08 + git commits, never here)
- Engineering scaffold ready: TypeScript 6 zero-build, SDD workflow (`specs/`), pre-commit + markdownlint + commitlint, GitHub Actions
- All specs shipped (0001-0006, 0008-0013): the audit → transform → check → sync loop is complete — the installed CI workflow hard-gates manifest consistency (drift → red) and the generated pre-commit config hard-gates the ledger locally (self-contained manifest-consistency hook, baked EXPECTED); transform supports node / python / go / java (Maven + Gradle incl. kotlin/Android `build.gradle.kts`/`settings.gradle(.kts)`) / rust (stack-aware lifecycle + per-stack CI workflows + generated stack-aware pre-commit gates; husky/lefthook/yorkie hook ecosystems skip the config with a notice — a dead husky dependency without hooks config does NOT skip; non-GitHub CI platforms skip the workflow with a notice); the installed commitlint gate enforces (install step + CI commit-msg check + gate-active audit); the readiness badge matches the README's dominant badge style (5 shields styles); the audit scores 0-10 on deterministic quality signals with two-sourced fix hints and a monorepo sub-stack note — PHP signals score too (composer.lock / phpunit / php-cs-fixer) even though transform's supported stacks stop at rust; next candidates: launch prep (docs/06)

## Commands (all real and executable)

| Command | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (TS 6, zero build) |
| `npm run lint:md` | markdownlint-cli2 over all Markdown |
| `npm test` | node:test suite (`node --test "skills/spooner/test/*.test.ts"`) |
| `npm run check` | typecheck + lint:md + tests (one-shot) |
| `npm run verify` | check + full pre-commit run (one-shot verification) |
| `pre-commit run --all-files` | run all pre-commit hooks |
| `node skills/spooner/scripts/detect.ts` | stack detection (M1; optional `--root <path>`) |
| `node skills/spooner/scripts/audit.ts` | AI-Readiness scoring (/10, M1; optional `--root <path>` / `--format markdown` / `--verify` executes the traced lifecycle commands instead of marking them unverified) |
| `node skills/spooner/scripts/check.ts` | drift check (M3: baseline delta + manifest drift; optional `--root <path>` / `--format markdown`) |
| `node skills/spooner/scripts/transform.ts` | transform workflow (M2: stages 2-4 + manifest consistency; optional `--root <path>` / `--stage 2/3/4/all` / `--dry-run` / `--ci github\|gitlab\|none` / `--format markdown`) |
| `node skills/spooner/scripts/sync.ts` | template re-sync (M4: version-aware diff of installed vs current templates + one-click apply; optional `--root <path>` / `--dry-run` / `--format markdown`) |
| `node skills/spooner/scripts/badge.ts` | readiness badge (M9: 5 shields styles + README style probe + pinned tier/color mapping; optional `--root <path>` / `--style <name>` / `--format markdown`) |
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
│   ├── test/               # node:test regression suite (fixtures built in tmp dirs)
│   └── templates/          # output templates (AGENTS.md, etc.)
└── .github/workflows/      # CI
```

## Development workflow (SDD)

1. Every feature starts as a spec: `specs/<nnn>-<name>/spec.md` (template `specs/templates/spec.md`), state `proposed → approved → in-progress → shipped`; **register/update it in `specs/ROADMAP.md`** (current / next / vision / ideas)
2. Implement only after approval (approved); ship in independently verifiable slices
3. Changing frozen design: review the internal decision log (`docs/05`, local-only) first, then update `HANDOFF.md` (local)

## Development playbook

**The loop**: change code → `npm run check` (typecheck + lint:md + tests) → `pre-commit run --all-files` (12 hooks, incl. typecheck + tests — a green pre-commit implies a green CI) → push the branch (every branch push runs both workflows) → user approves merge/push to main.

**Do**

- **Contract docs are current-state only, never history**: specs (a fix updates the spec **in place** — no acceptance logs, no fix history, no version transitions) and the AGENTS.md/SKILL.md status sections (current capability set only — no milestone bullets, no dates, no "shipped" language). History lives in commit messages + `docs/08` + `HANDOFF.md` (local) — never in the contract docs
- **Every pitfall triggers a skill-incorporation review** (the dogfood → product loop): after recording a gotcha, ask "can the skill prevent this failure class for its users?" — mandatory discussion, optional implementation (scope creep stays a red line). Outcome: implement (new spec / in-place revision), reject with the reason, or park as a roadmap candidate
- **Template change ⇒ bump `TOOL_VERSION`** + baked `EXPECTED` in all five workflow templates + a `docs/08` ledger row (spec 0004/0005 contract) — then dogfood `sync`; **mirror content changes (not just EXPECTED/SKIP) to the installed dogfood workflow in the same commit** — `--stage 2` refuses via conflict (the M12 python3 switch missed the installed workflow; the review caught it)
- Test version assertions import `TOOL_VERSION` dynamically — never hard-code it (a bump will silently rot the tests)
- Before every squash: create a backup branch; after: verify tree identity (`git diff <backup> HEAD` must be empty) and verify every new commit independently (`pre-commit run --all-files` + commit-msg stage with `--commit-msg-filename`)
- Fixes get **woven into the introducing commit** (the history reads as "correct from day one") — e.g. commitlint-real-gate into M2, CI fixes into the parity commit
- `git add -A` then `git restore --staged .ai-native .zcode` (local-only dirs) before committing
- Commit messages: heredoc (`git commit -m "$(cat <<'EOF' …)"`), subject lowercase start (no "M8"-style capitals — subject-case rule), ≤100 chars, blank line before the footer

**Don't**

- Never write `npm run x 2>/dev/null || echo skip`-style declared-only hooks — a failing script must fail the hook, not masquerade as "not declared"
- Never skip `stages: [pre-commit]` on local hooks — pre-commit runs undeclared hooks in EVERY stage, and the commit-msg stage runs in CI without node_modules
- Don't leave test assertions hard-coding version numbers or fixture paths

**Verify**

- `npm run check` + `pre-commit run --all-files` (12 hooks) before any commit
- CI simulation: `SKIP=typecheck,test,manifest-consistency pre-commit run --all-files` → 9 Passed + 3 Skipped
- `pre-commit run --hook-stage commit-msg --commit-msg-filename .git/COMMIT_EDITMSG` → commitlint + hygiene only, no local hooks
- `agentskills validate skills/spooner`; audit determinism double-run (`diff` two runs)

## Gotchas

**Git & squash**

- **`git checkout <commit> -- .` does NOT delete files missing from that tree** — renamed/deleted files linger; after rebuilding a squashed history, force `git diff <backup> HEAD` to be empty and `git rm` leftovers (2026-08-04)
- **`git add -A` sweeps in untracked local dirs** (`.zcode/`, `.ai-native/`) when their `.gitignore` entries didn't exist yet — restore `--staged` them before committing
- **The dogfood manifest (`.ai-native.yml`) is tracked and must be committed with each milestone** — `git restore --staged .ai-native.yml` leaves CI's drift gate red: local pre-commit reads the working-tree manifest, CI reads the committed one (the M10 branch push caught this — local green, CI red "v0.2.7 < expected v0.3.0"). Only the `.ai-native/` dir (baseline.json) is local-only (2026-08-05). → **skill review**: users hit the same class — the generated pre-commit config lacks CI's version gate (local ⊇ CI breaks at the ledger); a self-contained manifest-gate hook (baked EXPECTED) in the cross-stack core closes it locally → spec 0012 proposed (2026-08-05)
- **`git filter-branch` on a detached HEAD rewrites the commit but leaves the branch ref behind** — `git branch -f main <new-head>` afterwards
- **`fixup` folds into the PREVIOUS `pick`** — grouping intent needs reordering in the rebase todo, not sed-in-place command edits; and **reordering breaks content dependencies** (a later commit's hunk can depend on an earlier commit's line — M10 squash: the skill-review suffix needs the manifest-gotcha line, moving it earlier conflicts). Safest: keep the original commit order and change only pick/fixup/reword commands — patches apply in original order, no conflicts (2026-08-05)
- **`reword` + `GIT_EDITOR` is unreliable here** — one editor call, message landed on the wrong commit. Fix messages with `git filter-branch -f --msg-filter` (stdin→stdout exact mapping, deterministic); it leaves `refs/original/` backup refs (2026-08-05)
- **A branch cut from an old milestone tip carries the already-merged commits** — plain `git rebase main` re-applies them and conflicts (M11: carried 3 old M10 commits). Use `git rebase --onto main <old-base>` to replay only the branch's own commits (2026-08-05)
- **Shallow clone (`--depth 1`) makes audit report `skeleton`** — the freshness/maturity signals need real history; clone full for demos
- **Zsh eats `$(...)` with nested quotes** ("bad substitution") — write verification scripts to a file and `bash` them

**pre-commit & commitlint**

- **commitlint was a dead gate for two days** — `.pre-commit-config.yaml` declaring it means nothing until `pre-commit install --hook-type commit-msg` runs (plain `install` only installs the pre-commit stage). Config ≠ enforcement (2026-08-04, spec 0001/0002 revisions)
- **commitlint hook has `pass_filenames: false`** — it reads `.git/COMMIT_EDITMSG`, so `--commit-msg-filename` on the CLI is ignored; write the message into `.git/COMMIT_EDITMSG` to test
- **`--hook-stage commit-msg` requires `--commit-msg-filename`** — pre-commit errors out without it (the CI commitlint step failed this way on first push)
- **Local hooks must declare `stages: [pre-commit]`** — undeclared hooks run in the commit-msg stage too, dragging typecheck (tsc) into the dependency-less CI job → TS2688 (2026-08-05)
- **`pre-commit run` refuses an unstaged config** — `git add .pre-commit-config.yaml` first
- **Commit header rules**: ≤100 chars, subject not starting uppercase (M7-style capitals fail `subject-case`), blank line before `Co-Authored-By`
- **Hook-ecosystem detection is about the ACTIVE form, not the dependency name** — a bare `husky` devDependency (no `.husky/`, no package.json `husky` field, yorkie without its field) is a dead dependency and must not skip the pre-commit gate install; yorkie (vue-cli default) was unrecognized and got a foreign pre-commit config installed over its hooks (2026-08-07)
- **Generated pre-commit hooks fetch their repos from GitHub at run time** — GitHub unreachable (no mirror/proxy) blocks every commit; the generated config header documents it (architecture, not a config bug) (2026-08-07)
- **cfg-hooks "installed" must mean the hook CONTENT references the tool** — file existence alone counts yorkie-installed hooks as pre-commit's own; and a bare "pre-commit" word in the content is not a marker either (yorkie/husky runner scripts pass the hook name as an argument — use the generated hook's own "generated by pre-commit") (2026-08-07)

**CI / GitHub Actions**

- **gitleaks-action fails on pull_request events without `pull-requests: read`** — it calls `GET /pulls/{n}/commits` (403 Resource not accessible); push events scan locally and stay green, so the failure only shows on PRs (2026-08-05)
- **A PR doubles the jobs** (push + pull_request events, each running both workflows: 9 → 18) — expected, keep both
- **CI pre-commit job has no node_modules** — local hooks are skipped there via `SKIP` (typecheck/tests run in the typecheck job, manifest in the ai-native hard gate)
- **Node workflow templates hard-coded `npm run lint`/`npm test`** — repos without those scripts failed "Missing script"; now declared-scripts-only (skip with a notice)

**Scripts / TypeScript / tests**

- **Tests rot on TOOL_VERSION bumps** if versions are hard-coded — import `TOOL_VERSION` instead (this caught the 0.2.3 bump)
- **`node --test` glob needs quoting** — `"skills/spooner/test/*.test.ts"` (npm script)
- **macOS has no `python` (only `python3`)**; Python 3.14's unittest exits 5 with no tests — mask it (`|| [ $? -eq 5 ]`)
- **`skills-ref` is not on the Aliyun pip mirror + PEP 668 blocks system pip** — use a venv with `--index-url https://pypi.org/simple`
- **Audit false positives, historically**: `hasCi` counted empty CI files (join of empty strings) — filter empties; `agents-sdd` matched hyphenated names like `sdd-app` — `\bSDD\b(?!-)` (2026-08-04)
- **detect only scans the repo root** — monorepo stacks in subdirs (`backend/requirements.txt`) are invisible; audit under-scores honestly, transform sees the root stack only (spec 0008 notes the boundary)
- **Entry guards must compare REAL paths** — `process.argv[1]` (absolutized but symlink-preserving) vs `fileURLToPath(import.meta.url)` (module loader resolves symlinks): strict string equality silently skips main() for any invocation through a symlinked path (exit 0, no output — user-found 2026-08-07). All six scripts delegate to `isDirectEntry(import.meta.url)` (scripts/entry.ts, realpath both sides); pinned by entry.test.ts (symlinked-dir + relative spawn)

**markdownlint / docs**

- **MD032: lists need blank lines around them** — spec drafts with tight lists fail lint; `npm run lint:md` before commit

## Technical constraints

- **TypeScript 6 only** (`^6.0.0`, major locked; not 7 — typescript-eslint and friends still require the 6.0 API until TS 7.1)
- **Zero build**: Node >= 22.18 runs `.ts` natively via type stripping; **erasable syntax only** — no `enum`, `namespace`, constructor parameter properties, or `import =` (Node throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX)
- Skill scripts are **zero-dependency** (Node builtins + git only); relative imports must carry the `.ts` extension
- **Version ledger**: dependency upgrades go through the local ledger (`docs/08`, not published) — update it and mention the upgrade in the commit; no opportunistic upgrades
- Repo docs are English-first; the internal archive (`docs/`, `HANDOFF.md`) is Chinese and local-only

## Red lines (re-check while developing)

- **Never merge to main or push on main without explicit user approval** — develop on feature branches; merges and pushes happen only when the user asks
- **Never delete branches on origin or clean up remote branches on your own** — remote cleanup (branch deletion, stale-ref removal) happens only when the user asks
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
| `specs/0002-m2-transform/spec.md` | M2 transform contract: stages 2-4, per-stage outputs, manifest model, acceptance |
| `specs/0003-m3-check/spec.md` | M3 check contract: baseline delta, drift report, suggestions, acceptance |
| `specs/0004-m4-sync/spec.md` | M4 sync contract: templateVersion extension, sync report schema, acceptance |
| `specs/0005-m5-drift-gate/spec.md` | M5 drift gate contract: CI hard gate job, baked-version rule, acceptance |
| `specs/0006-m6-multi-stack/spec.md` | M6 multi-stack contract: stack model, per-stack workflows/lifecycle, unsupported notice, acceptance |
| `specs/0008-m8-situational-transform/spec.md` | M8 situational-transform contract: context probe, CI-platform routing, mode table |
| `specs/0009-m9-badge/spec.md` | M9 badge contract: 5 shields styles, README style probe + decision chain, tier/color mapping, artifacts |
| `specs/0010-m10-contextual-gates/spec.md` | M10 contextual gates: generated stack-aware pre-commit config, hook-tool routing, generated sync class |
| `specs/0011-m11-rust-deep/spec.md` | M11 rust deep: cargo lifecycle + rust workflow + pre-commit gates + audit credit |
| `specs/0012-m12-manifest-gate-hook/spec.md` | M12 manifest gate: self-contained hook in the generated config, tool-owned marker rule, parity |
| `specs/0013-m13-report-truth-scoring/spec.md` | M13 report truth + quality scoring: 10-point scale, deterministic signals, two-sourced fixes |
| `skills/spooner/SKILL.md` | The distributable skill entry |
