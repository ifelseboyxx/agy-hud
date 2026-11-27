# Issue Tracker: Local Markdown

Issues and specs for this repo live under `.scratch/<feature-slug>/`.

## Layout & Conventions

- Feature directory: `.scratch/<feature-slug>/`
- Feature spec: `.scratch/<feature-slug>/spec.md`
- Implementation tickets: one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md` (`NN` zero-padded from `01`).
- Comments append to the bottom of the ticket under `## Comments`.
- **`Status:` value domains** (keep the two state machines distinct):
  - Implementation issues use the canonical triage labels in `docs/agents/triage-labels.md` while open/triaged, and transition to `resolved` once implemented, verified, and integrated.
  - `/wayfinder` child tickets use `claimed` or `resolved` (absent or empty `Status:` means open/unclaimed).

## Publishing and Fetching Tickets

- **Publish a spec**: write `.scratch/<feature-slug>/spec.md` (creating directories if needed).
- **Publish an issue / child ticket**: create `.scratch/<feature-slug>/issues/<NN>-<slug>.md` using the next sequential `NN` and include initial `Type:` and `Status:` header lines.
- **Fetch a ticket**: read the referenced path under `.scratch/<feature-slug>/` directly.

## Wayfinding Operations (`/wayfinder`)

- **Map**: `.scratch/<effort>/map.md` (Notes / Decisions-so-far / Fog).
- **Child ticket**: `.scratch/<effort>/issues/<NN>-<slug>.md` with `Type:` (`research` | `prototype` | `grilling` | `task`) and `Status:` (`claimed` | `resolved`).
- **Blocking**: `Blocked by: NN, NN` near the top; a ticket is unblocked once every listed ticket has `Status: resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for tickets that are unresolved, unclaimed (missing `Status:` or neither `claimed` nor `resolved`), and have all `Blocked by` tickets `resolved`; lowest `NN` wins.
- **Claim**: set `Status: claimed` and save before starting work.
- **Resolve**:
  1. Append the answer under `## Answer` and set `Status: resolved`.
  2. For parallel implementation tickets, record the first ready-for-review revision and timestamp, integration revision and timestamp, and verification result (plus duration when measured).
  3. Record any shared contract update or approved spec deviation in `.scratch/<feature-slug>/spec.md`, sync lasting contract/default changes to tracked docs, and append a gist + link pointer to `map.md`'s Decisions-so-far.
