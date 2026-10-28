# Project workflows

The authoritative operator instructions are the bundled [manager skill](../skills/agenlink-manager/SKILL.md), [manager runbook](../skills/agenlink-manager/references/AGENTS.md), [worker CLI guide](../skills/agenlink-manager/references/worker-cli.md), [intake template](../skills/agenlink-manager/references/intake-template.md) and [coverage guide](../skills/agenlink-manager/references/coverage-guide.md).

Native records use the packaged YAML schemas under `schemas/DevProjects/schema/` unchanged. Workspace records live under `registry/DevProjects/metadata/`; archived projects retain their keys, short IDs, events and evidence. Commands are `agentlink project`, `agentlink workers`, `agentlink workflow` and `agentlink work`.

Compilation validates TypeScript interfaces. It does not prove native-provider connectivity, actual worker acknowledgement, meaningful measurement, independent acceptance or a completed project. Report these only when observed in an authorized workspace.

### Recorded project budgets

The original `configuration` fields control project and per-AC token ceilings,
per-AC warning thresholds, and turn/AC/project time budgets. Explicit AC token
extensions retain their cumulative usage and take precedence over the project
per-AC default. A null configuration value is unset; records without configuration
retain the existing 400k warning and 600k ceiling policy.

Managed experiment command sequences share the earliest applicable deadline and
are stopped by the runner at that deadline. AC/project wall-clock time starts at
the earliest recorded in-progress status; holds do not reset it. Native turn
boundaries supply the remaining turn time when available. The scheduler requests
checkpoint/wrap-up once per budget issue and stops automatic recovery at the
controlling budget; explicit holds retain priority. Provider sessions themselves
receive cooperative checkpoint instructions, not forced termination. Missing
native turn boundaries cannot establish a session-level elapsed-turn deadline;
the runner still enforces the configured maximum action duration. Reviews must
fit recorded limits, and completed records/reports remain publishable.
