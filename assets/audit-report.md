# AI-Readiness Report

- Stack: node · Maturity: stable · Score: **9.4/10**

## Score by category

| Category | Score | Max |
|---|---|---|
| Agent Setup | 3 | 3 |
| Configuration | 2.4 | 2.5 |
| Integrity | 2 | 2 |
| Freshness | 1.5 | 1.5 |
| Structure | 0.5 | 1 |

## Gaps

| Check | Score | Evidence | Fix |
|---|---|---|---|
| cfg-format | 0.4/0.5 | .prettierrc + format | transform Stage 2 (CI format job) |
| struct-layout | 0/0.5 | no src/, lib/, or packages/ directory | organize sources under src/, lib/, or packages/ (not covered by transform) |

## Suggestions

- Configuration: transform Stage 2 (CI format job)
- Structure: organize sources under src/, lib/, or packages/ (not covered by transform)
