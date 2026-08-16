# specs/ — Spooner's SDD workflow

## Why SDD

Research (2026-08): SDD is a mainstream AI-collaboration workflow since 2025 (GitHub Spec Kit ~50k stars, AWS Kiro, OpenSpec), but heavy multi-stage pipelines are overkill for a single skill (Scott Logic measured ~10x overhead). Spooner uses a **lightweight spec-first** layer: one spec defines scope and acceptance criteria, implemented in independently verifiable slices.

Spooner's own product position is "adopting SDD workflows" — this directory is the first dogfood.

## Two layers

- **Planning layer**: `ROADMAP.md` — a four-tier index (🟢 current / 🟡 next / 🔵 vision / 💡 ideas); registration only, no content
- **Contract layer**: `specs/<nnn>-<name>.md` — only specs that can state "scope + acceptance criteria" live here; every file is flat (a template is `specs/spec-template.md`; if the SDD template pack ever grows to several templates, they move into a `specs/templates/` directory then)

An idea becomes a spec once it is concrete enough (scope + acceptance criteria writable); spec state changes are mirrored into ROADMAP. Numbers are **stable IDs** (incremental, never renumbered); stage is read from the frontmatter `status`, never encoded in the number.

## State transitions

`proposed` → `approved` → `in-progress` → `shipped`

| State       | Meaning                                               | Trigger               |
| ----------- | ----------------------------------------------------- | --------------------- |
| proposed    | Proposal: scope + acceptance criteria awaiting review | spec created          |
| approved    | Confirmed by the owner; implementation may start      | owner approval        |
| in-progress | Implementing; slices completed one by one             | implementation starts |
| shipped     | All acceptance criteria pass                          | acceptance            |

## Directory conventions

```text
specs/
├── README.md              # this file: workflow
├── ROADMAP.md             # planning index: current/next/vision/ideas
├── spec-template.md       # spec template
└── <nnn>-<name>.md        # contract layer: one flat spec file per feature (nnn = stable increment)
```

- Register or update ROADMAP whenever a spec is created, changed, or shipped (numbers stay stable; stage comes from `status`)
- A spec is a **living document**: it presents the current contract only — no acceptance logs, no fix history, no version-transition notes (those live in git commit messages; design decisions live in `docs/05`, local-only). Behavior changes update the spec **in place**; a new spec is for a new feature, never for a revision of an existing one
- Slice plans live inside the spec; every slice must be independently verifiable
- Changing frozen design: review the internal decision log (`docs/05`, local-only) first, then update `HANDOFF.md` (local)

## Relationship to docs/

- `docs/` (local-only, not published) = frozen design archive
- `specs/` = live work contracts — the source of truth for current development
- `HANDOFF.md` (local-only) = session handoff
