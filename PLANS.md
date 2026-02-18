# Plans

## Why Plans Live in Repo
Plans are first-class artifacts. They make intent explicit, improve handoffs, and keep implementation decisions discoverable next to code.

## Plan Types
## Lightweight Plan (default for small changes)
Use for isolated fixes or narrow feature updates.

Template: `plans/templates/lightweight-plan.md`

## Execution Plan (required for complex/risky changes)
Use for multi-step work, refactors, migrations, cross-cutting reliability/security work, or changes spanning multiple modules.

Template: `plans/templates/execution-plan.md`

## Directory Layout
- `plans/templates/`: reusable plan templates.
- `plans/active/`: in-progress plans.
- `plans/completed/`: finalized plans tied to merged work.

## Status Conventions
- `proposed`: drafted but not started.
- `in_progress`: implementation underway.
- `blocked`: waiting on dependency/decision.
- `completed`: shipped and validated.

## Minimum Plan Quality Bar
- Clear goal and non-goals.
- Decision-complete implementation steps.
- Explicit risks/failure modes.
- Concrete validation commands and acceptance criteria.

## Process
1. Create a plan file from a template.
2. Keep decision logs updated as scope evolves.
3. Link plan in PR description.
4. Move plan from `plans/active/` to `plans/completed/` after merge.
