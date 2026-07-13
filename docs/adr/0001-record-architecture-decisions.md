# 0001 — Record architecture decisions in docs/adr/

Status: accepted · Date: 2026-07-13

## Context

Through v0.3 every architecture decision lived in the numbered table in
[DESIGN.md](../DESIGN.md) (D1–D15) plus milestone notes. That format is
excellent as a founding record but scales poorly: table cells have grown to
paragraph length, decisions made *after* the founding design (e.g. the GUI
kernel-lifecycle model, hammered out across six review rounds) have no home
with room for context and consequences, and the repo is now maintained by
multiple AI agents that need decisions findable and citable.

## Decision

- New architecture decisions get one file each: `docs/adr/NNNN-slug.md`,
  sections **Context → Decision → Consequences**, a Status line
  (`accepted | superseded by NNNN`), and a date. Keep them short; link to
  code and other docs instead of restating them.
- DESIGN.md's table D1–D15 is the immutable founding record. Cite those
  decisions as D1…D15; do not migrate or renumber them. If a founding
  decision is revisited, write a new ADR that references the D-number.
- What deserves an ADR: anything a future maintainer would ask "why is it
  like this?" about — package boundaries, protocol surface, lifecycle
  policies, trade-offs with rejected alternatives. Bug fixes and refactors
  that don't change a boundary or policy do not.
- The docs-with-features rule ([AGENTS.md](../../AGENTS.md)) names when an
  ADR is required in a PR.

## Consequences

- Decisions become individually linkable from code comments, PR
  dispositions, and [ARCHITECTURE.md](../ARCHITECTURE.md).
- Two places to look (D-table for the founding design, adr/ for everything
  since) — accepted; the split matches how the project actually evolved.
