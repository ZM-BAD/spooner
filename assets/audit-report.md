# AI-Readiness Report

- Stack: node · Maturity: stable · Score: **18/20**

## Score by category

| Category | Score | Max |
|---|---|---|
| Agent Setup | 6 | 6 |
| Configuration | 4 | 5 |
| Integrity | 4 | 4 |
| Freshness | 3 | 3 |
| Structure | 1 | 2 |

## Gaps

| Check | Score | Evidence | Fix |
|---|---|---|---|
| cfg-format | 0/1 | formatter config: missing, command: missing | transform Stage 2 |
| struct-layout | 0/1 | no src/, lib/, or packages/ directory | organize sources under src/, lib/, or packages/ |

## Suggestions

- Run transform Stage 2 to install lint/format/CI gates (warn-only; keep the existing build green).
- Add a README with real content and organize sources under src/, lib/, or packages/.
