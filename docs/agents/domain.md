# Domain Docs

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root for canonical domain vocabulary.
- **`docs/adr/`** (when present) for architectural decisions touching the area under change.

When `docs/adr/` is absent, continue the current task; create ADRs or update `GLOSSARY.md` lazily via `/domain-modeling` once a term or decision resolves.

## Layout

Single-context repository layout:

```text
/
├── GLOSSARY.md
├── docs/adr/        (created lazily)
└── src/
```

## Vocabulary and ADR discipline

- Use the canonical terms from `GLOSSARY.md` verbatim in issue titles, proposals, hypotheses, and test names; avoid every listed `_Avoid_` synonym.
- When a required concept is missing from `GLOSSARY.md`, check whether an existing term fits or note the gap for `/domain-modeling`.
- Surface any contradiction with an existing ADR explicitly:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because..._
